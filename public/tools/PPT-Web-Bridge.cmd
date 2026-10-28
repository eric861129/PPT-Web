<# :
@echo off
rem PPT-Web PowerPoint bridge. This file is both a batch file and a PowerShell
rem script: double-clicking it hands the rest of the file to Windows PowerShell.
rem Keep this batch section ASCII-only; cmd.exe reads it in the console code page.
title PPT-Web PowerPoint Bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:PPTWEB_BRIDGE_FILE='%~f0'; Invoke-Expression ([IO.File]::ReadAllText($env:PPTWEB_BRIDGE_FILE, [Text.Encoding]::UTF8))"
if errorlevel 1 pause
exit /b
#>

# ---------------------------------------------------------------------------
# PPT-Web PowerPoint 橋接程式
#
# 讓 PPT-Web 網站（https://huangchiyu.com/PPT-Web/）透過這台電腦上的
# PowerPoint 放映：網站把手機送來的指令轉到這裡，這裡再用 COM 控制 PowerPoint，
# 並把目前頁、動畫步驟、備忘稿、縮圖回報給網站。
#
# 安全：只聽 127.0.0.1（其他電腦連不到），而且只接受來自 PPT-Web 網站
# 或本機開發網址的連線，其他網站就算知道這個埠也控制不了 PowerPoint。
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$BridgeVersion = 1
$Port = if ($env:PPTWEB_BRIDGE_PORT) { [int]$env:PPTWEB_BRIDGE_PORT } else { 48210 }
$AllowedOrigins = @('https://huangchiyu.com', 'https://eric861129.github.io')
if ($env:PPTWEB_BRIDGE_ORIGINS) { $AllowedOrigins += $env:PPTWEB_BRIDGE_ORIGINS -split ',' }
$PollMs = 250
$ThumbDir = Join-Path $env:TEMP 'ppt-web-bridge'

# PowerPoint 常數
$ppSlideShowRunning = 1
$ppSlideShowBlackScreen = 3
$ppSlideShowWhiteScreen = 4
$ppSlideShowDone = 5
$ppPlaceholderBody = 2
$msoTrue = -1

function Write-Status([string]$text, [ConsoleColor]$color = 'Gray') {
    Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $text) -ForegroundColor $color
}

function Test-Origin([string]$origin) {
    if (-not $origin) { return $false }
    if ($AllowedOrigins -contains $origin) { return $true }
    return $origin -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
}

# ---------- PowerPoint ----------

$script:App = $null

function Get-PowerPoint {
    if ($script:App) {
        try { $null = $script:App.Presentations.Count; return $script:App } catch { $script:App = $null }
    }
    # 只在 PowerPoint 有開著的視窗時才連上；使用者關掉 PowerPoint 後，
    # 我們手上的參照不會把它留在背景
    $visible = Get-Process POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if (-not $visible) { return $null }
    try { $script:App = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { $script:App = $null }
    return $script:App
}

function Clear-PowerPoint {
    if ($script:App) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:App) } catch {}
        $script:App = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

function Get-ShowView($app) {
    if ($app.SlideShowWindows.Count -gt 0) { return $app.SlideShowWindows.Item(1).View }
    return $null
}

function Get-CurrentPresentation($app) {
    if ($app.SlideShowWindows.Count -gt 0) { return $app.SlideShowWindows.Item(1).Presentation }
    try { return $app.ActivePresentation } catch {}
    if ($app.Presentations.Count -gt 0) { return $app.Presentations.Item(1) }
    return $null
}

# 每次 COM 呼叫要幾毫秒，所以狀態只讀需要的部分；
# 「現在是哪份簡報」變得慢，每秒才檢查一次
$script:Key = ''
$script:KeyCheckedAt = [long]-1000

