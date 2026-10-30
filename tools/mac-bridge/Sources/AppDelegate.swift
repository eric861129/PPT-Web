import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: LogWindow?
    private var bridge: Bridge?
    private var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()
        let window = LogWindow()
        self.window = window
        window.show()
        NSApp.activate(ignoringOtherApps: true)
        // 視窗在背景時 macOS 會讓程式「打盹」、放慢計時器，翻頁就會延遲
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
            reason: "Relaying slide commands between PPT-Web and PowerPoint")
        let bridge = Bridge(log: window)
        self.bridge = bridge
        bridge.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.stop()
        if let activity = activity { ProcessInfo.processInfo.endActivity(activity) }
    }

    /// ⌘Q 結束；⌘C、⌘A 讓使用者能把畫面上的訊息拷貝出來回報問題
    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "結束 PPT-Web 橋接程式", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "編輯")
        editMenu.addItem(withTitle: "拷貝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "全選", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        return menu
    }
}
