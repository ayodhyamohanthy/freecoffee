#!/bin/bash
# Isolated production-method regression tests. Never launches the shipped app,
# reads Application Support, registers login items, or performs network requests.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/freecoffee-tests.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
python3 - "$APP_DIR/FreeCoffeeMenuBar.swift" "$STAGE/main.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()

def block(marker):
    start = source.index(marker)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

assert 'sendAction(on: [.leftMouseUp, .rightMouseUp])' in source, 'Right-click action routing missing'
# Chip geometry regressions (the "odd looking menu bar" fixes).
assert 'button.frame = f' not in source, \
    'Chip width must go through statusItem.length, never a direct button.frame resize'
assert 'if chipHeadline.isHidden && chipDescription.isHidden {' in source, \
    'Snooze mode must size the pill from its own attributed title'
assert 'statusItem.length = want' in source, 'statusItem.length sizing missing'
assert 'chipTitle(' not in source, \
    'Dead chipTitle() path must stay removed so font sizes cannot drift'
methods = '\n'.join(block(marker) for marker in [
    '@objc private func togglePause(',
    'func disableToggled()',
    'private func saveCampaignCache(',
    'private func loadCampaignCache()',
]).replace('@objc private func', 'func').replace('private func', 'func')
program = '''import Foundation
final class NSMenuItem {}
'''
program += block('private struct LiveCampaign: Codable') + '\n'
program += block('private struct CampaignCache: Codable') + '\n'
program += '''
private final class Harness {
    var disabled = false
    var paused = false
    var snoozeUntil: Date?
    var adFeedURL = URL(string: "https://example.com/feed.json")
    static var cacheURL = URL(fileURLWithPath: CommandLine.arguments[1])
    static func campaignCacheURL() -> URL { cacheURL }
    func sanitizeCampaigns(_ campaigns: [LiveCampaign]) -> [LiveCampaign] { campaigns }
    func refreshUI() {}
    func persist() {}
'''
program += methods + '\n}\n'
program += '''
private let h = Harness()
private let item = NSMenuItem()
// Every combination of disabled/paused must match the menu's displayed action.
for paused in [false, true] {
    h.disabled = true
    h.paused = paused
    h.snoozeUntil = Date().addingTimeInterval(1800)
    h.togglePause(item)
    precondition(!h.disabled && !h.paused && h.snoozeUntil == nil,
                 "Enable earning must clear disabled, pause and snooze")
}
h.togglePause(item)
precondition(h.paused, "Pause earning must pause")
h.togglePause(item)
precondition(!h.paused, "Resume earning must resume")
for paused in [false, true] {
    h.disabled = true
    h.paused = paused
    h.snoozeUntil = Date().addingTimeInterval(1800)
    h.disableToggled()
    precondition(!h.disabled && !h.paused && h.snoozeUntil == nil,
                 "Popover Enable must clear pause and snooze")
}
h.disableToggled()
precondition(h.disabled, "Disable must still disable earning")
// Actual production save/load methods, redirected only to this temporary file.
private let campaigns = [LiveCampaign(id: "fixture", sponsor: "Test sponsor",
    tagline: "Fixture", clickUrl: "https://example.com", cpm: 5,
    logoText: "TS", accent: "#123456")]
h.saveCampaignCache(campaigns)
precondition(h.loadCampaignCache().first?.id == "fixture",
             "ISO-8601 cache must round-trip after relaunch")
h.adFeedURL = URL(string: "https://example.com/other.json")
precondition(h.loadCampaignCache().isEmpty, "Different-feed cache must be rejected")
try Data("not JSON".utf8).write(to: Harness.cacheURL)
precondition(h.loadCampaignCache().isEmpty, "Corrupt cache must fail safely")
print("PASS: right-click wiring; pause/disable/snooze transitions; cache round-trip and rejection")
'''
pathlib.Path(sys.argv[2]).write_text(program)
PY
xcrun swiftc "$STAGE/main.swift" -o "$STAGE/regressions"
"$STAGE/regressions" "$STAGE/campaigns-cache.json"
# Compile production source for both supported architectures without packaging.
xcrun swiftc -typecheck -target arm64-apple-macos13.0 "$APP_DIR/FreeCoffeeMenuBar.swift"
xcrun swiftc -typecheck -target x86_64-apple-macos13.0 "$APP_DIR/FreeCoffeeMenuBar.swift"
echo 'PASS: production Swift typechecks for arm64 and x86_64 (macOS 13+)'
