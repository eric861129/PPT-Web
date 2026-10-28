# PPT-Web 簡報工作站：規劃與設計

> 狀態：M0–M4 與 PowerPoint 模式完成；下一步：實機測試，M5／M6 依需求挑
> 最後更新：2026-10-28

## 1. 目標

把做好的 PPT 丟進網頁，就能：

- 在電腦上瀏覽整份簡報（縮圖列 + 大圖，不能編輯），再全螢幕放映
- 用手機掃 QR Code，把手機變成簡報筆：上一頁、下一頁、黑幕
- 在手機上直接看備忘稿（講稿）
- 接投影機時，筆電可以開講者檢視：目前頁、下一頁、備忘稿、計時器
- 整個站是靜態網站，部署在 GitHub Pages，不用自架後端

**不做的事**

- 線上編輯簡報
- 帳號系統、雲端存放簡報
- 把簡報放進 repo 公開分享（簡報只在自己電腦上用）

## 2. 已確認的需求

| 問題 | 回答 | 對設計的影響 |
|---|---|---|
| 簡報要放上網站分享嗎？ | 只在自己電腦上用 | 只做本機載入；匯出工具也只輸出本機檔案 |
| 常用「逐項出現」動畫嗎？ | 會；選擇讓 PowerPoint 放映 | 新增 PowerPoint 模式，見 [§3.4](#34-動畫逐項出現) |
| 場地網路？ | 可以用手機網路 | 電腦連手機熱點最穩，TURN 維持選配 |
| 電腦端要講者檢視嗎？ | 要，完整一點的 PPT 檢視，不需要編輯 | 電腦端分成檢視、放映、講者檢視三種畫面 |

## 3. 核心難題與決策

### 3.1 在瀏覽器顯示 PPT

瀏覽器不能原生顯示 PPTX，有三條路：

| 方案 | 畫面還原度 | 備忘稿 | 使用門檻 |
|---|---|---|---|
| 前端直接渲染 PPTX（pptxjs 一類套件） | 差。字型、圖表、SmartArt 常跑版 | 有 | 最低 |
| **PDF 顯示畫面 + PPTX 取備忘稿（採用）** | 高。PDF 是 PowerPoint 自己輸出的，用 pdf.js 向量渲染 | 從 PPTX 解析 | 要多匯出一次 PDF |
| 匯出工具：PowerPoint COM 產生每個步驟的畫面 | 最高，而且保留動畫步驟 | 有 | 要跑工具，排在 M5 |

**決策**：先用 PDF 顯示畫面，PPTX 只用來讀備忘稿。動畫步驟見 §3.4。

### 3.2 手機跟電腦怎麼通訊

靜態網站沒有後端，所以用 **WebRTC DataChannel** 讓手機和電腦點對點直連，只在配對那一刻借用公共的 signaling 伺服器交換連線資訊。

- 用 **PeerJS**（它有免費的 PeerJS Cloud signaling），最成熟、範例最多。PeerJS 預設的 ICE 設定除了 Google STUN，還有 PeerJS 自己的公用 TURN，手機 4G 對電腦 Wi-Fi 的情況多一層保障
- 連線邏輯包在 `Transport` 介面後面（`src/net/transport.ts`），之後可以換成 Trystero（同時用多個公共 relay，沒有單點故障）或自架 PeerServer
- PeerJS 要等開啟第一份簡報才載入、才連線；沒用到手機遙控的人不會連到任何外部伺服器
- 不採用：Firebase / Supabase（要申請帳號和金鑰）、BroadcastChannel（只能在同一個瀏覽器內通訊）

**網路情境與風險**

| 情境 | 預期結果 |
|---|---|
| 電腦連手機熱點 | 穩定，**現場首選** |
| 手機和電腦連同一個 Wi-Fi | 穩定 |
| 手機用 4G，電腦用場地 Wi-Fi | 多半可以；遇到擋 UDP 的公司網路或對稱型 NAT 會連不上，需要 TURN 伺服器 |
| PeerJS Cloud 故障 | 無法配對。M6 加備援 transport |
| 完全沒網路 | 無法配對，但鍵盤和實體簡報筆照常可用 |

對策：開場前可以按「連線測試」；設定頁可以填自己的 TURN 伺服器（Cloudflare、Metered 都有免費額度）；斷線後自動重連。

### 3.3 從 PPTX 讀出備忘稿

PPTX 其實是 zip 檔，解開後用 XML 解析（`src/core/pptx.ts`，M2 完成）：

1. 投影片**順序**看 `ppt/presentation.xml` 的 `<p:sldIdLst>`。不能用檔名 `slide1.xml`、`slide2.xml` 排序：PowerPoint 存檔時會照順序重新編號，但 Google 簡報、LibreOffice、python-pptx 產生的檔案不一定會
2. 用 `ppt/_rels/presentation.xml.rels` 把 `r:id` 對到 `slides/slideN.xml`
3. `slideN.xml` 根節點有 `show="0"`（或 `show="false"`）代表隱藏投影片
4. 在 `ppt/slides/_rels/slideN.xml.rels` 找 Type 結尾是 `/notesSlide` 的關聯，得到 `notesSlides/notesSlideM.xml`。沒有備忘稿的投影片沒有這個關聯，所以 notesSlide 的編號和投影片編號對不上（範例檔：8 張投影片只有 7 個 notesSlide）
5. 在 notesSlide 裡找有 `<p:ph type="body"/>` 的 shape，逐段 `<a:p>` 串起每個 run 的 `<a:t>`（PowerPoint 常把一句話拆成好幾個 run），`<a:br/>` 轉成換行，用 `lvl` 保留縮排層級；頭尾的空段落去掉，中間連續空段落只留一個
6. 順便抓每頁標題（`<p:ph type="title"/>` 或 `ctrTitle`），用在縮圖提示和手機的跳頁清單

只解壓 XML，不碰圖片和影片，大檔案也很快。元素一律用 localName 比對，Strict OOXML 的命名空間不同也能讀。PPTX 讀不了時，簡報照樣開啟，備忘稿面板會說明原因。

**隱藏投影片的對齊**：PowerPoint 匯出 PDF 預設不含隱藏投影片（範例檔已驗證：8 張投影片匯出 7 頁），所以要比對頁數：

- PDF 頁數 = 可見投影片數 → 拿掉隱藏投影片的備忘稿
- PDF 頁數 = 全部投影片數 → 全部保留
- 都對不上 → 照順序對齊，並跳出警告請使用者確認

不支援舊版 `.ppt`，請先另存成 `.pptx`。

### 3.4 動畫（逐項出現）

PDF 只會留下每張投影片「動畫全部播完」的樣子，而瀏覽器沒辦法正確播放 PPTX 的動畫，能正確播動畫的只有 PowerPoint 本身。考慮過的方案：

| 方案 | 做法 | 動畫 | 狀態 |
|---|---|---|---|
| **PowerPoint 放映（採用）** | PowerPoint 負責放映，網站轉接手機指令；電腦上跑一個橋接程式用 COM 控制 PowerPoint | 完全保留，包含飛入、路徑、切換效果 | ✅ 完成，見下方 |
| 自製匯出工具 | PowerPoint COM 把每個動畫步驟畫成圖片，打包成一個檔案拖進網站 | 逐項出現保留，動態效果變成淡入 | 備選（M5）：適合放映的電腦沒有 PowerPoint 時 |
| PPspliT 增益集 | 把每個動畫步驟拆成獨立投影片後匯出 PDF | 逐項出現保留 | 現在就能搭配 PDF 模式使用，不需要寫程式 |

**PowerPoint 模式的架構**

```
手機 ──WebRTC──▶ 電腦瀏覽器（網站）──ws://127.0.0.1:48210──▶ 橋接程式 ──COM──▶ PowerPoint
```

- 橋接程式是 `public/tools/PPT-Web-Bridge.cmd`：同一個檔案既是批次檔也是 PowerShell 腳本，雙擊就交給 Windows 內建的 PowerShell 5.1 執行，不用安裝、不需要系統管理員權限、不改執行原則設定
- 只聽 `127.0.0.1`；WebSocket 握手時檢查 `Origin`，只接受 `https://huangchiyu.com`、`https://eric861129.github.io` 和本機開發網址。其他網站就算知道埠號也控制不了 PowerPoint
- 只連「使用者自己開著視窗」的 PowerPoint，不會自己啟動 PowerPoint；網頁斷線或簡報都關掉時放掉 COM 參照，使用者關 PowerPoint 時才不會被留在背景（實測 3 秒內正常結束）
- 每 250 毫秒讀一次狀態，有變才送：目前投影片、動畫步驟（`GetClickIndex` / `GetClickCount`）、黑幕白幕、是否放映中、是否停在放映結束畫面
- 簡報內容（標題、備忘稿、隱藏投影片、寬高比）從 COM 讀；縮圖用 `Slide.Export` 匯出 JPEG，只在沒有指令要處理時才做，不拖慢翻頁
- 黑幕時按翻頁只會先回到畫面，跟 PDF 模式一致；還沒放映時按翻頁會移動 PowerPoint 編輯畫面裡選到的投影片
- 手機看到的頁碼只算會放映的投影片（隱藏頁不算），跟 PDF 模式一致；手機上會多顯示「動畫 1 / 3」，還沒放映時中間的按鈕變成「從這頁放映」

**橋接訊息**（`src/powerpoint/protocol.ts`，收到的 JSON 一律先整理驗證；PowerShell 的 `ConvertTo-Json` 偶爾把單一元素陣列寫成物件，也照樣讀得懂）

| 方向 | type | 內容 |
|---|---|---|
| 橋接 → 網站 | `hello` | 版本 |
| | `deck` | `title`, `aspect`, `slides[]`（`index`, `hidden`, `title`, `notes[]`）；沒有簡報時是 `null` |
| | `state` | `powerpoint`, `presentation`, `running`, `slide`, `view`（ppSlideShowState）, `clickIndex`, `clickCount` |
| | `thumb` | `slide`, `jpeg`（base64；失敗是 `null`） |
| 網站 → 橋接 | `command` | `next` / `prev` / `first` / `last` / `gotoSlide` / `blank` / `toggleBlank` / `start` / `end` |
| | `thumb` | `slide`, `width` |

**限制**

- 只支援 Windows 加上桌面版 PowerPoint；Mac 的 PowerPoint 沒有 COM
- 放映期間瀏覽器的網站分頁要開著（可以放在 PowerPoint 後面，不能關掉）
- Chrome / Edge 第一次連本機橋接程式時，可能會詢問是否允許網站存取這台裝置上的其他應用程式，要選允許
- 從網站下載的 `.cmd`，第一次執行時 Windows SmartScreen 可能警告未知發行者
- 縮圖是投影片動畫全部播完的樣子；投影幕上的畫面才是當下的動畫狀態

## 4. 系統架構

```
┌─────── 電腦：投影端 index.html ───────┐              ┌──── 手機：遙控端 remote.html ────┐
│ 拖入 PPTX + PDF                        │              │ 上一頁 / 下一頁 / 黑幕            │
│  ├ pdf.js 渲染 → 檢視／放映畫面        │   WebRTC     │ 目前頁、下一頁縮圖               │
│  ├ 解析 PPTX → 備忘稿、標題            │◀──────────▶│ 備忘稿（可調字級）               │
│  └ 產生縮圖（JPEG，寬約 480px）        │ DataChannel  │ 計時器、時鐘                     │
│ ShowController：唯一的播放狀態來源     │              │ Wake Lock 讓螢幕不休眠           │
│ IndexedDB：最近開過的簡報              │              │                                  │
└───────────────┬────────────────────────┘              └──────────────────────────────────┘
                │ BroadcastChannel（同一台電腦）
┌───────────────┴────────────────────────┐
│ 觀眾視窗 present（拖到投影機全螢幕）   │   ← M4 講者檢視
└────────────────────────────────────────┘
```

設計原則：

- **檔案不上傳**。簡報只存在電腦上，手機只收到備忘稿文字和小縮圖
- **ShowController 是唯一的狀態來源**。手機、觀眾視窗都只送指令、只顯示狀態；重新連線後由它重送完整狀態
- **所有輸入走同一套指令**：鍵盤、實體簡報筆、滑鼠、手機都送 `Command`（`src/core/navigation.ts`）

## 5. 配對與通訊協定（M3 完成）

**配對**

- 投影端產生隨機 room id（`pptweb-` 加 20 個英數字，約 103 bits），當作 PeerJS 的 peer id
- QR Code 網址：`https://huangchiyu.com/PPT-Web/remote.html#r=<room id>`，由目前網址推算。放在 `#` 後面，瀏覽器不會把它送到網站伺服器。正式網站一律產生 https 網址（手機螢幕常亮需要 https）
- **只有「手機遙控」視窗開著時，新手機才能配對**（`src/core/pairing.ts`）。QR Code 可能在開場前被投到大螢幕上，這樣台下的人掃了也不能在簡報中途接手。配對過的手機記在 sessionStorage，斷線、重新整理都能自己連回來；「中斷所有手機」會全部斷開並忘記
- 手機用存在 localStorage 的 client id 表明身分；同一支手機重複連線時，舊連線會被關掉
- 允許多支手機同時連線（例如助理幫忙翻頁），所有手機畫面同步
- 投影端重新整理後沿用同一個 room id（sessionStorage），手機不必重掃；若 id 被占用（例如複製了分頁）重試 3 次後換一個新的
- 主機跟著頁面活著，換簡報時手機不用重新配對，會自動收到新的簡報

**訊息格式**（`src/core/protocol.ts`，收到的資料一律先驗證）

手機 → 投影端

| type | 欄位 | 說明 |
|---|---|---|
| `hello` | `v`, `client` | 協定版本、手機的 client id |
| `command` | `id`, `command` | `Command`（翻頁、跳頁、黑幕），或 `startShow`（PowerPoint 模式）、`timer`（`toggle` / `reset`）；`id` 用來去重 |
| `ping` | `rtt` | 連上時一次，之後每 4 秒一次；`rtt` 是手機量到的上一次來回時間，電腦端拿來顯示連線品質 |

投影端 → 手機

| type | 欄位 | 說明 |
|---|---|---|
| `welcome` / `rejected` | `reason` | 配對通過／被拒絕（附原因，手機不再自動重試） |
| `deck` | `deck`：`title`, `count`, `aspect`, `hasNotes`, `pages[]`, `warning` | 配對通過時、換簡報時送；關閉簡報時送 `null` |
| `state` | `index`, `blank`, `showing`, `elapsedMs`, `timerRunning`, `clicks`, `ended` | 每次狀態變動都送。計時用「經過的毫秒數」而不是時間點，兩台裝置時鐘不準也沒關係；`timerRunning: false` 代表暫停中，手機不要自己往下算 |
| `thumb` | `index`, `jpeg` | 640px 寬的 JPEG，先送目前頁附近，再背景補齊；同一張只渲染一次，所有手機共用 |
| `pong` | | 心跳回應 |

**斷線處理**：手機 12 秒沒收到電腦任何訊息就當作斷線；重連退避 1、2、4、8、10 秒；頁面回到前景或網路恢復時立刻重連。電腦端 20 秒沒收到手機消息就把它移除。

## 6. 畫面設計

### 6.1 電腦端

三種畫面：

- **開始頁**：拖放區、最近開過的簡報（M4，最多 6 份，存在這個瀏覽器的 IndexedDB，可單筆移除或全部清除）、「怎麼匯出 PDF」說明、PowerPoint 模式入口。電腦端重新整理時會自動打開剛才那份簡報（M4），手機自己連回來
- **檢視模式**（M1、M2 完成）：上方標題列與放映按鈕、左側縮圖列、中間大圖、下方備忘稿面板。點縮圖跳頁（滑鼠停在縮圖上會顯示該頁標題），雙擊大圖從該頁放映。備忘稿可以用 A− / A+ 調字級，拖拉面板上緣調高度（雙擊恢復預設），兩者都會記住
- **放映模式**（M1 完成）：全螢幕、投影片置中保持比例。滑鼠一動，左下角出現工具列（上一頁、頁碼、下一頁、黑幕、結束），2.5 秒不動就連同游標一起隱藏
- **講者檢視**（M4 完成）：按「講者檢視」或 `Alt`+`F5`（跟 PowerPoint 一樣）另開觀眾視窗（`audience.html`）。觀眾視窗自己用 pdf.js 渲染，內容和翻頁由主視窗用 postMessage 同步；Chrome / Edge 允許「視窗管理」時會自動搬到第二個螢幕，在那個視窗按任意鍵或點一下就全螢幕，之後在觀眾視窗按的鍵（例如簡報筆）都轉回主視窗處理。主視窗變成講者檢視：左邊目前頁（附翻頁工具列）、右上下一頁、右下備忘稿、上方計時器（暫停／重設）、現在時間、手機數；黑幕時講者看到半透明遮罩和「觀眾看到黑幕」。`Esc`、結束按鈕、或直接關掉觀眾視窗都會結束講者檢視

按鍵（照 PowerPoint 的習慣，多數實體簡報筆送的就是這些鍵）：

| 動作 | 按鍵 |
|---|---|
| 下一頁 | `→` `↓` `Space` `PageDown` `Enter` `N`、滑鼠點畫面、滾輪往下 |
| 上一頁 | `←` `↑` `PageUp` `Backspace` `P`、滾輪往上 |
| 從頭放映／從目前頁放映 | `F5` / `Shift` + `F5` |
| 結束放映 | `Esc` |
| 黑幕／白幕（再按一次取消） | `B` `.` / `W` `,` |
| 切換全螢幕 | `F` |
| 第一頁／最後一頁 | `Home` / `End` |
| 跳頁 | 數字 + `Enter`（2 秒沒按 Enter 就取消） |

細節：

- 黑幕或白幕時按翻頁，只會先回到畫面，不會跳頁（跟 PowerPoint 一樣）
- 滾輪一段連續滾動只翻一頁，避免觸控板慣性一口氣翻好幾頁
- 前後各 2 頁預先渲染，翻頁約 10ms，不會閃白

**手機遙控視窗**（M3 完成）：上方「手機遙控」按鈕或按 `Q` 開啟，顯示 QR Code、網址（可複製）、連線狀態、「中斷所有手機」。放映中按 `Q` 不會開，避免 QR Code 出現在投影幕上。按鈕上的綠色數字是已連線的手機數，手機連上或斷線時會跳出提示。

**PowerPoint 模式**（完成）：開始頁的「用 PowerPoint 放映」進入，網址會記成 `#powerpoint`，重新整理後還在同一個模式。沒連上橋接程式時顯示下載與設定步驟；連上後顯示目前投影片（含動畫步驟）、下一張、備忘稿（可調字級）、上一步／黑幕／下一步、從頭放映／從目前頁放映／結束放映。鍵盤和 PDF 模式一樣：方向鍵、`F5`、`Shift`+`F5`、`Esc`、`B`、數字 + `Enter`、`Q`。

### 6.2 遙控端（手機，直式，M3 完成）

```
┌─────────────────────────────┐
│ ● 已連線    5 / 24   12:34  │  連線燈、頁碼（點一下開跳頁清單）、計時器
├──────────────┬──────────────┤
│   目前頁     │   下一頁      │  縮圖
├──────────────┴──────────────┤
│ 備忘稿                A− A+ │
│ 這一頁先講市場規模，         │  大字、可捲動、左右滑動也能換頁
│ 再帶到我們的切入點……         │
│                             │
├─────────┬─────────┬─────────┤
│ ◀ 上一頁 │  ■ 黑幕  │ 下一頁 ▶ │  下一頁按鈕最大，拇指好按
└─────────┴─────────┴─────────┘
```

- 深色主題，在台上不刺眼
- 上方：連線狀態（放映中／檢視模式／重新連線中）、頁碼、計時（開始放映後顯示經過時間，之前顯示現在時間）
- 黑幕開著時，整個遙控端外框變紅、目前頁縮圖蓋上「黑幕中」、按鈕變成紅色的「取消黑幕」
- 字級設定存在 localStorage
- Screen Wake Lock 讓手機不自動鎖屏（需要 https；iOS 16.4 以上支援）
- Android 按下時震動回饋（iOS Safari 不支援 `navigator.vibrate`）
- 橫拿手機時：縮圖在左、備忘稿在右
- 沒連上時整頁顯示原因：沒掃 QR Code、找不到電腦、被拒絕（附「重新連線」按鈕）、電腦沒開簡報
- 點頁碼打開跳頁清單（縮圖 + 標題，目前頁有藍框），點一下就跳過去（M4）
- 點時間打開計時器：開始、暫停、繼續、重設，所有手機和電腦共用同一個計時器（M4）
- 狀態列旁顯示跟電腦之間的延遲，超過 200ms 變黃、500ms 變紅（M4）

**網頁做不到的事**：拿不到手機音量鍵，所以沒辦法用音量鍵翻頁。

## 7. 技術選型

| 項目 | 選擇 | 理由 |
|---|---|---|
| 建置 | Vite 8 + TypeScript 7，不用框架 | 頁面不多、狀態單純 |
| PDF 渲染 | pdfjs-dist 6 | 業界標準 |
| 解壓 PPTX | fflate | 比 JSZip 小很多，還能只解壓需要的檔案 |
| XML 解析 | 瀏覽器內建 DOMParser | 不用額外套件 |
| P2P 連線 | PeerJS | 最成熟、文件多；動態載入 |
| QR Code | qrcode-generator | 小、沒有相依套件、型別內建 |
| 本機儲存 | idb-keyval（M4） | 簡化 IndexedDB |
| 測試 | Vitest；PPTX 解析的測試用 jsdom 提供 DOMParser；範例簡報由 PowerPoint 產生 | |
| 部署 | GitHub Actions → GitHub Pages | |

pdf.js 的字碼表、標準字型、wasm 解碼器由 `scripts/copy-pdfjs-assets.mjs` 在 `dev` / `build` 前複製到 `public/pdfjs/`（不進版控）。

## 8. 目錄結構

```
PPT-Web/
├─ index.html                 電腦端入口（開始頁、檢視、放映）
├─ remote.html                手機遙控端入口
├─ audience.html              講者檢視的觀眾視窗
├─ src/
│  ├─ core/                   不碰 DOM、可單獨測試
│  │  ├─ navigation.ts        Command、ShowState、ShowController
│  │  ├─ pptx.ts              解析 PPTX：順序、隱藏、標題、備忘稿
│  │  ├─ deck.ts              備忘稿型別、把投影片對到 PDF 頁
│  │  ├─ protocol.ts          手機與電腦之間的訊息、驗證、去重
│  │  ├─ pairing.ts           配對規則、room id、手機網址
│  │  ├─ stopwatch.ts         共用的簡報計時器
│  │  └─ time.ts              時間與延遲的顯示格式
│  ├─ net/
│  │  ├─ transport.ts         連線層介面
│  │  └─ peerjs.ts            PeerJS 實作
│  ├─ display/
│  │  ├─ main.ts              開始頁、拖放、開啟／關閉簡報
│  │  ├─ loader.ts            檢查拖進來的檔案
│  │  ├─ renderer.ts          pdf.js 渲染佇列與快取、手機用 JPEG 縮圖
│  │  ├─ slide-view.ts        單頁畫面（檢視與放映共用）
│  │  ├─ thumbnails.ts        縮圖列
│  │  ├─ notes-panel.ts       備忘稿面板
│  │  ├─ remote-host.ts       手機遙控主機：配對、指令、推送內容
│  │  ├─ audience-window.ts   講者檢視的觀眾視窗：開啟、搬到第二螢幕、同步
│  │  ├─ recent.ts            最近開過的簡報（IndexedDB）
│  │  ├─ toast.ts             短暫提示
│  │  ├─ pairing-dialog.ts    手機遙控視窗（QR Code）
│  │  ├─ session.ts           開啟中的簡報：檢視／放映／講者檢視、輸入、狀態同步
│  │  ├─ keyboard.ts          按鍵對應
│  │  └─ icons.ts
│  ├─ remote/
│  │  ├─ main.ts              手機端進入點：按鈕、滑動、螢幕常亮
│  │  ├─ client.ts            連線、重連、心跳
│  │  └─ view.ts              手機畫面
│  ├─ powerpoint/             PowerPoint 模式
│  │  ├─ protocol.ts          與橋接程式之間的訊息、驗證
│  │  ├─ mapping.ts           投影片編號 ↔ 手機頁碼、指令轉換
│  │  ├─ bridge-client.ts     連到本機橋接程式、重連、縮圖請求
│  │  └─ session.ts           PowerPoint 模式的畫面
│  ├─ shared/dom.ts           兩端共用的 DOM 與偏好設定小工具
│  └─ styles/
├─ public/
│  ├─ tools/PPT-Web-Bridge.cmd  PowerPoint 橋接程式（批次檔 + PowerShell）
│  └─ favicon；pdfjs/ 由腳本產生
├─ scripts/
│  ├─ copy-pdfjs-assets.mjs
│  └─ make-sample-deck.ps1    用 PowerPoint 產生測試用範例簡報
├─ tests/
│  ├─ fixtures/               sample-deck.pptx / .pdf
│  └─ *.test.ts
├─ docs/PLAN.md
└─ .github/workflows/deploy.yml
```

## 9. 開發里程碑

| 階段 | 內容 | 完成標準 |
|---|---|---|
| **M0 骨架** ✅ | Vite + TS、兩個入口頁、GitHub Pages 自動部署 | 推上 main 後網站自動更新 |
| **M1 投影端** ✅ | 拖入 PDF、檢視模式、放映模式、鍵盤滑鼠翻頁、全螢幕、黑幕白幕、跳頁、預先渲染 | 實測：7 頁範例 0.4 秒內可播放，翻頁約 10ms |
| **M2 備忘稿** ✅ | PPTX 解析、隱藏投影片對齊、檢視模式的備忘稿面板 | 實測：範例檔 7 頁的備忘稿全部對齊（隱藏頁跳過、無備忘稿、多段縮排）；PPTX 壞掉時簡報照樣開 |
| **M3 手機遙控** ✅ | QR 配對（限配對視窗開著時）、上下頁、滑動換頁、黑幕、備忘稿、縮圖、計時、字級、螢幕常亮、自動重連 | 實測（真實 PeerJS 連線）：掃碼 1.4 秒連上；按鍵到換頁約 50ms；手機重新整理 1.5 秒自動連回 |
| **PowerPoint 模式** ✅ | 橋接程式、網站的 PowerPoint 模式、手機顯示動畫步驟與「從這頁放映」 | 實測（真實 PowerPoint + 橋接程式 + PeerJS）：手機按下一步到 PowerPoint 換頁並回報約 80–115ms；從手機開始放映 0.35 秒；動畫逐步、隱藏頁跳過、黑幕、跳頁、結束、電腦端重新整理後手機 2.2 秒連回 |
| **M4 打磨與講者檢視** ✅ | 計時器暫停／重設、跳頁清單、最近簡報、重新整理後恢復、連線延遲（連線測試）、電腦端講者檢視 | 實測：觀眾視窗跟著翻頁、按鍵轉回主視窗、黑幕、計時暫停／重設兩端同步、重新整理後自動恢復簡報且手機連回、最近清單開啟與移除。實機手機鎖屏與真正的雙螢幕還要現場驗證 |
| **M5 動畫步驟匯出工具**（備選） | 放映的電腦沒有 PowerPoint 時用：預先把每個動畫步驟畫成圖片打包 | 範例檔的逐項出現動畫逐步播放 |
| **M6 選配** | PWA、TURN 設定、備援 transport、雷射筆 | 依需求挑 |

## 10. 測試計畫

- **單元測試**（`npm test`）：翻頁與黑幕規則、按鍵對應、檔案檢查、PPTX 解析（範例檔加上手工組出的邊界情況：順序和檔名不一致、絕對路徑、換行、欄位、空段落、壞檔）、頁數對齊；M3 用假的連線層測配對與拒絕、重新整理後重連、指令去重、狀態與計時、縮圖順序與失敗重試、靜默斷線、重連退避、心跳；PowerPoint 模式測橋接訊息驗證（含 PowerShell 單一元素陣列）、投影片與頁碼換算、指令轉換、橋接連線重試與縮圖請求；M4 測計時器（暫停、繼續、重設）、計時與延遲的協定、延遲量測、最近清單排序與上限、相對時間、Alt+F5
- **範例簡報**：`scripts/make-sample-deck.ps1` 用 PowerPoint 產生，刻意包含中英混排、多段縮排備忘稿、無備忘稿的頁、隱藏投影片、搬動過順序的投影片、逐項出現動畫
- **瀏覽器實測**：M1 用無頭 Edge 跑過完整流程（開檔、翻頁、縮圖、滾輪、放映、全螢幕、閒置隱藏、黑幕、結束、關閉再開），也在模擬 GitHub Pages 子路徑 `/PPT-Web/` 下跑過 build 產出；M2 加跑每頁備忘稿、字級、拖拉高度、偏好保存、只放 PDF、PPTX 壞檔；M3 用兩個獨立的瀏覽器環境（電腦 + 模擬手機）透過真實 PeerJS 連線跑完整流程：配對、雙向翻頁、黑幕、滑動、放映計時、手機重新整理重連、陌生手機被拒、換簡報、中斷所有手機、橫向版面
- **M4**：電腦 + 模擬手機 + 真的彈出式觀眾視窗跑完整流程：延遲顯示、跳頁清單、講者檢視開啟與同步、觀眾視窗按鍵轉送與全螢幕、計時器暫停／重設、黑幕、Esc 結束、關掉觀眾視窗結束、重新整理恢復、最近清單
- **PowerPoint 模式**：在這台電腦上用真實的 PowerPoint（視窗模式放映範例簡報）、橋接程式、兩個瀏覽器環境跑完整流程；另外單獨測橋接程式的來源檢查（惡意來源被拒）、每個指令、縮圖匯出、使用者在網頁連著時關掉 PowerPoint
- **裝置**（尚未實機測試）：手機 iPhone Safari、Android Chrome；電腦 Chrome、Edge
- **網路**（尚未實機測試）：電腦連手機熱點、同一個 Wi-Fi、手機 4G 對電腦 Wi-Fi
- **情境**（M4 起）：手機鎖屏後解鎖自動重連；投影端重新整理後恢復；兩支手機同時操作
