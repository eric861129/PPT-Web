import Foundation

/// 把網頁和 PowerPoint 接起來：定期看 PowerPoint 的狀態，有變才送給網頁；網頁送來的指令交給 PowerPoint
final class Bridge {
    static let version = 1
    static let pollInterval = 0.25

    private let log: LogWindow
    private let server: BridgeServer
    private let powerpoint = PowerPoint()
    private let thumbnails = Thumbnails()
    private var timer: Timer?
    private var connected = false
    private var lastKey: String?
    private var lastSnapshot: Snapshot?
    private var lastTitle = ""
    /// 讀投影片失敗時，等一下再重讀，不要每次看狀態都重來
    private var deckRetryAt = Date.distantPast
    /// 已經顯示過的錯誤，同樣的問題只說一次
    private var reported: Set<String> = []

    init(log: LogWindow) {
        self.log = log
        let env = ProcessInfo.processInfo.environment
        let port = env["PPTWEB_BRIDGE_PORT"].flatMap { UInt16($0) } ?? 48210
        var origins = ["https://huangchiyu.com", "https://eric861129.github.io"]
        if let extra = env["PPTWEB_BRIDGE_ORIGINS"] {
            origins += extra.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        server = BridgeServer(port: port) { origin in
            origins.contains(origin)
                || origin.range(of: #"^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$"#, options: .regularExpression) != nil
        }
    }

    func start() {
        log.banner("")
        log.banner("  PPT-Web PowerPoint 橋接程式（Mac 版）")
        log.banner("  ---------------------------------------------")
        log.banner("  1. 保持這個視窗開著（可以縮到 Dock）")
        log.banner("  2. 用 PowerPoint 打開你的簡報")
        log.banner("  3. 用 Chrome、Edge 或 Firefox 打開 https://huangchiyu.com/PPT-Web/")
        log.banner("     選「用 PowerPoint 放映」（Safari 連不到這個程式）")
        log.banner("  第一次連上時 macOS 會問是否允許控制「Microsoft PowerPoint」，請選「好」。")
        log.banner("  要結束時直接關掉這個視窗，或按 ⌘Q。")
        log.banner("")

        powerpoint.log = { [weak self] line, tone in self?.log.status(line, tone) }
        thumbnails.log = powerpoint.log
        thumbnails.deliver = { [weak self] slide, jpeg in
            self?.server.send(["type": "thumb", "slide": slide, "jpeg": orNull(jpeg)])
        }

        let port = server.port
        server.onListening = { [weak self] in self?.log.status("等待網頁連線（127.0.0.1:\(port)）…") }
        server.onFailure = { [weak self] message in
            self?.log.status("無法使用連接埠 \(port)：\(message)", .bad)
            self?.log.status("可能已經有一個橋接程式在執行了。", .bad)
        }
        server.onReject = { [weak self] origin in
            self?.log.status("拒絕來自 \(origin.isEmpty ? "不明來源" : origin) 的連線（不是 PPT-Web 網站）", .warn)
        }
        server.onConnect = { [weak self] origin in self?.connect(origin) }
        server.onDisconnect = { [weak self] in self?.disconnect() }
        server.onMessage = { [weak self] message in self?.receive(message) }
        server.start()

        let timer = Timer(timeInterval: Self.pollInterval, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        server.stop()
    }

    private func connect(_ origin: String) {
        connected = true
        lastKey = nil
        lastSnapshot = nil
        lastTitle = ""
        reported = []
        thumbnails.reset(slides: [])
        log.status("網頁已連線（\(origin)）", .good)
        server.send(["type": "hello", "app": "ppt-web-bridge", "version": Self.version])
        poll()
    }

    private func disconnect() {
        connected = false
        thumbnails.reset(slides: [])
        log.status("網頁已中斷連線", .warn)
    }

    /// 看 PowerPoint 的狀態，有變才送；剛執行完指令時立刻看
    private func poll() {
        // PowerPoint 存 PDF 時不太理 Apple 事件，這時去問只會卡住
        guard connected, !thumbnails.isExporting else { return }
        let reading: Reading
        switch powerpoint.read() {
        case .success(let value): reading = value
        case .failure(let error): return report(error)
        }
        if reading.key != lastKey, Date() >= deckRetryAt {
            sendDeck(reading)
        }
        if reading.snapshot != lastSnapshot {
            lastSnapshot = reading.snapshot
            server.send(["type": "state", "state": reading.snapshot.json])
        }
    }

    private func sendDeck(_ reading: Reading) {
        var deck: Deck?
        if reading.snapshot.presentation {
            switch powerpoint.readDeck() {
            case .success(let value):
                deck = value
            case .failure(let error):
                report(error)
                deckRetryAt = Date().addingTimeInterval(2)
                return
            }
        }
        lastKey = reading.key
        thumbnails.reset(slides: deck?.slides ?? [])
        server.send(["type": "deck", "deck": orNull(deck?.json)])
        let title = deck?.title ?? ""
        guard title != lastTitle else { return }
        lastTitle = title
        if let deck = deck {
            log.status("PowerPoint 已開啟「\(deck.title)」，共 \(deck.slides.count) 張投影片", .info)
        } else {
            log.status("等待 PowerPoint 開啟簡報…")
        }
    }

    private func receive(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "command":
            guard let command = message["command"] as? [String: Any] else { return }
            if let error = powerpoint.perform(command) {
                report(error)
                server.send(["type": "error", "message": error.message])
            }
            poll()
        case "thumb":
            guard let slide = (message["slide"] as? NSNumber)?.intValue else { return }
            thumbnails.request(slide: slide, width: (message["width"] as? NSNumber)?.intValue ?? 1280)
        case "refresh":
            lastKey = nil
        default:
            break
        }
    }

    private func report(_ error: ScriptError) {
        if error.appGone { return }
        let line: String
        if error.notAuthorized {
            line = "沒有權限控制 PowerPoint。請到「系統設定 → 隱私權與安全性 → 自動化」，允許「PPT-Web Bridge」控制「Microsoft PowerPoint」，再重新整理網頁。"
        } else if error.timedOut {
            line = "PowerPoint 沒有回應：可能開著對話框，或 macOS 正在詢問是否允許控制 PowerPoint。"
        } else {
            line = "PowerPoint 回報錯誤：\(error.message)（\(error.number)）"
        }
        guard reported.insert(line).inserted else { return }
        log.status(line, error.notAuthorized ? .bad : .warn)
    }
}
