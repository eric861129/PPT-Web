# PPT-Web 簡報工作站

把做好的 PPT 丟進網頁播放，用手機掃 QR Code 當簡報筆：翻頁、黑幕，還能在手機上看備忘稿。

純靜態網站，簡報檔案不會上傳到任何伺服器。

規劃與設計請見 [docs/PLAN.md](docs/PLAN.md)。

## 使用方式

1. 在 PowerPoint 選「檔案 → 匯出 → 建立 PDF/XPS 文件」，存一份 PDF
2. 打開網站，把 PDF 和原本的 PPTX 一起拖進去，大圖下方會顯示每頁的備忘稿
3. 按上方「手機遙控」（或 `Q`），用手機掃 QR Code，手機就能翻頁、開黑幕、看備忘稿
4. 按 `F5` 從頭放映，`Shift` + `F5` 從目前頁放映，`Esc` 結束

手機遙控用 WebRTC 直連，手機和電腦都要能上網；現場網路不穩時，讓電腦連手機熱點最穩。「手機遙控」視窗開著時新手機才能配對，配對過的手機斷線後會自動連回來。

### 用 PowerPoint 放映（完整動畫）

PDF 會失去動畫。需要動畫時，改由電腦上的 PowerPoint 放映，手機照樣遙控、看備忘稿，還會顯示目前是第幾個動畫步驟。需要 Windows 和桌面版 PowerPoint。

1. 在網站開始頁選「用 PowerPoint 放映」，下載 `PPT-Web-Bridge.cmd`，雙擊執行並讓它開著（第一次執行時 Windows 可能警告，選「其他資訊 → 仍要執行」）
2. 用 PowerPoint 打開簡報
3. 網站會自動連上；瀏覽器詢問是否允許存取這台裝置上的其他應用程式時選「允許」
4. 按「手機遙控」配對手機，從網站、手機或 PowerPoint 開始放映都可以

橋接程式只接受這台電腦、而且只接受 PPT-Web 網站的連線。放映期間網站分頁要開著，可以放在 PowerPoint 後面。

## 開發

需要 Node.js 24 以上。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 單元測試
npm run build      # 輸出到 dist/
```

在本機用真的手機測試遙控時，用 `npm run dev -- --host` 讓區網裝置連得到，再用電腦的區網 IP（例如 `http://192.168.1.20:5173/`）打開電腦端；QR Code 會指向同一個 IP。區網 http 下手機螢幕常亮不會生效，其他功能正常。

測試用的範例簡報在 `tests/fixtures/`。要重新產生（需要 Windows 和 PowerPoint）：

```powershell
./scripts/make-sample-deck.ps1
```

## 部署

推上 `main` 後，GitHub Actions 會自動測試、build 並部署到 GitHub Pages。第一次使用前，到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。
