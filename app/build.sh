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
#  4. codesign          ad-hoc by default (free, Gatekeeper asks once);
#                       Developer ID + hardened runtime when FC_DEVELOPER_ID
#                       is set, notarized + stapled in step 5 (zero dialogs)
#  5. DMG               dmgroot (app + /Applications link + baked drag-cue
#                       background + volume icon) → writable UDRW → Finder
#                       layout via AppleScript → compressed UDZO. Headless
#                       runners have no Finder to script, so any polish
#                       failure falls back to the plain UDZO one-liner.
#  6. verify            hdiutil verify + mount → bundle present, version matches
#                       the stamp, signature valid, layout reported → detach
#  7. publish           only now is dist/ touched (rename, not delete+write)
#                       + artifact sizes and sha256 + PWA lockstep (ASSET_V
#                       tracks the DMG version so the web app never lags)
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

APP_VERSION="1.2.3"
APP_BUILD="15"

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
  hdiutil detach "$STAGE/FreeCoffee" >/dev/null 2>&1 || true
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
echo "==> [4/7] Codesigning"
# Two modes. Default is ad-hoc (free): Gatekeeper asks once via right-click
# Open / Open Anyway, then never again. When FC_DEVELOPER_ID names a paid
# "Developer ID Application" identity, sign with the hardened runtime plus a
# trusted timestamp instead — step 5 then notarizes the DMG, which is what
# makes Gatekeeper pass with zero dialogs. Without the $99/yr Apple Developer
# membership that identity does not exist, so ad-hoc stays the default.
SIGN_IDENTITY="${FC_DEVELOPER_ID:-}"
if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
  SIGNED_MODE="developer-id"
else
  # No --deep: deprecated by Apple, and this bundle has no nested code to sign.
  codesign --force --sign - "$APP"
  SIGNED_MODE="ad-hoc"
fi
codesign --verify --strict "$APP" \
  || fail "the app signature does not verify after signing"
echo "    signature verified ($SIGNED_MODE)"

# -------------------------------------------------------------------- 5. DMG
echo "==> [5/7] Building $DMG (UDZO, polished Finder layout + /Applications link)"
DMGROOT="$STAGE/dmgroot"
mkdir -p "$DMGROOT/.background"
cp -R "$APP" "$DMGROOT/"
ln -s /Applications "$DMGROOT/Applications"
cp "$STAGE/AppIcon.icns" "$DMGROOT/.VolumeIcon.icns"

# Polished-dmg background: baked "drag to Applications" caption + gold arrow,
# rendered with AppKit (stock macOS, same toolchain as the app itself).
# No Pillow, no network, no checked-in binary assets.
cat > "$STAGE/renderbg.swift" <<'SWIFT'
import AppKit
import Foundation

// Window content is 600x400pt; the PNG is rendered at 2x for crisp Retina
// text (1200x800 logical; lockFocus may rasterize it at display scale).
let W = 1200, H = 800
// AppKit's lockFocus origin is bottom-left; ty() converts top-down coords.
func ty(_ y: CGFloat, _ h: CGFloat = 0) -> CGFloat { return CGFloat(H) - y - h }

guard CommandLine.arguments.count > 1 else { exit(1) }
let outPath = CommandLine.arguments[1]

let img = NSImage(size: NSSize(width: W, height: H))
img.lockFocus()

NSColor(red: 0xF7/255.0, green: 0xF6/255.0, blue: 0xF3/255.0, alpha: 1.0).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: W, height: H)).fill()

let caption = "Drag FreeCoffee to Applications to install" as NSString
let font = NSFont.systemFont(ofSize: 42, weight: .semibold)
let fg = NSColor(red: 0x1C/255.0, green: 0x1B/255.0, blue: 0x1A/255.0, alpha: 1.0)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fg]
let ts = caption.size(withAttributes: attrs)
caption.draw(at: NSPoint(x: (CGFloat(W) - ts.width) / 2.0, y: ty(118, ts.height)),
             withAttributes: attrs)

let sub = "FreeCoffee demo \u{2014} simulated data" as NSString
let subFont = NSFont.systemFont(ofSize: 27)
let subFg = NSColor(red: 0x71/255.0, green: 0x71/255.0, blue: 0x7A/255.0, alpha: 1.0)
let subAttrs: [NSAttributedString.Key: Any] = [.font: subFont, .foregroundColor: subFg]
let ss = sub.size(withAttributes: subAttrs)
sub.draw(at: NSPoint(x: (CGFloat(W) - ss.width) / 2.0, y: ty(172, ss.height)),
         withAttributes: subAttrs)

// Gold arrow between the icons (app center ~300px, Applications ~900px).
let gold = NSColor(red: 0xE0/255.0, green: 0xA9/255.0, blue: 0x3E/255.0, alpha: 1.0)
gold.setFill()
let ay: CGFloat = ty(430)
let x0: CGFloat = 470, x1: CGFloat = 700, thick: CGFloat = 20
NSBezierPath(roundedRect: NSRect(x: x0, y: ay - thick / 2, width: x1 - x0, height: thick),
             xRadius: thick / 2, yRadius: thick / 2).fill()
