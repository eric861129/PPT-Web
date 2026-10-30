import AppKit

struct Slide {
    /// PowerPoint 的 SlideIndex，從 1 起算，包含隱藏投影片
    var index: Int
    var hidden: Bool
    var title: String
    var notes: [String]
}

struct Deck {
    var title: String
    var aspect: Double
    var slides: [Slide]

    /// 跟網站的 BridgeDeck 一樣。AppleScript 讀不到備忘稿的縮排層級，一律當第 0 層
    var json: [String: Any] {
        [
            "title": title,
            "aspect": aspect,
            "slides": slides.map { slide -> [String: Any] in
                [
                    "index": slide.index,
                    "hidden": slide.hidden,
                    "title": slide.title,
                    "notes": slide.notes.map { text -> [String: Any] in ["text": text, "level": 0] },
                ]
            },
        ]
    }
}

/// 跟網站的 BridgeState 一樣。AppleScript 讀不到動畫步驟，clickIndex、clickCount 一律是 0，
/// 網站就不顯示「動畫 x / y」
struct Snapshot: Equatable {
    var powerpoint = false
    var presentation = false
    var running = false
    var slide: Int?
    /// 放映中的 ppSlideShowState（1 放映、2 暫停、3 黑幕、4 白幕、5 放映結束）；沒在放映是 nil
    var view: Int?

    var json: [String: Any] {
        [
            "powerpoint": powerpoint,
            "presentation": presentation,
            "running": running,
            "slide": orNull(slide),
            "view": orNull(view),
            "clickIndex": 0,
            "clickCount": 0,
        ]
    }
}

struct Reading {
    var snapshot = Snapshot()
    /// 「現在是哪份簡報」，變了就要重新讀投影片和備忘稿
    var key = ""
}

func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
}

struct ScriptError: Error {
    var number: Int
    var message: String

    init(number: Int, message: String) {
        self.number = number
        self.message = message
    }

    init(_ info: NSDictionary) {
        number = (info["NSAppleScriptErrorNumber"] as? NSNumber)?.intValue ?? 0
        message = info["NSAppleScriptErrorMessage"] as? String ?? "未知的錯誤"
    }

    /// 使用者沒有允許這個程式控制 PowerPoint（系統設定的「自動化」）
    var notAuthorized: Bool { number == -1743 }
    /// PowerPoint 沒有回應，通常是開著對話框
    var timedOut: Bool { number == -1712 }
    /// PowerPoint 剛好關掉了
    var appGone: Bool { number == -600 || number == -609 }
}

/// 用 AppleScript 控制 PowerPoint。NSAppleScript 只能在主執行緒用，所以全部在主執行緒跑；
/// 每段腳本都設了逾時，PowerPoint 開著對話框不回應時不會卡太久。
///
/// PowerPoint 每一版的 AppleScript 字典不太一樣，字典裡沒有的詞會讓整段腳本無法編譯，
/// 所以讀狀態、讀簡報都準備了退一步的寫法，用不到的功能就略過，並在視窗上說明。
final class PowerPoint {
    static let bundleID = "com.microsoft.powerpoint"

    var log: (String, Tone) -> Void = { _, _ in }

    private var scripts: [String: (script: NSAppleScript, variant: Int)] = [:]
    private var unusable: Set<String> = []
    private var warned: Set<String> = []

    var isRunning: Bool {
        NSWorkspace.shared.runningApplications.contains {
            !$0.isTerminated && $0.bundleIdentifier?.lowercased() == Self.bundleID
        }
    }

    /// 讀得到、設得了黑幕白幕（讀狀態的腳本用的是第一種寫法）
    private var blankSupported: Bool { scripts["state"].map { $0.variant == 0 } ?? true }

    // ---------- 讀狀態 ----------

