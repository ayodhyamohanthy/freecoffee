#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# ============================================================================
# FreeCoffee demo build pipeline
#
#  0. preflight         required tools + a real `swiftc --version` invocation
#  1. universal binary  xcrun swiftc -target arm64-apple-macos13.0 + -target x86_64-apple-macos13.0
#                       → lipo (falls back to host-only swiftc when the SDK or one
#                       arch toolchain is unavailable, e.g. bare CI images)
#  2. icons             python3 makeicon.py + iconutil  → AppIcon.icns
#  3. app bundle        $STAGE/FreeCoffee.app (binary + icns + heredoc Info.plist,
#                       version stamped with plutil, linted with plutil)
#  4. ad-hoc codesign   codesign --force --sign -   (no --deep: deprecated)
#  5. DMG               staging dir with FreeCoffee.app + /Applications
#                       symlink → hdiutil create -volname FreeCoffee -format UDZO
#  6. verify            hdiutil verify + mount → bundle present, version matches
#                       the stamp, signature valid → detach
#  7. publish           only now is dist/ touched (rename, not delete+write)
#                       + artifact sizes and sha256
#
# --- WHY EVERYTHING IS BUILT IN A STAGING DIR (regression note) -------------
# This script used to `rm -rf dist/FreeCoffee.app dist/FreeCoffee.dmg` at the
# top of step 3 and then stamp the Info.plist with `sed -i ''`. Two problems:
#
#   * `sed -i ''` is BSD/macOS-only. Under GNU sed, busybox or toybox — i.e.
#     Linux, most CI images, and any shimmed/sandboxed shell — the empty
#     argument is parsed as an input *filename*, so sed dies with
#     `sed: : No such file or directory`, exits non-zero, and `set -e` aborts
#     the whole script at step 3. The DMG is never created.
#   * Because the previous artifacts had already been deleted at the top of
#     that same step, the abort left you with NO dmg at all — so a single
#     portability failure silently destroyed the last good release artifact.
#
# Now: build into $STAGE, verify, publish last. A failure at any step leaves
# the previously built dist/FreeCoffee.dmg exactly where it was. The version
# is stamped with `plutil -replace`, which ships with macOS and needs no sed.
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

APP_VERSION="1.1.1"
APP_BUILD="3"

DIST="dist"
BUNDLE="FreeCoffee.app"
DMG="FreeCoffee.dmg"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- 0. preflight
echo "==> [0/7] Preflight"
MISSING=""
for tool in iconutil hdiutil plutil python3 codesign lipo; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  fail "missing required tool(s):$MISSING
       Install the Xcode command-line tools:  xcode-select --install"
fi
if ! xcrun -sdk macosx swiftc --version >/dev/null 2>&1; then
  fail "no usable Swift compiler.
       Install the Xcode command-line tools:  xcode-select --install
       (or the full Xcode from the App Store)"
fi
echo "    swift:  $(xcrun -sdk macosx swiftc --version 2>/dev/null | head -1)"
echo "    sdk:    $(xcrun --show-sdk-path)"