let head = NSBezierPath()
head.move(to: NSPoint(x: 775, y: ay))
head.line(to: NSPoint(x: x1 - 10, y: ay - 52))
head.line(to: NSPoint(x: x1 - 10, y: ay + 52))
head.close()
head.fill()

img.unlockFocus()
guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { exit(2) }
do {
    try Data(png).write(to: URL(fileURLWithPath: outPath))
} catch {
    fputs("renderbg: write failed\n", stderr)
    exit(3)
}
SWIFT
BG_OK=0
if xcrun -sdk macosx swiftc -O "$STAGE/renderbg.swift" -o "$STAGE/renderbg" -framework AppKit 2>/dev/null \
   && "$STAGE/renderbg" "$DMGROOT/.background/background.png" 2>/dev/null \
   && [ -s "$DMGROOT/.background/background.png" ]; then
  BG_OK=1
  echo "    background: baked drag-cue caption + arrow"
else
  echo "    WARNING: background render failed — continuing without it" >&2
  rm -rf "$DMGROOT/.background"
fi

# Two-stage image: writable UDRW → Finder layout via AppleScript → UDZO.
# polish_dmg must only ever `return 1` on failure (never exit/fail), so the
# caller can fall back to the plain image. It runs as an `if` condition, in
# which context `set -e` is suspended — every step still guards explicitly.
polish_dmg() {
  hdiutil create -volname FreeCoffee -srcfolder "$DMGROOT" -fs HFS+ \
    -format UDRW -ov "$STAGE/rw.dmg" >/dev/null || return 1
  # Never touch the user's mounts: if anything is already sitting at the
  # canonical mountpoint, addressing `disk "FreeCoffee"` would be ambiguous,
  # so skip the polish and ship the plain image instead.
  if [ -e "/Volumes/FreeCoffee" ]; then
    echo "    WARNING: /Volumes/FreeCoffee already mounted — skipping Finder polish" >&2
    return 1
  fi
  # Finder names an attached disk after its mountpoint folder (not the volume
  # name), so mount at a folder literally called FreeCoffee — otherwise
  # `disk "FreeCoffee"` fails with -1728 and no layout is ever applied.
  MNT="$STAGE/FreeCoffee"
  mkdir -p "$MNT"
  hdiutil attach "$STAGE/rw.dmg" -nobrowse -mountpoint "$MNT" >/dev/null || return 1
  BG_LINE=""
  if [ "$BG_OK" = "1" ]; then
    BG_LINE="set background picture of viewOptions to (POSIX file \"$MNT/.background/background.png\" as alias)"
  fi
  cat > "$STAGE/polish.scpt" <<SCPT
tell application "Finder"
  set theDisk to disk "FreeCoffee"
  open theDisk
  delay 2
  set wc to container window of theDisk
  set current view of wc to icon view
  set toolbar visible of wc to false
  set statusbar visible of wc to false
  set bounds of wc to {100, 100, 700, 500}
  set viewOptions to icon view options of wc
  tell viewOptions
    set arrangement to not arranged
    set icon size to 128
    set text size to 16
    $BG_LINE
  end tell
  delay 1
  set position of item "FreeCoffee.app" of theDisk to {150, 205}
  set position of item "Applications" of theDisk to {450, 205}
  delay 1
  close wc
  delay 1
  open theDisk
  delay 2
end tell
SCPT
  osascript "$STAGE/polish.scpt" >/dev/null || return 1
  SetFile -a C "$MNT" >/dev/null 2>&1 || true
  [ "$BG_OK" = "1" ] && SetFile -a V "$MNT/.background" >/dev/null 2>&1 || true
  SetFile -a V "$MNT/.VolumeIcon.icns" >/dev/null 2>&1 || true
  rm -rf "$MNT/.fseventsd" "$MNT/.Trashes" >/dev/null 2>&1 || true
  bless --folder "$MNT" --openfolder "$MNT" >/dev/null 2>&1 || true
  sync
  sleep 1
  hdiutil detach "$MNT" >/dev/null || { sleep 2; hdiutil detach "$MNT" >/dev/null || return 1; }
  hdiutil convert "$STAGE/rw.dmg" -format UDZO -imagekey zlib-level=9 \
    -o "$STAGE/$DMG" >/dev/null || return 1
  return 0
}

POLISHED=0
if polish_dmg; then
  POLISHED=1
  echo "    polished layout: 600x400 window, placed icons, drag-cue background, volume icon"
else
  echo "    WARNING: Finder polish unavailable — shipping plain UDZO (app + /Applications link)" >&2
  hdiutil detach "$STAGE/FreeCoffee" >/dev/null 2>&1 || true
  hdiutil create -volname FreeCoffee -srcfolder "$DMGROOT" -ov -format UDZO "$STAGE/$DMG"
fi
rm -f "$STAGE/rw.dmg"

