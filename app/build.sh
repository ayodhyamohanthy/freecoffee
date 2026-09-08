#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# ============================================================================
# FreeCoffee demo build pipeline
#
#  1. bare dev binary   swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar
#  2. icons             python3 makeicon.py + iconutil  → AppIcon.icns
#  3. app bundle        dist/FreeCoffee.app (binary + icns + heredoc Info.plist,
#                       linted with plutil)
#  4. ad-hoc codesign   codesign --force --deep --sign - dist/FreeCoffee.app
#  5. DMG               hdiutil create -volname FreeCoffee -format UDZO
#  6. artifact sizes
#
# --- ICON GENERATION PATH (which approach actually works) ------------------
# Chosen: app/makeicon.py — a pure python3-stdlib generator (zlib/struct PNG
# writer + analytic anti-aliased rasterizer, no Pillow, no network). It runs
# reliably on stock macOS python3 and produces icon_1024.png, every
# FreeCoffee.iconset size, and the PWA icons in assets/icons/. iconutil then
# packs the iconset into AppIcon.icns.
# The documented fallback — a tiny icongen.swift rendering each iconset PNG
# via CoreGraphics, compiled here by swiftc — was NOT needed and is therefore
# not shipped. If makeicon.py ever fails, check `python3 --version` first
# (macOS ships it via the Xcode command-line tools).
# ============================================================================

echo "==> [1/6] Compiling bare dev binary (swiftc -O)"
swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar
echo "Built: $(pwd)/FreeCoffeeMenuBar"

echo "==> [2/6] Generating icons (python3 stdlib → iconutil)"
python3 makeicon.py
rm -f AppIcon.icns
iconutil -c icns FreeCoffee.iconset -o AppIcon.icns
echo "Built: $(pwd)/AppIcon.icns"

echo "==> [3/6] Assembling dist/FreeCoffee.app"
rm -rf dist/FreeCoffee.app dist/FreeCoffee.dmg dist/PayBar.app dist/PayBar.dmg
mkdir -p dist/FreeCoffee.app/Contents/MacOS dist/FreeCoffee.app/Contents/Resources
cp FreeCoffeeMenuBar dist/FreeCoffee.app/Contents/MacOS/FreeCoffeeMenuBar
cp AppIcon.icns dist/FreeCoffee.app/Contents/Resources/AppIcon.icns
cat > dist/FreeCoffee.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.freecoffee.demo.menubar</string>
	<key>CFBundleName</key>
	<string>FreeCoffee</string>
	<key>CFBundleDisplayName</key>
	<string>FreeCoffee</string>
	<key>CFBundleShortVersionString</key>
	<string>2.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSUIElement</key>
	<true/>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>NSHumanReadableCopyright</key>
	<string>Demo — not affiliated with SponsorBar or KickBot Inc.</string>
	<key>CFBundleExecutable</key>
	<string>FreeCoffeeMenuBar</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
PLIST
plutil -lint dist/FreeCoffee.app/Contents/Info.plist

echo "==> [4/6] Ad-hoc codesigning dist/FreeCoffee.app"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - dist/FreeCoffee.app
else
  echo "WARNING: codesign not found — leaving dist/FreeCoffee.app unsigned" >&2
fi

echo "==> [5/6] Building dist/FreeCoffee.dmg (UDZO)"
rm -f dist/FreeCoffee.dmg
hdiutil create -volname FreeCoffee -srcfolder dist/FreeCoffee.app -ov -format UDZO dist/FreeCoffee.dmg

echo "==> [6/6] Artifacts"
du -sh dist/FreeCoffee.app | awk '{print "  FreeCoffee.app:  " $1 "  (dist/FreeCoffee.app)"}'
ls -l dist/FreeCoffee.dmg | awk '{printf "  FreeCoffee.dmg:  %s\n", $5}'
echo "  -> $(pwd)/dist/FreeCoffee.dmg"
echo "Done."
