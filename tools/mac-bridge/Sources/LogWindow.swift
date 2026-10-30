import AppKit

enum Tone {
    case plain, good, warn, bad, info

    var color: NSColor {
        switch self {
        case .plain: return .secondaryLabelColor
        case .good: return .systemGreen
        case .warn: return .systemOrange
        case .bad: return .systemRed
        case .info: return .systemTeal
        }
    }
}

/// 跟 Windows 版的主控台視窗一樣，一行一行顯示現在的狀況；文字可以選取、拷貝
final class LogWindow {
    private let window: NSWindow
    private let text: NSTextView
    private let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    init() {
        let scroll = NSTextView.scrollableTextView()
        text = scroll.documentView as! NSTextView
        text.isEditable = false
        text.textContainerInset = NSSize(width: 10, height: 10)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "PPT-Web 橋接程式"
        window.minSize = NSSize(width: 420, height: 240)
        window.contentView = scroll
        window.isReleasedWhenClosed = false
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    /// 說明文字，不加時間
    func banner(_ line: String) {
        append(line, .labelColor)
    }

    func status(_ line: String, _ tone: Tone = .plain) {
        append("[\(clock.string(from: Date()))] \(line)", tone.color)
    }

    private func append(_ line: String, _ color: NSColor) {
        let attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 13)]
        text.textStorage?.append(NSAttributedString(string: line + "\n", attributes: attributes))
        text.scrollToEndOfDocument(nil)
    }
}
