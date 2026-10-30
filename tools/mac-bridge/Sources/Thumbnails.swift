import CoreGraphics
import Foundation
import ImageIO

/// 投影片縮圖。PowerPoint 的 AppleScript 沒辦法匯出單張投影片，所以第一次需要時請它把整份簡報存成 PDF，
/// 之後每張縮圖都從這份 PDF 畫出來。PowerPoint 在沙盒裡，PDF 只能存在它自己的資料夾。
final class Thumbnails {
    var log: (String, Tone) -> Void = { _, _ in }
    /// 縮圖好了時呼叫，參數是 SlideIndex 和 base64 的 JPEG；失敗時 JPEG 是 nil
    var deliver: (Int, String?) -> Void = { _, _ in }

    private var slides: [Slide] = []
    private var document: CGPDFDocument?
    /// SlideIndex → PDF 頁碼
    private var pages: [Int: Int] = [:]
    private var waiting: [(slide: Int, width: Int)] = []
    private var export: Process?
    /// 匯出失敗後先別一直重試，網站之後還會再要
    private var failedUntil = Date.distantPast
    /// 換一份簡報就加一，匯出到一半換了簡報時，舊的結果不能用
    private var generation = 0
    private let renderQueue = DispatchQueue(label: "ppt-web-bridge.thumbnails")

    /// PowerPoint 正在存 PDF；這段時間它不太理 Apple 事件
    var isExporting: Bool { export != nil }

    /// 換了簡報（或網頁斷線）：丟掉舊的 PDF，還在等的縮圖都回失敗
    func reset(slides: [Slide]) {
        generation += 1
        self.slides = slides
        document = nil
        pages = [:]
        failedUntil = .distantPast
        let requests = waiting
        waiting = []
        for request in requests { deliver(request.slide, nil) }
    }

    func request(slide: Int, width: Int) {
        let width = min(1280, max(64, width))
        if let document = document, let page = pages[slide] {
            render(document, page: page, slide: slide, width: width)
        } else if document != nil || Date() < failedUntil || !slides.contains(where: { $0.index == slide }) {
            deliver(slide, nil)
        } else {
            waiting.append((slide: slide, width: width))
            startExport()
        }
    }

    private func startExport() {
        guard export == nil else { return }
        let file = exportFolder().appendingPathComponent("ppt-web-bridge-\(UUID().uuidString).pdf")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = PowerPoint.exportSource.split(separator: "\n").flatMap { ["-e", String($0)] } + [file.path]
        let errors = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        let generation = self.generation
        process.terminationHandler = { process in
            let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let status = process.terminationStatus
            DispatchQueue.main.async {
                self.finishExport(file: file, status: status, message: message, generation: generation)
            }
        }
        do {
            try process.run()
            export = process
            log("正在請 PowerPoint 匯出投影片縮圖…", .plain)
        } catch {
            log("無法執行 osascript：\(error.localizedDescription)", .bad)
            fail()
        }
    }

    private func finishExport(file: URL, status: Int32, message: String, generation: Int) {
        export = nil
        var data: Data?
        var readError = ""
        if status == 0 {
            do { data = try Data(contentsOf: file) } catch { readError = error.localizedDescription }
        }
        try? FileManager.default.removeItem(at: file)

        guard generation == self.generation else {
            // 匯出期間換了簡報，這份不能用；有人在等新簡報的縮圖就重新匯出
            if !waiting.isEmpty { startExport() }
            return
        }
        guard status == 0 else {
            log("PowerPoint 無法匯出縮圖：\(message.trimmingCharacters(in: .whitespacesAndNewlines))", .warn)
            return fail()
        }
        guard let pdf = data, let provider = CGDataProvider(data: pdf as CFData), let document = CGPDFDocument(provider) else {
            log("讀不到 PowerPoint 匯出的 PDF（\(readError)）。如果 macOS 問是否允許取用其他 App 的資料，請選「允許」。", .warn)
            return fail()
        }
        guard let pages = pageMap(pageCount: document.numberOfPages) else {
            let visible = slides.filter { !$0.hidden }.count
            log("匯出的 PDF 有 \(document.numberOfPages) 頁，對不上簡報的 \(slides.count) 張投影片（\(visible) 張會放映），先不顯示縮圖。", .warn)
            return fail()
        }
        self.document = document
        self.pages = pages
        log("投影片縮圖準備好了（\(document.numberOfPages) 頁）", .plain)
        let requests = waiting
        waiting = []
        for request in requests { self.request(slide: request.slide, width: request.width) }
    }

    private func fail() {
        failedUntil = Date().addingTimeInterval(30)
        let requests = waiting
        waiting = []
        for request in requests { deliver(request.slide, nil) }
    }

    /// PDF 的頁對應到投影片。PowerPoint 匯出 PDF 通常不含隱藏投影片，但也可能含
    private func pageMap(pageCount: Int) -> [Int: Int]? {
        let visible = slides.filter { !$0.hidden }.map { $0.index }
        let indexes: [Int]
        if pageCount == slides.count {
            indexes = slides.map { $0.index }
        } else if pageCount == visible.count {
            indexes = visible
        } else {
            return nil
        }
        return Dictionary(uniqueKeysWithValues: indexes.enumerated().map { pair in (pair.element, pair.offset + 1) })
    }

    private func exportFolder() -> URL {
        let data = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Containers/com.microsoft.Powerpoint/Data", isDirectory: true)
        let tmp = data.appendingPathComponent("tmp", isDirectory: true)
        return FileManager.default.fileExists(atPath: tmp.path) ? tmp : data
    }

    private func render(_ document: CGPDFDocument, page: Int, slide: Int, width: Int) {
        renderQueue.async {
            let jpeg = Self.jpeg(document, page: page, width: width)?.base64EncodedString()
            DispatchQueue.main.async { self.deliver(slide, jpeg) }
        }
    }

    private static func jpeg(_ document: CGPDFDocument, page number: Int, width: Int) -> Data? {
        guard let page = document.page(at: number) else { return nil }
        let box = page.getBoxRect(.cropBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = CGFloat(width) / box.width
        let height = max(1, Int((box.height * scale).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -box.minX, y: -box.minY)
        context.drawPDFPage(page)
        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