function Get-Snapshot([long]$now) {
    $empty = @{ powerpoint = $false; presentation = $false; running = $false; slide = $null; view = $null; clickIndex = 0; clickCount = 0; key = '' }
    $app = Get-PowerPoint
    if (-not $app) { return $empty }
    $win = $null
    if ($app.SlideShowWindows.Count -gt 0) { $win = $app.SlideShowWindows.Item(1) }
    elseif ($app.Presentations.Count -eq 0) {
        Clear-PowerPoint
        $script:Key = ''
        $empty.powerpoint = $true
        return $empty
    }

    $slide = $null
    $viewState = $null
    $clickIndex = 0
    $clickCount = 0
    if ($win) {
        $view = $win.View
        $viewState = [int]$view.State
        if ($viewState -ne $ppSlideShowDone) {
            try { $slide = [int]$view.Slide.SlideIndex } catch {}
            try { $clickIndex = [int]$view.GetClickIndex(); $clickCount = [int]$view.GetClickCount() } catch {}
        }
    } else {
        try { $slide = [int]$app.ActiveWindow.View.Slide.SlideIndex } catch {}
    }

    if (-not $script:Key -or $now - $script:KeyCheckedAt -ge 1000) {
        $pres = if ($win) { $win.Presentation } else { Get-CurrentPresentation $app }
        $script:Key = if ($pres) { "$($pres.FullName)|$($pres.Slides.Count)" } else { '' }
        $script:KeyCheckedAt = $now
    }
    return @{
        powerpoint = $true
        presentation = [bool]$script:Key
        running = [bool]$win
        slide = $slide
        view = $viewState
        clickIndex = $clickIndex
        clickCount = $clickCount
        key = $script:Key
    }
}

function Read-Deck {
    $app = Get-PowerPoint
    if (-not $app) { return $null }
    $pres = Get-CurrentPresentation $app
    if (-not $pres) { return $null }
    $slides = @()
    foreach ($s in $pres.Slides) {
        $title = ''
        try {
            if ($s.Shapes.HasTitle -eq $msoTrue) {
                $title = ($s.Shapes.Title.TextFrame.TextRange.Text -replace '[\r\n\v]+', ' ').Trim()
            }
        } catch {}
        $notes = @()
        try {
            foreach ($ph in $s.NotesPage.Shapes.Placeholders) {
                if ($ph.PlaceholderFormat.Type -ne $ppPlaceholderBody -or $ph.HasTextFrame -ne $msoTrue) { continue }
                $range = $ph.TextFrame.TextRange
                $count = $range.Paragraphs().Count
                for ($i = 1; $i -le $count; $i++) {
                    $p = $range.Paragraphs($i)
                    # 段落結尾是 \r，段落內的換行（Shift+Enter）是 \v
                    $text = ($p.Text -replace '\r$', '') -replace '\v', "`n"
                    $notes += @{ text = $text; level = [Math]::Max(0, [int]$p.IndentLevel - 1) }
                }
            }
        } catch {}
        $slides += @{
            index = [int]$s.SlideIndex
            hidden = ($s.SlideShowTransition.Hidden -eq $msoTrue)
            title = $title
            notes = $notes
        }
    }
    return @{
        title = [IO.Path]::GetFileNameWithoutExtension($pres.Name)
        aspect = [double]$pres.PageSetup.SlideWidth / [double]$pres.PageSetup.SlideHeight
        slides = $slides
    }
}

