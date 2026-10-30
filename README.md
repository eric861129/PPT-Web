# PPT-Web 簡報工作站

把做好的 PPT 丟進網頁播放，用手機掃 QR Code 當簡報筆：翻頁、黑幕，還能在手機上看備忘稿。台下的觀眾也能掃 QR Code，在自己的手機上同步看簡報。

純靜態網站，簡報檔案不會上傳到任何伺服器。

規劃與設計請見 [docs/PLAN.md](docs/PLAN.md)。

## 使用方式

1. 在 PowerPoint 選「檔案 → 匯出 → 建立 PDF/XPS 文件」，存一份 PDF
2. 打開網站，把 PDF 和原本的 PPTX 一起拖進去，大圖下方會顯示每頁的備忘稿
3. 按上方「手機遙控」（或 `Q`），用手機掃 QR Code，手機就能翻頁、開黑幕、看備忘稿；點手機上的頁碼可以跳頁，點時間可以暫停或重設計時器
4. 按 `F5` 從頭放映，`Shift` + `F5` 從目前頁放映，`Esc` 結束
5. 接投影機時按「講者檢視」（或 `Alt` + `F5`）：觀眾視窗放到投影機上全螢幕，筆電看目前頁、下一頁、備忘稿和計時
6. 想讓台下觀眾在手機上跟著看，按「觀眾同步」開始分享，再按「投影到大螢幕」（或放映中按 `V`）把 QR Code 秀給大家掃；按任意鍵收起

觀眾同步只能看、不能控制，而且只看得到已經講過的頁，看不到備忘稿。觀眾可以往回翻看，按「回到目前頁」再跟上。同一台電腦的觀眾連結會一直沿用，可以下載 QR Code 圖片放進投影片；要讓舊連結失效就按「換新連結」。最多 100 位觀眾。

開過的簡報會出現在開始頁的「最近開過的簡報」，下次點一下就能打開；檔案只存在這個瀏覽器裡。

手機遙控用 WebRTC 直連，手機和電腦都要能上網；現場網路不穩時，讓電腦連手機熱點最穩。「手機遙控」視窗開著時新手機才能配對，配對過的手機斷線後會自動連回來。

### 用 PowerPoint 放映（完整動畫）

PDF 會失去動畫。需要動畫時，改由電腦上的 PowerPoint 放映，手機照樣遙控、看備忘稿，還會顯示目前是第幾個動畫步驟。需要 Windows 或 Mac，加上桌面版 PowerPoint。

1. 在網站開始頁選「用 PowerPoint 放映」，下載橋接程式並讓它開著：
   - Windows：下載 `PPT-Web-Bridge.cmd`，雙擊執行（第一次執行時 Windows 可能警告，選「其他資訊 → 仍要執行」）
   - Mac：下載 `PPT-Web-Bridge-Mac.zip`，解壓縮後打開「PPT-Web Bridge」。第一次打開時 macOS 會擋下來，到「系統設定 → 隱私權與安全性」按「強制打開」；macOS 問是否允許控制「Microsoft PowerPoint」時選「好」
2. 用 PowerPoint 打開簡報
3. 網站會自動連上；瀏覽器詢問是否允許存取這台裝置上的其他應用程式時選「允許」
4. 按「手機遙控」配對手機，從網站、手機或 PowerPoint 開始放映都可以

橋接程式只接受這台電腦、而且只接受 PPT-Web 網站的連線。放映期間網站分頁要開著，可以放在 PowerPoint 後面。

Mac 版的限制：要用 Chrome、Edge 或 Firefox 打開網站（Safari 不讓網頁連到這台電腦上的程式）；手機上不會顯示第幾個動畫步驟；跳頁時如果 PowerPoint 不接受直接跳頁，會一步一步翻過去。

## 開發

需要 Node.js 24 以上。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 單元測試
npm run build      # 輸出到 dist/
```

在本機用真的手機測試遙控時，用 `npm run dev -- --host` 讓區網裝置連得到，再用電腦的區網 IP（例如 `http://192.168.1.20:5173/`）打開電腦端；QR Code 會指向同一個 IP。區網 http 下手機螢幕常亮不會生效，其他功能正常。

手機遙控和觀眾同步預設用免費的 PeerJS Cloud 配對伺服器，它限制同一個 IP 的新連線數量，超過會被擋大約一小時。觀眾很多時可以自架 [PeerJS 伺服器](https://github.com/peers/peerjs-server)，build 時用 `VITE_PEER_SERVER` 指過去（例如 `VITE_PEER_SERVER=https://peer.example.com/ npm run build`）。本機測試時也能用它避開公用伺服器：

```bash
npx peer --port 9000
VITE_PEER_SERVER=http://localhost:9000/ npm run dev
```

Mac 版橋接程式的原始碼在 `tools/mac-bridge/`（Swift）。在 Mac 上編譯（需要 Xcode 或 Command Line Tools），編好的 zip 會放進 `public/tools/`，`npm run dev` 時網站就能下載：

```bash
bash tools/mac-bridge/build.sh
```

部署時 GitHub Actions 會在 macOS 上編一份同時支援 Apple 晶片和 Intel 的版本。

測試用的範例簡報在 `tests/fixtures/`。要重新產生（需要 Windows 和 PowerPoint）：

```powershell
./scripts/make-sample-deck.ps1
```

## 部署

推上 `main` 後，GitHub Actions 會自動測試、build 並部署到 GitHub Pages。第一次使用前，到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。
