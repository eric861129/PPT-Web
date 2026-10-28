# 用 PowerPoint COM 產生測試用的範例簡報（PPTX + PDF），輸出到 tests/fixtures/。
# 需要 Windows 和已安裝的 PowerPoint。
#
# 刻意放進去的情境：
#   - 中英文混排、多段落與縮排的備忘稿
#   - 一張沒有備忘稿的投影片
#   - 一張隱藏投影片（PowerPoint 匯出 PDF 時預設不含）
#   - 一張事後搬動順序的投影片（slideN.xml 的檔名跟播放順序對不上）
#   - 一張有「逐項出現」動畫的投影片

$ErrorActionPreference = 'Stop'

$outDir = Join-Path $PSScriptRoot '..\tests\fixtures' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $outDir) {
    $outDir = New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot '..\tests\fixtures')
}
$pptxPath = Join-Path $outDir 'sample-deck.pptx'
$pdfPath = Join-Path $outDir 'sample-deck.pdf'

$ppLayoutTitle = 1
$ppLayoutText = 2
$ppSaveAsOpenXMLPresentation = 24
$ppSaveAsPDF = 32
$msoTrue = -1
$msoAnimEffectFade = 10
$msoAnimateTextByFirstLevel = 2
$msoAnimTriggerOnPageClick = 1

# 投影片內容：Title、Body（以 `n 分段，行首 Tab 代表第二層）、Notes、Color（RGB）
$slides = @(
    @{ Layout = $ppLayoutTitle; Title = 'PPT-Web 範例簡報'; Body = '測試用：翻頁、黑幕、備忘稿'
       Notes = "開場：先自我介紹，說明今天的主題。"; Color = 0x1F3A8A }
    @{ Title = '使用流程'; Body = "在 PowerPoint 匯出 PDF`n把 PDF 和 PPTX 拖進網站`n用手機掃 QR Code`n開始簡報"
       Notes = "強調檔案不會上傳。`n掃 QR Code 之前，手機和電腦都要有網路。"; Color = 0xF5F3EE }
    @{ Title = '（隱藏）備用資料'; Body = '只有被問到時才會用到'; Hidden = $true
       Notes = '這頁是隱藏投影片，預設匯出的 PDF 不會包含它。'; Color = 0xFDE68A }
    @{ Title = 'Mixed 中英文 123'; Body = "Slides 和 Notes 混排`n數字 2026 與符號 & < >"; Color = 0xE0F2FE }
    @{ Title = '長備忘稿'; Body = '這頁的備忘稿比較長，用來測試捲動'
       Notes = "第一段：先講背景。`n`t細節 A：補充說明。`n`t細節 B：另一個補充。`n第二段：再講結論。`n第三段：最後提醒時間。"; Color = 0xF5F3EE }
    @{ Title = 'Q&A'; Body = '歡迎提問'; Notes = '預留 10 分鐘問答。'; Color = 0xDCFCE7 }
    @{ Layout = $ppLayoutTitle; Title = '謝謝'; Body = 'PPT-Web 簡報工作站'; Notes = '結尾，感謝大家。'; Color = 0x1F3A8A }
    # 最後建立、再搬到第 2 頁：它的檔名會是 slide8.xml，但播放順序是第 2 張
    @{ Title = '為什麼需要簡報工作站'; Body = "不用安裝軟體`n手機就是簡報筆`n備忘稿跟著走"; MoveTo = 2; Animate = $true
       Notes = "三個重點，一個一個講。`n講到第三點時，示範手機上的備忘稿。"; Color = 0xF5F3EE }
)

function Convert-Rgb([int]$rgb) {
    # PowerPoint 的顏色是 BGR
    $r = ($rgb -shr 16) -band 0xFF; $g = ($rgb -shr 8) -band 0xFF; $b = $rgb -band 0xFF
    return $r + ($g -shl 8) + ($b -shl 16)
}

function Set-Text($range, [string]$text) {
    $range.Text = ''
    $lines = $text -split "`n"
    $range.Text = ($lines | ForEach-Object { $_.TrimStart("`t") }) -join "`r"
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].StartsWith("`t")) { $range.Paragraphs($i + 1).IndentLevel = 2 }
    }
    $range.Font.NameFarEast = 'Microsoft JhengHei'
    $range.Font.Name = 'Segoe UI'
}

$app = New-Object -ComObject PowerPoint.Application
try {
    $pres = $app.Presentations.Add(0)  # WithWindow = msoFalse，不顯示視窗
    $pres.PageSetup.SlideWidth = 960
    $pres.PageSetup.SlideHeight = 540

    $n = 0
    foreach ($s in $slides) {
        $n++
        $layout = if ($s.Layout) { $s.Layout } else { $ppLayoutText }
        $slide = $pres.Slides.Add($n, $layout)

        $slide.FollowMasterBackground = 0
        $slide.Background.Fill.Solid()
        $slide.Background.Fill.ForeColor.RGB = Convert-Rgb $s.Color
        $dark = $s.Color -eq 0x1F3A8A
        $textColor = if ($dark) { Convert-Rgb 0xFFFFFF } else { Convert-Rgb 0x1F2937 }

        $title = $slide.Shapes.Placeholders(1).TextFrame.TextRange
        Set-Text $title $s.Title
        $title.Font.Color.RGB = $textColor
        $title.Font.Bold = $msoTrue

        $body = $slide.Shapes.Placeholders(2)
        Set-Text $body.TextFrame.TextRange $s.Body
        $body.TextFrame.TextRange.Font.Color.RGB = $textColor

        # 右下角大大的頁碼（照建立順序），方便肉眼確認對到哪一張
        $tag = $slide.Shapes.AddTextbox(1, 820, 440, 120, 80)
        $tag.TextFrame.TextRange.Text = "#$n"
        $tag.TextFrame.TextRange.Font.Size = 40
        $tag.TextFrame.TextRange.Font.Color.RGB = $textColor
        $tag.TextFrame.TextRange.ParagraphFormat.Alignment = 3  # 靠右

        if ($s.Notes) { Set-Text $slide.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange $s.Notes }
        if ($s.Hidden) { $slide.SlideShowTransition.Hidden = $msoTrue }
        if ($s.Animate) {
            [void]$slide.TimeLine.MainSequence.AddEffect($body, $msoAnimEffectFade, $msoAnimateTextByFirstLevel, $msoAnimTriggerOnPageClick)
        }
        if ($s.MoveTo) { $slide.MoveTo($s.MoveTo) }
    }

    $pres.SaveAs($pptxPath, $ppSaveAsOpenXMLPresentation)
    $pres.SaveAs($pdfPath, $ppSaveAsPDF)
    $pres.Close()
    Write-Host "Wrote $pptxPath"
    Write-Host "Wrote $pdfPath"
}
finally {
    $app.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