function Export-Thumb([int]$slideIndex, [int]$width) {
    $app = Get-PowerPoint
    if (-not $app) { return $null }
    $pres = Get-CurrentPresentation $app
    if (-not $pres -or $slideIndex -lt 1 -or $slideIndex -gt $pres.Slides.Count) { return $null }
    $width = [Math]::Min(1280, [Math]::Max(64, $width))
    $height = [int][Math]::Round($width * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
    if (-not (Test-Path $ThumbDir)) { New-Item -ItemType Directory -Force $ThumbDir | Out-Null }
    $file = Join-Path $ThumbDir ("slide-{0}.jpg" -f $slideIndex)
    $pres.Slides.Item($slideIndex).Export($file, 'JPG', $width, $height)
    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
    Remove-Item $file -ErrorAction SilentlyContinue
    return $base64
}

function Invoke-PptCommand($cmd) {
    $app = Get-PowerPoint
    if (-not $app) { return }
    $view = Get-ShowView $app
    if ($view) {
        $state = [int]$view.State
        $blank = $state -eq $ppSlideShowBlackScreen -or $state -eq $ppSlideShowWhiteScreen
        switch ($cmd.type) {
            # 跟網站的放映模式一樣：黑幕時按翻頁只會先回到畫面
            'next' { if ($blank) { $view.State = $ppSlideShowRunning } else { $view.Next() } }
            'prev' { if ($blank) { $view.State = $ppSlideShowRunning } else { $view.Previous() } }
            'first' { $view.First() }
            'last' { $view.Last() }
            'gotoSlide' { $view.GotoSlide([int]$cmd.slide) }
            'blank' {
                $modes = @{ off = $ppSlideShowRunning; black = $ppSlideShowBlackScreen; white = $ppSlideShowWhiteScreen }
                if ($modes.ContainsKey([string]$cmd.mode)) { $view.State = $modes[[string]$cmd.mode] }
            }
            'toggleBlank' {
                $target = if ($cmd.mode -eq 'white') { $ppSlideShowWhiteScreen } else { $ppSlideShowBlackScreen }
                $view.State = if ($state -eq $target) { $ppSlideShowRunning } else { $target }
            }
            'end' { $view.Exit() }
        }
        return
    }

    $pres = Get-CurrentPresentation $app
    if (-not $pres) { return }
    $count = $pres.Slides.Count
    $current = 1
    try { $current = [int]$app.ActiveWindow.View.Slide.SlideIndex } catch {}
    # 還沒放映時，翻頁就移動 PowerPoint 編輯畫面裡選到的投影片
    $target = switch ($cmd.type) {
        'next' { [Math]::Min($count, $current + 1) }
        'prev' { [Math]::Max(1, $current - 1) }
        'first' { 1 }
        'last' { $count }
        'gotoSlide' { [Math]::Min($count, [Math]::Max(1, [int]$cmd.slide)) }
        default { $null }
    }
    if ($target) {
        try { $app.ActiveWindow.View.GotoSlide($target) } catch {}
    }
    if ($cmd.type -eq 'start') {
        $win = $pres.SlideShowSettings.Run()
        $from = [int]$cmd.slide
        if ($from -gt 1 -and $from -le $count) { $win.View.GotoSlide($from) }
    }
}

# ---------- WebSocket ----------

function Send-Json($ws, $object) {
    $json = ConvertTo-Json $object -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $bytes)
    $ws.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Invoke-WithRetry([scriptblock]$action) {
    # PowerPoint 忙碌（例如開著對話框）時 COM 會拒絕呼叫，稍等一下再試一次
    try { & $action } catch {
        Start-Sleep -Milliseconds 150
        & $action
    }
}

function Open-Client($context) {
    try {
        $origin = $context.Request.Headers['Origin']
        if (-not $context.Request.IsWebSocketRequest) {
            $body = [Text.Encoding]::UTF8.GetBytes("PPT-Web bridge $BridgeVersion is running.")
            $context.Response.ContentType = 'text/plain; charset=utf-8'
            $context.Response.OutputStream.Write($body, 0, $body.Length)
            $context.Response.Close()
            return $null
        }
        if (-not (Test-Origin $origin)) {
            Write-Status "拒絕來自 $origin 的連線（不是 PPT-Web 網站）" Yellow
            $context.Response.StatusCode = 403
            $context.Response.Close()
            return $null
        }
        # PowerShell 會把 $null 轉成空字串傳給 string 參數，這裡要傳真正的 null
        $ws = $context.AcceptWebSocketAsync([NullString]::Value).GetAwaiter().GetResult().WebSocket
        Write-Status "網頁已連線（$origin）" Green
        return $ws
    } catch {
        Write-Status "無法接受連線：$($_.Exception.Message)" Yellow
        try { $context.Response.Abort() } catch {}
        return $null
    }
}

function Close-Client($ws) {
    if (-not $ws) { return }
    try {
        if ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
            $ws.CloseOutputAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'replaced', [Threading.CancellationToken]::None).Wait(1000) | Out-Null
        }
    } catch {}
    $ws.Dispose()
}

