#!/bin/bash
# 編譯 Mac 版橋接程式，輸出 tools/mac-bridge/build/PPT-Web Bridge.app 和 PPT-Web-Bridge-Mac.zip，
# zip 也會複製到 public/tools/，npm run dev 時網站就能下載。
#
# 需要 Xcode 或 Command Line Tools（沒有的話執行 xcode-select --install）。
#   bash tools/mac-bridge/build.sh              只編這台 Mac 的架構
#   bash tools/mac-bridge/build.sh --universal  同時編 Apple 晶片和 Intel 版（GitHub Actions 用）
#
# 用的是 ad-hoc 簽章，不是 Apple 的開發者簽章：從網路下載的 zip 第一次打開時，
# 要到「系統設定 → 隱私權與安全性」按「強制打開」。
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo "請在 Mac 上執行。" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/build"
APP="$OUT/PPT-Web Bridge.app"
ZIP="$OUT/PPT-Web-Bridge-Mac.zip"
MIN_MACOS=11.0

if [ "${1:-}" = --universal ]; then
  ARCHS="arm64 x86_64"
else
  ARCHS="$(uname -m)"
fi

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS"
SDK="$(xcrun --sdk macosx --show-sdk-path)"

BINARIES=()
for ARCH in $ARCHS; do
  echo "編譯 $ARCH…"
  xcrun swiftc -swift-version 5 -O \
    -sdk "$SDK" -target "$ARCH-apple-macosx$MIN_MACOS" \
    -module-cache-path "$OUT/module-cache" \
    "$HERE"/Sources/*.swift \
    -o "$OUT/PPTWebBridge-$ARCH"
  BINARIES+=("$OUT/PPTWebBridge-$ARCH")
done
lipo -create "${BINARIES[@]}" -output "$APP/Contents/MacOS/PPTWebBridge"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --sign - --options runtime --entitlements "$HERE/Entitlements.plist" "$APP"
codesign --verify --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent "PPT-Web Bridge.app" "$(basename "$ZIP")")
mkdir -p "$ROOT/public/tools"
cp "$ZIP" "$ROOT/public/tools/"

echo ""
echo "完成：$APP"
echo "下載用的 zip：$ROOT/public/tools/$(basename "$ZIP")"
