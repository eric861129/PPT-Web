// PPT-Web PowerPoint 橋接程式（Mac 版）
//
// 跟 Windows 版的 public/tools/PPT-Web-Bridge.cmd 講同一套協定（src/powerpoint/protocol.ts）：
// 網站把手機送來的指令轉到這裡，這裡再用 AppleScript 控制 PowerPoint，
// 並把目前頁、備忘稿、縮圖回報給網站。
//
// 安全：只聽 127.0.0.1（其他電腦連不到），而且只接受來自 PPT-Web 網站
// 或本機開發網址的連線，其他網站就算知道這個埠也控制不了 PowerPoint。
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
