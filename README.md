# PPT-Web 簡報工作站

把做好的 PPT 丟進網頁播放，用手機掃 QR Code 當簡報筆：翻頁、黑幕，還能在手機上看備忘稿。

純靜態網站，簡報檔案不會上傳到任何伺服器。

規劃與設計請見 [docs/PLAN.md](docs/PLAN.md)。

## 使用方式

1. 在 PowerPoint 選「檔案 → 匯出 → 建立 PDF/XPS 文件」，存一份 PDF
2. 打開網站，把 PDF 和原本的 PPTX 一起拖進去，大圖下方會顯示每頁的備忘稿
3. 按 `F5` 從頭放映，`Shift` + `F5` 從目前頁放映，`Esc` 結束

手機遙控還在開發中。

## 開發

需要 Node.js 24 以上。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 單元測試
npm run build      # 輸出到 dist/
```

測試用的範例簡報在 `tests/fixtures/`。要重新產生（需要 Windows 和 PowerPoint）：

```powershell
./scripts/make-sample-deck.ps1
```

## 部署

推上 `main` 後，GitHub Actions 會自動測試、build 並部署到 GitHub Pages。第一次使用前，到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。