# -------------------------------------------- 5b. notarize (Developer ID only)
# Skipped entirely for ad-hoc builds. When step 4 signed with a Developer ID
# identity, the DMG must carry Apple's ticket or Gatekeeper still blocks it.
# Credentials come from the environment (never committed — see Info-howto.md):
#   FC_DEVELOPER_ID  "Developer ID Application: Name (TEAMID)" (step 4)
#   FC_APPLE_ID      Apple ID email enrolled in the Developer Program
#   FC_APP_PASSWORD  app-specific password (appleid.apple.com → Security)
#   FC_TEAM_ID       10-character team ID
# The ticket is stapled to the DMG, so offline Macs pass Gatekeeper too.
if [ "$SIGNED_MODE" = "developer-id" ]; then
  : "${FC_APPLE_ID:?set FC_APPLE_ID (Apple ID email) to notarize}"
  : "${FC_APP_PASSWORD:?set FC_APP_PASSWORD (app-specific password) to notarize}"
  : "${FC_TEAM_ID:?set FC_TEAM_ID to notarize}"
  echo "==> [5/7] Notarizing $DMG (notarytool --wait, then staple)"
  xcrun notarytool submit "$STAGE/$DMG" --apple-id "$FC_APPLE_ID" \
    --password "$FC_APP_PASSWORD" --team-id "$FC_TEAM_ID" --wait \
    || fail "notarization failed — see the notarytool log URL above"
  xcrun stapler staple "$STAGE/$DMG" \
    || fail "could not staple the notarization ticket to $DMG"
  xcrun stapler validate "$STAGE/$DMG" \
    || fail "stapled ticket does not validate"
  echo "    notarized + stapled"
fi

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

LIPO_INFO="$(lipo -info "$VERIFY/$BUNDLE/Contents/MacOS/FreeCoffeeMenuBar" 2>/dev/null || true)"
case "$LIPO_INFO" in *arm64*) : ;; *)
  fail "the binary inside the DMG has no arm64 slice ($LIPO_INFO)" ;; esac
case "$LIPO_INFO" in *x86_64*) : ;; *)
  # An arm64-only fallback must never ship as "universal" — refuse rather
  # than publish a DMG whose release notes promise arm64 + x86_64.
  fail "the binary inside the DMG is missing the x86_64 slice ($LIPO_INFO)" ;; esac

if [ "$SIGNED_MODE" = "developer-id" ]; then
  spctl -a "$VERIFY/$BUNDLE" \
    || fail "Gatekeeper rejects the notarized app inside the DMG"
  echo "    Gatekeeper: accepted (Developer ID, notarized)"
fi

if [ -f "$VERIFY/.DS_Store" ]; then
  echo "    Finder layout: polished (.DS_Store present)"
else
  echo "    NOTE: plain-fallback DMG (no Finder .DS_Store) — rebuild on a Mac with Finder access for the drag cue" >&2
fi

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

# PWA lockstep: every DMG version bump also busts the installed web app's
# cache, so the PWA can never lag the shipped native app. ASSET_V tracks
# max(stripped APP_VERSION, current ASSET_V) — monotonic, and rebuilding the
# same version is a no-op. Manual web-only bumps (edit sw.js + ?v=, guarded
# by test.sh check 7) keep working: a PWA already ahead of the DMG is left
# alone. python3 rewrites (never `sed -i`: BSD/GNU differ — see step 3 note).
CUR_V="$(python3 -c "import re,sys; m=re.search(r\"var ASSET_V *= *'([0-9]+)'\", open('../sw.js').read()); print(m.group(1) if m else '')")"
DERIVED_V="$(printf '%s' "$APP_VERSION" | tr -cd '0-9')"
if [ -n "$CUR_V" ] && [ -n "$DERIVED_V" ]; then
  if [ "$DERIVED_V" -gt "$CUR_V" ]; then NEW_V="$DERIVED_V"; else NEW_V="$CUR_V"; fi
  if [ "$NEW_V" != "$CUR_V" ]; then
    python3 - "$NEW_V" "$CUR_V" <<'PY'
import glob, re, sys
new_v, cur_v = sys.argv[1], sys.argv[2]
sw = '../sw.js'
src = open(sw, encoding='utf-8').read()
src = src.replace("var ASSET_V = '%s'" % cur_v, "var ASSET_V = '%s'" % new_v)
src = src.replace("'freecoffee-v%s'" % cur_v, "'freecoffee-v%s'" % new_v)
open(sw, 'w', encoding='utf-8').write(src)
n = 0
for f in glob.glob('../*.html'):
    s = open(f, encoding='utf-8').read()
    s2 = re.sub(r'\?v=%s\b' % cur_v, '?v=' + new_v, s)
    if s2 != s:
        open(f, 'w', encoding='utf-8').write(s2)
        n += 1
print('  PWA: ASSET_V %s -> %s (sw.js + %d page(s)) — commit with this build' % (cur_v, new_v, n))
PY
  else
    echo "  PWA: already in sync (ASSET_V=$CUR_V)"
  fi
else
  echo "  WARNING: could not sync PWA version (sw.js ASSET_V unreadable)" >&2
fi

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
