#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# FreeCoffee menubar app builder — single command, no Xcode project.
#
#   ./build.sh          → ./FreeCoffeeMenuBar (bare dev binary)
#                         ./dist/FreeCoffee.app
#                         ./dist/FreeCoffee.dmg
#
# Pipeline: swiftc build (universal arm64+x86_64) → icon → .app bundle →
# ad-hoc codesign → hdiutil DMG. Needs only the macOS command-line tools
# (xcode-select --install). $0 distribution: ad-hoc signing, no Apple fee.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="FreeCoffee"
DIST="dist"
rm -rf "$DIST" "$APP_NAME" FreeCoffeeMenuBar
mkdir -p "$DIST"

echo "① swiftc build (universal: arm64 + x86_64)…"
if xcrun -sdk macosx swiftc -O -arch arm64 FreeCoffeeMenuBar.swift -o fc_arm64 2>/dev/null \
   && xcrun -sdk macosx swiftc -O -arch x86_64 FreeCoffeeMenuBar.swift -o fc_x64 2>/dev/null \
   && lipo -create -output "$APP_NAME" fc_arm64 fc_x64 2>/dev/null; then
  echo "   universal binary ✓"
else
  echo "   (multi-arch toolchain unavailable — building for the host architecture)"
  xcrun -sdk macosx swiftc -O FreeCoffeeMenuBar.swift -o "$APP_NAME" \
    || swiftc -O FreeCoffeeMenuBar.swift -o "$APP_NAME"
fi
rm -f fc_arm64 fc_x64

echo "② icon (AppIcon.icns from the cup glyph)…"
cat > /tmp/fc_make_icon.swift <<'SWIFT'
import AppKit
let img = NSImage(size: NSSize(width: 512, height: 512))
img.lockFocus()
let bg = NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 448, height: 448), xRadius: 96, yRadius: 96)
NSColor(calibratedRed: 0.878, green: 0.663, blue: 0.243, alpha: 1).setFill() // #E0A93E
bg.fill()
let para = NSMutableParagraphStyle(); para.alignment = .center
let s = NSAttributedString(string: "☕", attributes: [.font: NSFont.systemFont(ofSize: 300), .paragraphStyle: para])
s.draw(in: NSRect(x: 0, y: 96, width: 512, height: 340))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
SWIFT
swiftc -O /tmp/fc_make_icon.swift -o /tmp/fc_make_icon 2>/dev/null \
  || echo "   (icon tool unavailable — continuing without icns)"
if [ -x /tmp/fc_make_icon ]; then
  mkdir -p AppIcon.iconset
  for sz in 16 32 128 256 512; do
    /tmp/fc_make_icon "AppIcon.iconset/icon_${sz}x${sz}.png" || true
    cp "AppIcon.iconset/icon_${sz}x${sz}.png" "AppIcon.iconset/icon_${sz}x${sz}@2x.png" 2>/dev/null || true
  done
  iconutil -c icns AppIcon.iconset -o AppIcon.icns 2>/dev/null || echo "   (iconutil unavailable — continuing without icns)"
fi

echo "③ .app bundle…"
CONTENTS="$DIST/$APP_NAME.app/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$APP_NAME" "$CONTENTS/MacOS/$APP_NAME"
[ -f AppIcon.icns ] && cp AppIcon.icns "$CONTENTS/Resources/AppIcon.icns"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>                 <string>FreeCoffee</string>
    <key>CFBundleDisplayName</key>          <string>FreeCoffee</string>
    <key>CFBundleIdentifier</key>           <string>tech.freecoffee.menubar</string>
    <key>CFBundleVersion</key>              <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>   <string>1.0.0</string>
    <key>CFBundleExecutable</key>           <string>FreeCoffee</string>
    <key>CFBundleIconFile</key>             <string>AppIcon</string>
    <key>CFBundlePackageType</key>          <string>APPL</string>
    <key>LSUIElement</key>                  <true/>
    <key>LSMinimumSystemVersion</key>       <string>13.0</string>
    <key>NSHumanReadableCopyright</key>     <string>MIT © FreeCoffee — freecoffee.tech</string>
</dict>
</plist>
PLIST

echo "④ ad-hoc codesign…"
codesign --force --deep --sign - "$DIST/$APP_NAME.app" 2>/dev/null || echo "   (codesign unavailable — continuing)"

echo "⑤ DMG…"
hdiutil create -volname "FreeCoffee" -srcfolder "$DIST/$APP_NAME.app" -ov -format UDZO "$DIST/FreeCoffee.dmg" >/dev/null

echo ""
echo "✅ Done:"
echo "   ./$APP_NAME                    ← bare dev run (☕ appears in the menu bar)"
echo "   $DIST/$APP_NAME.app"
echo "   $DIST/FreeCoffee.dmg"