function Serve-Client($ws, $listener, [ref]$pendingContext) {
    $buffer = New-Object byte[] 65536
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buffer)
    $message = New-Object IO.MemoryStream
    $receive = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None)
    $thumbQueue = New-Object System.Collections.Generic.Queue[object]
    $lastState = ''
    $lastKey = $null
    $lastPresentationName = ''
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $nextPoll = 0

    Send-Json $ws @{ type = 'hello'; app = 'ppt-web-bridge'; version = $BridgeVersion }

    while ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
        # 有新的網頁連進來：改服務新的（例如網頁重新整理）
        if ($pendingContext.Value.IsCompleted) {
            $next = Open-Client $pendingContext.Value.Result
            $pendingContext.Value = $listener.GetContextAsync()
            if ($next) { Close-Client $ws; return $next }
        }

        # 定期看 PowerPoint 的狀態，有變才送；剛執行完指令時立刻看
        if ($clock.ElapsedMilliseconds -ge $nextPoll) {
            $nextPoll = $clock.ElapsedMilliseconds + $PollMs
            try {
                $snapshot = Get-Snapshot $clock.ElapsedMilliseconds
                if ($snapshot.key -ne $lastKey) {
                    $lastKey = $snapshot.key
                    $deck = if ($snapshot.presentation) { Read-Deck } else { $null }
                    Send-Json $ws @{ type = 'deck'; deck = $deck }
                    $name = if ($deck) { $deck.title } else { '' }
                    if ($name -ne $lastPresentationName) {
                        $lastPresentationName = $name
                        if ($deck) { Write-Status ("PowerPoint 已開啟「{0}」，共 {1} 張投影片" -f $deck.title, $deck.slides.Count) Cyan }
                        else { Write-Status '等待 PowerPoint 開啟簡報…' }
                    }
                }
                $snapshot.Remove('key')
                $state = ConvertTo-Json $snapshot -Compress
                if ($state -ne $lastState) {
                    $lastState = $state
                    Send-Json $ws @{ type = 'state'; state = $snapshot }
                }
            } catch {
                # PowerPoint 忙碌或剛關掉，下次再看
            }
        }

        # 收網頁送來的訊息；沒事做時最多等到下一次看狀態
        $idle = [Math]::Max(1, [Math]::Min(100, $nextPoll - $clock.ElapsedMilliseconds))
        if ($thumbQueue.Count -gt 0) { $idle = 1 }
        if ($receive.Wait([int]$idle)) {
            $result = $receive.Result
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
            $message.Write($buffer, 0, $result.Count)
            if ($result.EndOfMessage) {
                $text = [Text.Encoding]::UTF8.GetString($message.ToArray())
                $message.SetLength(0)
                try {
                    $msg = ConvertFrom-Json $text
                    switch ($msg.type) {
                        'command' { Invoke-WithRetry { Invoke-PptCommand $msg.command }; $nextPoll = 0 }
                        'thumb' { $thumbQueue.Enqueue($msg) }
                        'refresh' { $lastKey = $null; $script:Key = '' }
                    }
                } catch {
                    Send-Json $ws @{ type = 'error'; message = $_.Exception.Message }
                }
            }
            $receive = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None)
            continue
        }

        # 有空檔時才產生縮圖，不拖慢翻頁
        if ($thumbQueue.Count -gt 0) {
            $request = $thumbQueue.Dequeue()
            try {
                # 剛好在切換投影片時 PowerPoint 可能拒絕呼叫，等一下再試一次
                $jpeg = Invoke-WithRetry { Export-Thumb ([int]$request.slide) ([int]$request.width) }
                if ($jpeg) { Send-Json $ws @{ type = 'thumb'; slide = [int]$request.slide; jpeg = $jpeg } }
            } catch {
                Send-Json $ws @{ type = 'thumb'; slide = [int]$request.slide; jpeg = $null }
            }
        }
    }

    Write-Status '網頁已中斷連線' Yellow
    Close-Client $ws
    return $null
}

# ---------- 主程式 ----------

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
    $listener.Start()
} catch {
    Write-Status "無法使用連接埠 $Port：$($_.Exception.Message)" Red
    Write-Status '可能已經有一個橋接程式在執行了。' Red
    exit 1
}

Write-Host ''
Write-Host '  PPT-Web PowerPoint 橋接程式' -ForegroundColor White
Write-Host '  ---------------------------------------------'
Write-Host '  1. 保持這個視窗開著（可以縮到最小）'
Write-Host '  2. 用 PowerPoint 打開你的簡報'
Write-Host '  3. 在瀏覽器打開 https://huangchiyu.com/PPT-Web/'
Write-Host '     選「用 PowerPoint 放映」'
Write-Host '  要結束時直接關掉這個視窗，或按 Ctrl+C。'
Write-Host ''
Write-Status "等待網頁連線（127.0.0.1:$Port）…"

try {
    $pending = $listener.GetContextAsync()
    $client = $null
    while ($true) {
        if (-not $client) {
            if (-not $pending.Wait(500)) { continue }
            $client = Open-Client $pending.Result
            $pending = $listener.GetContextAsync()
            continue
        }
        try {
            $client = Serve-Client $client $listener ([ref]$pending)
        } catch {
            $reason = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
            Write-Status "連線中斷：$reason" Yellow
            $client = $null
        }
        # 沒有網頁連著時放掉 PowerPoint 的參照，使用者才能正常關掉 PowerPoint
        if (-not $client) { Clear-PowerPoint }
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Clear-PowerPoint
}
