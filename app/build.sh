#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# ============================================================================
# FreeCoffee demo build pipeline
#
#  1. universal binary  xcrun swiftc -target arm64-apple-macos13.0 + -target x86_64-apple-macos13.0
#                        → lipo (falls back to host-only swiftc when the SDK or one
#                        arch toolchain is unavailable, e.g. bare CI images)
#  2. icons             python3 makeicon.py + iconutil  → AppIcon.icns
#  3. app bundle        dist/FreeCoffee.app (binary + icns + heredoc Info.plist,
#                       linted with plutil)
#  4. ad-hoc codesign   codesign --force --deep --sign - dist/FreeCoffee.app
#  5. DMG               staging dir with FreeCoffee.app + /Applications
#                       symlink → hdiutil create -volname FreeCoffee -format UDZO
#  6. artifact sizes + sha256
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

APP_VERSION="1.1.0"
APP_BUILD="2"

echo "==> [1/6] Compiling universal binary (arm64 + x86_64)"
BUILT_UNIVERSAL=0
if command -v xcrun >/dev/null 2>&1; then
  if xcrun -sdk macosx swiftc -O -target arm64-apple-macos13.0 FreeCoffeeMenuBar.swift -o /tmp/fc_arm64 \
     && xcrun -sdk macosx swiftc -O -target x86_64-apple-macos13.0 FreeCoffeeMenuBar.swift -o /tmp/fc_x64 \
     && lipo -create -output FreeCoffeeMenuBar /tmp/fc_arm64 /tmp/fc_x64; then
    echo "Built universal: $(pwd)/FreeCoffeeMenuBar ($(lipo -info FreeCoffeeMenuBar 2>/dev/null || echo universal))"
    BUILT_UNIVERSAL=1
  else
    echo "WARNING: dual-arch compile failed (see errors above) — falling back to host-only swiftc" >&2
  fi
  rm -f /tmp/fc_arm64 /tmp/fc_x64
fi
if [ "$BUILT_UNIVERSAL" = "0" ]; then
  if command -v xcrun >/dev/null 2>&1; then
    xcrun -sdk macosx swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar \
      || swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar
  else
    swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar
  fi
  echo "Built (host arch): $(pwd)/FreeCoffeeMenuBar"
fi

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
	<string>__FC_VERSION__</string>
	<key>CFBundleVersion</key>
	<string>__FC_BUILD__</string>
	<key>LSUIElement</key>
	<true/>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>NSHumanReadableCopyright</key>
	<string>Demo — simulated data. No real campaigns, no real payouts.</string>
	<key>CFBundleExecutable</key>
	<string>FreeCoffeeMenuBar</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
PLIST
# Version placeholders (quoted heredoc → real tabs preserved): expand after write.
sed -i '' -e "s/__FC_VERSION__/${APP_VERSION}/g" -e "s/__FC_BUILD__/${APP_BUILD}/g" dist/FreeCoffee.app/Contents/Info.plist
plutil -lint dist/FreeCoffee.app/Contents/Info.plist

echo "==> [4/6] Ad-hoc codesigning dist/FreeCoffee.app"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - dist/FreeCoffee.app
else
  echo "WARNING: codesign not found — leaving dist/FreeCoffee.app unsigned" >&2
fi

echo "==> [5/6] Building dist/FreeCoffee.dmg (UDZO, with /Applications link)"
rm -f dist/FreeCoffee.dmg
rm -rf /tmp/fc-dmg-staging
mkdir -p /tmp/fc-dmg-staging
cp -R dist/FreeCoffee.app /tmp/fc-dmg-staging/
ln -s /Applications /tmp/fc-dmg-staging/Applications
hdiutil create -volname FreeCoffee -srcfolder /tmp/fc-dmg-staging -ov -format UDZO dist/FreeCoffee.dmg
rm -rf /tmp/fc-dmg-staging

echo "==> [6/6] Artifacts"
du -sh dist/FreeCoffee.app | awk '{print "  FreeCoffee.app:  " $1 "  (dist/FreeCoffee.app)"}'
ls -l dist/FreeCoffee.dmg | awk '{printf "  FreeCoffee.dmg:  %s bytes\n", $5}'
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 dist/FreeCoffee.dmg | awk '{print "  sha256: " $1}'
fi
if command -v lipo >/dev/null 2>&1; then
  lipo -info dist/FreeCoffee.app/Contents/MacOS/FreeCoffeeMenuBar || true
fi
echo "  -> $(pwd)/dist/FreeCoffee.dmg"
echo "Done."