    func read() -> Result<Reading, ScriptError> {
        guard isRunning else { return .success(Reading()) }
        return run("state", [Self.stateSource(withBlank: true), Self.stateSource(withBlank: false)]).map { result -> Reading in
            let text = result.stringValue ?? ""
            if text == "closed" { return Reading() }
            var reading = Reading(snapshot: Snapshot(powerpoint: true))
            let parts = text.split(separator: "\t", maxSplits: 4, omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 5 else { return reading }
            let showing = parts[0] == "1"
            let slide = Int(parts[1]) ?? 0
            reading.snapshot.presentation = true
            reading.snapshot.running = showing
            reading.snapshot.slide = slide > 0 ? slide : nil
            reading.snapshot.view = showing ? Int(parts[2]) : nil
            reading.key = "\(parts[4])|\(parts[3])"
            return reading
        }
    }

    func readDeck() -> Result<Deck, ScriptError> {
        let result: NSAppleEventDescriptor
        switch run("deck", [Self.deckSource(byPlaceholderType: true), Self.deckSource(byPlaceholderType: false)]) {
        case .success(let value): result = value
        case .failure(let error): return .failure(error)
        }
        var slides: [Slide] = []
        if let rows = result.atIndex(2), rows.numberOfItems > 0 {
            for i in 1...rows.numberOfItems {
                let row = rows.atIndex(i)
                slides.append(Slide(
                    index: i,
                    hidden: false,
                    title: oneLine(row?.atIndex(1)?.stringValue ?? ""),
                    notes: paragraphs(row?.atIndex(2)?.stringValue ?? "")))
            }
        }

        switch run("hidden", [Self.hiddenSource]) {
        case .success(let flags) where flags.numberOfItems == slides.count:
            for i in slides.indices { slides[i].hidden = flags.atIndex(i + 1)?.int32Value == 1 }
        case .success:
            break
        case .failure(let error):
            warnOnce("讀不到哪些是隱藏投影片（\(error.message)），全部當成會放映。")
        }

        var aspect = 16.0 / 9.0
        switch run("aspect", [Self.aspectSource]) {
        case .success(let size):
            let width = size.atIndex(1)?.doubleValue ?? 0
            let height = size.atIndex(2)?.doubleValue ?? 0
            if width > 0, height > 0 { aspect = width / height }
        case .failure(let error):
            warnOnce("讀不到投影片的長寬（\(error.message)），先當成 16:9。")
        }

        let name = result.atIndex(1)?.stringValue ?? ""
        return .success(Deck(title: (name as NSString).deletingPathExtension, aspect: aspect, slides: slides))
    }

    // ---------- 指令 ----------

    /// 執行網站送來的指令（src/powerpoint/protocol.ts 的 BridgeCommand）
    func perform(_ command: [String: Any]) -> ScriptError? {
        guard isRunning, let source = commandSource(command) else { return nil }
        let script: NSAppleScript
        switch compile(source) {
        case .success(let value): script = value
        case .failure(let error): return error
        }
        guard case .failure(let error) = execute(script) else { return nil }
        // PowerPoint 忙碌時會拒絕呼叫，稍等一下再試一次
        guard !error.notAuthorized, !error.timedOut, !error.appGone else { return error }
        usleep(150_000)
        if case .failure(let error) = execute(script) { return error }
        return nil
    }

    private func commandSource(_ command: [String: Any]) -> String? {
        let type = command["type"] as? String ?? ""
        let slide = (command["slide"] as? NSNumber)?.intValue ?? 1
        let mode = command["mode"] as? String ?? ""
        var show = ""  // 放映中
        var edit = ""  // 還沒放映
        switch type {
        case "next", "prev":
            let step = type == "next" ? "go to next slide v" : "go to previous slide v"
            // 跟網站的放映模式一樣：黑幕時按翻頁只會先回到畫面
            show = blankSupported ? """
                set st to slide state of v
                if st is slide show state black screen or st is slide show state white screen then
                set slide state of v to slide show state running
                else
                \(step)
                end if
                """ : step
            edit = Self.selectSource(type == "next" ? "here + 1" : "here - 1")
        case "first":
            show = "go to first slide v"
            edit = Self.selectSource("1")
        case "last":
            show = "go to last slide v"
            edit = Self.selectSource("slideTotal")
        case "gotoSlide":
            show = Self.goToSource(slide)
            edit = Self.selectSource(String(slide))
        case "blank":
            guard blankSupported, let state = Self.blankStates[mode] else { return nil }
            show = "set slide state of v to \(state)"
        case "toggleBlank":
            guard blankSupported, let target = Self.blankStates[mode == "white" ? "white" : "black"] else { return nil }
            show = """
                if slide state of v is \(target) then
                set slide state of v to slide show state running
                else
                set slide state of v to \(target)
                end if
                """
        case "end":
            show = "exit slide show v"
        case "start":
            var lines = [Self.currentPresentation, "run slide show (slide show settings of p)"]
            if slide > 1 {
                lines += [
                    "repeat 50 times",
                    "if (count of slide show windows) > 0 then exit repeat",
                    "delay 0.1",
                    "end repeat",
                    "set v to slide show view of slide show window 1",
                    Self.goToSource(slide),
                ]
            }
            edit = lines.joined(separator: "\n")
        default:
            return nil
        }
        if show.isEmpty && edit.isEmpty { return nil }
        return """
            with timeout of 30 seconds
            tell application "Microsoft PowerPoint"
            if (count of slide show windows) > 0 then
            set v to slide show view of slide show window 1
            \(show)
            else
            \(edit)
            end if
            end tell
            end timeout
            """
    }

    // ---------- 執行 AppleScript ----------

    /// 執行固定的腳本：第一次用到時編譯，之後重複用。variants 是同一件事的幾種寫法，
    /// 前面的寫法編譯失敗（這版 PowerPoint 的字典沒有某個詞）就改用下一種
    private func run(_ name: String, _ variants: [String]) -> Result<NSAppleEventDescriptor, ScriptError> {
        if scripts[name] == nil {
            if unusable.contains(name) {
                return .failure(ScriptError(number: -2741, message: "這個版本的 PowerPoint 不支援「\(name)」"))
            }
            for (i, source) in variants.enumerated() {
                switch compile(source) {
                case .success(let script):
                    scripts[name] = (script, i)
                case .failure(let error):
                    log("AppleScript「\(name)」第 \(i + 1) 種寫法無法編譯：\(error.message)", .warn)
                }
                if scripts[name] != nil { break }
            }
            guard scripts[name] != nil else {
                unusable.insert(name)
                return .failure(ScriptError(number: -2741, message: "這個版本的 PowerPoint 不支援「\(name)」"))
            }
        }
        return execute(scripts[name]!.script)
    }

    private func compile(_ source: String) -> Result<NSAppleScript, ScriptError> {
        guard let script = NSAppleScript(source: source) else {
            return .failure(ScriptError(number: 0, message: "無法建立 AppleScript"))
        }
        var info: NSDictionary?
        guard script.compileAndReturnError(&info) else {
            return .failure(info.map { ScriptError($0) } ?? ScriptError(number: 0, message: "無法編譯 AppleScript"))
        }
        return .success(script)
    }

    private func execute(_ script: NSAppleScript) -> Result<NSAppleEventDescriptor, ScriptError> {
        var info: NSDictionary?
        let result = script.executeAndReturnError(&info)
        if let info = info { return .failure(ScriptError(info)) }
        return .success(result)
    }

    private func warnOnce(_ message: String) {
        guard warned.insert(message).inserted else { return }
        log(message, .warn)
    }

    // ---------- AppleScript 原始碼 ----------
    // 變數名稱刻意避開 PowerPoint 字典裡的詞（例如 rows、view），不然會被當成 PowerPoint 的屬性

    /// 放映中就是放映的那份，不然是最前面的那份（跟 Windows 版的 Get-CurrentPresentation 一樣）
    static let currentPresentation = """
        if (count of slide show windows) > 0 then
        set p to presentation of slide show window 1
        else
        set p to missing value
        try
        set p to active presentation
        end try
        if p is missing value then set p to presentation 1
        end if
        """

    static let blankStates = [
        "off": "slide show state running",
        "black": "slide show state black screen",
        "white": "slide show state white screen",
    ]

    /// 回傳「是否放映中、目前投影片、放映狀態、投影片數、簡報路徑」，用 tab 隔開
    static func stateSource(withBlank: Bool) -> String {
        let readState = withBlank ? """
            set st to slide state of v
            if st is slide show state black screen then
            set stateNum to 3
            else if st is slide show state white screen then
            set stateNum to 4
            else if st is slide show state done then
            set stateNum to 5
            else if st is slide show state paused then
            set stateNum to 2
            else
            set stateNum to 1
            end if
            """ : "set stateNum to 1"
        return """
            if application "Microsoft PowerPoint" is not running then return "closed"
            with timeout of 3 seconds
            tell application "Microsoft PowerPoint"
            set slideNum to 0
            if (count of slide show windows) > 0 then
            set isShowing to 1
            set p to presentation of slide show window 1
            set v to slide show view of slide show window 1
            \(readState)
            if stateNum is not 5 then
            try
            set slideNum to slide index of slide of v
            end try
            end if
            else
            set isShowing to 0
            set stateNum to 0
            if (count of presentations) is 0 then return "none"
            \(currentPresentation)
            try
            set slideNum to slide index of slide range of selection of document window 1
            end try
            end if
            set theKey to ""
            try
            set theKey to full name of p
            end try
            if theKey is missing value or theKey is "" then set theKey to name of p
            set slideCount to count of slides of p
            end tell
            end timeout
            return (isShowing as text) & tab & (slideNum as text) & tab & (stateNum as text) & tab & (slideCount as text) & tab & (theKey as text)
            """
    }

    /// 回傳 {簡報名稱, {{標題, 備忘稿}, …}}
    static func deckSource(byPlaceholderType: Bool) -> String {
        let readTitle = byPlaceholderType ? """
            repeat with phRef in (get place holders of s)
            set ph to contents of phRef
            set phType to placeholder type of ph
            if phType is placeholder type title placeholder or phType is placeholder type center title placeholder then
            set theTitle to content of text range of text frame of ph
            exit repeat
            end if
            end repeat
            """ : "set theTitle to content of text range of text frame of place holder 1 of s"
        let readNotes = byPlaceholderType ? """
            set foundNotes to false
            repeat with phRef in (get place holders of notes page of s)
            set ph to contents of phRef
            if placeholder type of ph is placeholder type body placeholder then
            set theNotes to content of text range of text frame of ph
            set foundNotes to true
            exit repeat
            end if
            end repeat
            if not foundNotes then set theNotes to content of text range of text frame of place holder 2 of notes page of s
            """ : "set theNotes to content of text range of text frame of place holder 2 of notes page of s"
        return """
            with timeout of 60 seconds
            tell application "Microsoft PowerPoint"
            \(currentPresentation)
            set deckRows to {}
            repeat with i from 1 to (count of slides of p)
            set s to slide i of p
            set theTitle to ""
            set theNotes to ""
            try
            \(readTitle)
            end try
            try
            \(readNotes)
            end try
            if theTitle is missing value then set theTitle to ""
            if theNotes is missing value then set theNotes to ""
            set end of deckRows to {theTitle as text, theNotes as text}
            end repeat
            return {(name of p) as text, deckRows}
            end tell
            end timeout
            """
    }

    /// 回傳每張投影片是否隱藏（1 或 0）
    static let hiddenSource = """
        with timeout of 30 seconds
        tell application "Microsoft PowerPoint"
        \(currentPresentation)
        set hiddenFlags to {}
        repeat with i from 1 to (count of slides of p)
        set h to 0
        try
        if hidden of slide show transition of slide i of p then set h to 1
        end try
        set end of hiddenFlags to h
        end repeat
        return hiddenFlags
        end tell
        end timeout
        """

    static let aspectSource = """
        with timeout of 10 seconds
        tell application "Microsoft PowerPoint"
        \(currentPresentation)
        return {slide width of page setup of p, slide height of page setup of p}
        end tell
        end timeout
        """

    /// 還沒放映時，翻頁就移動 PowerPoint 編輯畫面裡選到的投影片
    static func selectSource(_ goal: String) -> String {
        """
        \(currentPresentation)
        set slideTotal to count of slides of p
        set here to 1
        try
        set here to slide index of slide range of selection of document window 1
        end try
        set goal to \(goal)
        if goal < 1 then set goal to 1
        if goal > slideTotal then set goal to slideTotal
        try
        go to slide (view of document window 1) number goal
        end try
        """
    }

    /// 放映中跳到第 n 張。有些版本的 go to slide 會回參數錯誤（-50），那就一步一步翻過去
    static func goToSource(_ n: Int) -> String {
        """
        set goal to \(n)
        set arrived to false
        try
        go to slide v number goal
        set arrived to ((slide index of slide of v) is goal)
        end try
        if not arrived then
        try
        set lastStep to 0
        repeat 500 times
        set here to slide index of slide of v
        if here is goal then exit repeat
        if here < goal then
        if lastStep is -1 then exit repeat
        set lastStep to 1
        go to next slide v
        else
        if lastStep is 1 then exit repeat
        set lastStep to -1
        go to previous slide v
        end if
        end repeat
        end try
        end if
        """
    }

    /// 由 osascript 在背景執行（存 PDF 要好幾秒，不能卡住主執行緒）；參數是 PDF 的路徑
    static let exportSource = """
        on run argv
        set outPath to (POSIX file (item 1 of argv)) as text
        with timeout of 300 seconds
        tell application "Microsoft PowerPoint"
        \(currentPresentation)
        save p in outPath as save as PDF
        end tell
        end timeout
        end run
        """
}

/// PowerPoint 的段落用 \r 分開，段落裡的換行（Shift+Return）是 \v
func paragraphs(_ text: String) -> [String] {
    let breaks: Set<Character> = ["\r", "\n", "\r\n", "\u{2029}"]
    return text.split(omittingEmptySubsequences: false, whereSeparator: { breaks.contains($0) }).map {
        $0.replacingOccurrences(of: "\u{0B}", with: "\n").replacingOccurrences(of: "\u{2028}", with: "\n")
    }
}

func oneLine(_ text: String) -> String {
    text.components(separatedBy: CharacterSet(charactersIn: "\r\n\u{0B}\u{2028}\u{2029}"))
        .filter { !$0.isEmpty }
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespaces)
}