# Everything is built here and only moved into dist/ once it is verified.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/freecoffee-build.XXXXXX")"
MOUNTED=0
cleanup() {
  [ "$MOUNTED" = "1" ] && hdiutil detach "$STAGE/verify" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT
echo "    staging: $STAGE"

# ------------------------------------------------------- 1. universal binary
echo "==> [1/7] Compiling universal binary (arm64 + x86_64)"
BINARY="$STAGE/FreeCoffeeMenuBar"
BUILT_UNIVERSAL=0
if xcrun -sdk macosx swiftc -O -target arm64-apple-macos13.0 FreeCoffeeMenuBar.swift -o "$STAGE/fc_arm64" \
   && xcrun -sdk macosx swiftc -O -target x86_64-apple-macos13.0 FreeCoffeeMenuBar.swift -o "$STAGE/fc_x64" \
   && lipo -create -output "$BINARY" "$STAGE/fc_arm64" "$STAGE/fc_x64"; then
  echo "    universal: $(lipo -info "$BINARY" 2>/dev/null || echo universal)"
  BUILT_UNIVERSAL=1
else
  echo "    WARNING: dual-arch compile failed (see errors above) — falling back to host-only swiftc" >&2
fi
rm -f "$STAGE/fc_arm64" "$STAGE/fc_x64"
if [ "$BUILT_UNIVERSAL" = "0" ]; then
  xcrun -sdk macosx swiftc -O FreeCoffeeMenuBar.swift -o "$BINARY" \
    || swiftc -O FreeCoffeeMenuBar.swift -o "$BINARY"
  echo "    host-only: $(lipo -info "$BINARY" 2>/dev/null || echo host)"
fi

# ------------------------------------------------------------------- 2. icons
echo "==> [2/7] Generating icons (python3 stdlib → iconutil)"
python3 makeicon.py
iconutil -c icns FreeCoffee.iconset -o "$STAGE/AppIcon.icns"
echo "    AppIcon.icns: $(du -h "$STAGE/AppIcon.icns" | cut -f1)"

# ------------------------------------------------------------- 3. app bundle
echo "==> [3/7] Assembling $BUNDLE"
APP="$STAGE/$BUNDLE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/FreeCoffeeMenuBar"
cp "$STAGE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
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
# Version stamping — plutil ships with macOS and, unlike `sed -i ''`, is not
# dependent on which sed implementation happens to be first on PATH.
plutil -replace CFBundleShortVersionString -string "$APP_VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$APP_BUILD"   "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"

# --------------------------------------------------------------- 4. codesign
echo "==> [4/7] Ad-hoc codesigning"
# No --deep: deprecated by Apple, and this bundle has no nested code to sign.
codesign --force --sign - "$APP"
codesign --verify --strict "$APP" \
  || fail "the app signature does not verify after signing"
echo "    ad-hoc signature verified"

# -------------------------------------------------------------------- 5. DMG
echo "==> [5/7] Building $DMG (UDZO, with /Applications link)"
DMGROOT="$STAGE/dmgroot"
mkdir -p "$DMGROOT"
cp -R "$APP" "$DMGROOT/"
ln -s /Applications "$DMGROOT/Applications"
hdiutil create -volname FreeCoffee -srcfolder "$DMGROOT" -ov -format UDZO "$STAGE/$DMG"

# ----------------------------------------------------------------- 6. verify
echo "==> [6/7] Verifying $DMG"
hdiutil verify "$STAGE/$DMG" >/dev/null || fail "$DMG failed hdiutil verify"

VERIFY="$STAGE/verify"
mkdir -p "$VERIFY"
hdiutil attach "$STAGE/$DMG" -nobrowse -readonly -mountpoint "$VERIFY" >/dev/null || fail "could not mount $DMG"
MOUNTED=1

[ -x "$VERIFY/$BUNDLE/Contents/MacOS/FreeCoffeeMenuBar" ] \
  || fail "$DMG contains no executable at $BUNDLE/Contents/MacOS/FreeCoffeeMenuBar"
[ -L "$VERIFY/Applications" ] \
  || fail "$DMG is missing the /Applications drag-to-install symlink"

MOUNTED_VERSION="$(plutil -extract CFBundleShortVersionString raw "$VERIFY/$BUNDLE/Contents/Info.plist" 2>/dev/null || true)"
[ "$MOUNTED_VERSION" = "$APP_VERSION" ] \
  || fail "version inside the DMG is '$MOUNTED_VERSION', expected '$APP_VERSION'"

codesign --verify --strict "$VERIFY/$BUNDLE" 2>/dev/null \
  || fail "the app inside the DMG has an invalid signature"

lipo -info "$VERIFY/$BUNDLE/Contents/MacOS/FreeCoffeeMenuBar" 2>/dev/null | grep -q arm64 \
  || fail "the binary inside the DMG is not a universal (arm64) build"

hdiutil detach "$VERIFY" >/dev/null
MOUNTED=0
echo "    mounted check passed: bundle + /Applications link + v$MOUNTED_VERSION + valid signature"

# ----------------------------------------------------------------- 7. publish
echo "==> [7/7] Publishing artifacts"
mkdir -p "$DIST"
# Rename rather than delete-then-write: at no point does dist/ lack an app.
mv "$DIST/$BUNDLE" "$STAGE/previous.app" 2>/dev/null || true
mv "$APP" "$DIST/$BUNDLE"
mv "$STAGE/$DMG" "$DIST/$DMG"
cp "$BINARY" FreeCoffeeMenuBar          # bare dev binary, kept for `./FreeCoffeeMenuBar`
chmod +x FreeCoffeeMenuBar
rm -rf "$DIST/PayBar.app" "$DIST/PayBar.dmg"   # legacy artifact names

du -sh "$DIST/$BUNDLE" | awk '{print "  FreeCoffee.app:  " $1 "  (dist/FreeCoffee.app)"}'
ls -l "$DIST/$DMG" | awk '{printf "  FreeCoffee.dmg:  %s bytes\n", $5}'
DMG_SHA=""
if command -v shasum >/dev/null 2>&1; then
  DMG_SHA=$(shasum -a 256 "$DIST/$DMG" | awk '{print $1}')
  echo "  sha256: $DMG_SHA"
fi
lipo -info "$DIST/$BUNDLE/Contents/MacOS/FreeCoffeeMenuBar" || true

# Release notes template — paste this into the GitHub Release body. The app's
# updater parses the "SHA256: <hex>" line to verify the download, so publishing
# it is what makes checksum-verified auto-updates possible.
if [ -n "$DMG_SHA" ]; then
cat > "$DIST/release-notes.md" <<EOF
FreeCoffee v${APP_VERSION} — menu-bar earnings demo.

**Download:** FreeCoffee.dmg (universal binary, arm64 + x86_64)
SHA256: ${DMG_SHA}

Verify: shasum -a 256 FreeCoffee.dmg
Install: open the DMG and drag FreeCoffee to Applications. Already installed?
The app offers the update on its next launch — or use Check for Updates in its menu.
EOF
echo "  release notes: dist/release-notes.md  (paste into the GitHub Release body)"
fi
echo "  -> $(pwd)/$DIST/$DMG"
echo "Done."
