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
    'func startSnooze(',
    'func snoozeOff()',
    'private func resetEligibility()',
    'private func observeSleepWake()',
    'private func saveCampaignCache(',
    'private func loadCampaignCache()',
]).replace('@objc private func', 'func').replace('private func', 'func')
methods = methods.replace('NSWorkspace.shared.notificationCenter', 'workspaceCenter')
methods = methods.replace('DistributedNotificationCenter.default()', 'lockCenter')
methods = methods.replace('NotificationCenter.default.addObserver', 'appCenter.addObserver')
program = '''import AppKit
private typealias AppDelegate = Harness
'''
program += block('private struct DemoEligibility') + '\n'
program += block('private struct DemoAccrual: Codable') + '\n'
program += block('private struct FreeCoffeeState: Codable') + '\n'
program += block('private func dayKey(') + '\n'
program += block('private func restOfDayDeadline(') + '\n'
program += block('private struct LiveCampaign: Codable') + '\n'
program += block('private struct CampaignCache: Codable') + '\n'
program += '''
private final class Harness {
    var eligibility = DemoEligibility()
    var demoEligible = false
    var isAwake = true
    var displaysAwake = true
    var sessionActive = true
    var screenLocked = false
    var eligibilityObservers: [NSObjectProtocol] = []
    let workspaceCenter = NotificationCenter()
    let lockCenter = NotificationCenter()
    let appCenter = NotificationCenter()
    var demoAccrual = DemoAccrual()
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
private let eligible = DemoEligibility.Conditions()
private var gate = DemoEligibility()
for t in 0..<60 { precondition(!gate.sample(at: Double(t), conditions: eligible)) }
precondition(gate.sample(at: 60, conditions: eligible))
precondition(!gate.sample(at: 60, conditions: eligible))
for t in 61..<120 { precondition(!gate.sample(at: Double(t), conditions: eligible)) }
precondition(gate.sample(at: 120, conditions: eligible))
for change in 0..<14 {
    gate.reset()
    for t in 0..<60 { precondition(!gate.sample(at: Double(t), conditions: eligible)) }
    var blocked = eligible
    switch change {
    case 0: blocked.paused = true
    case 1: blocked.disabled = true
    case 2: blocked.snoozed = true
    case 3: blocked.awake = false
    case 4: blocked.unlocked = false
    case 5: blocked.idleSeconds = 300.001
    case 6: blocked.placementVisible = false
    case 7: blocked.demo = false
    case 8: blocked.creative = "changed"
    case 9: blocked.creative = nil
    case 10: blocked.idleSeconds = nil
    case 11: blocked.idleSeconds = .nan
    case 12: blocked.idleSeconds = -1
    default: blocked.creative = ""
    }
    precondition(!gate.sample(at: 60, conditions: blocked))
    for t in 61..<121 { precondition(!gate.sample(at: Double(t), conditions: eligible)) }
    precondition(gate.sample(at: 121, conditions: eligible))
}
private var boundary = eligible
boundary.idleSeconds = 300
precondition(boundary.eligible)
gate.reset()
precondition(!gate.sample(at: 0, conditions: eligible))
precondition(!gate.sample(at: 3600, conditions: eligible))
precondition(!gate.sample(at: 0, conditions: eligible))
precondition(!gate.sample(at: .nan, conditions: eligible))
precondition(gate.startedAt == nil)
private var restoredGate = DemoEligibility()
precondition(!restoredGate.sample(at: 100_000, conditions: eligible))
private var accrual = DemoAccrual()
private let date = Date(timeIntervalSince1970: 1_700_000_000)
private var cents = 0
for _ in 0..<1000 { cents += accrual.credit(on: date).balance }
precondition(cents == 160 && accrual.balanceRemainder == 0)
private var fractional = DemoAccrual()
for _ in 0..<6 { precondition(fractional.credit(on: date).balance == 0) }
private let encoded = try JSONEncoder().encode(fractional)
fractional = try JSONDecoder().decode(DemoAccrual.self, from: encoded)
precondition(fractional.credit(on: date).balance == 1)
private let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: date)!
precondition(fractional.credit(on: tomorrow).today == 0 && fractional.dayRemainder == 1600)
private let legacy = try JSONDecoder().decode(FreeCoffeeState.self, from: Data("{}".utf8))
precondition(legacy.demoAccrual.balanceRemainder == 0)
private var cal = Calendar(identifier: .gregorian)
cal.timeZone = TimeZone(identifier: "America/Los_Angeles")!
for (month, day, hours) in [(3, 8, 23), (11, 1, 25)] {
    let start = cal.date(from: DateComponents(year: 2026, month: month, day: day))!
    let end = restOfDayDeadline(from: start, calendar: cal)!
    precondition(end.timeIntervalSince(start) == Double(hours * 3600))
    precondition(cal.component(.hour, from: end) == 0)
}
print("PASS: production gate boundaries, interruptions, clock gaps, no catch-up; $2 CPM fractional persistence; DST snooze")
private func prime() {
    h.eligibility.reset()
    for t in 0..<60 { precondition(!h.eligibility.sample(at: Double(t), conditions: eligible)) }
    h.demoEligible = true
}
private func assertReset() {
    precondition(h.eligibility.startedAt == nil && !h.demoEligible)
    for t in 60..<120 { precondition(!h.eligibility.sample(at: Double(t), conditions: eligible)) }
    precondition(h.eligibility.sample(at: 120, conditions: eligible))
}
h.observeSleepWake()
_ = h.demoAccrual.credit(on: Date())
private let earnedCredit = h.demoAccrual.balanceRemainder
precondition(earnedCredit == 1600)
for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
    prime()
    h.workspaceCenter.post(name: name, object: nil)
    precondition(h.isAwake == (name == NSWorkspace.didWakeNotification))
    precondition(h.demoAccrual.balanceRemainder == earnedCredit,
                 "Sleep/wake must preserve credit from completed intervals")
    assertReset()
}
print("PASS: production observeSleepWake resets unfinished interval and preserves earned credit")
prime()
h.togglePause(item)
assertReset()
prime()
h.disableToggled()
assertReset()
prime()
h.startSnooze(minutes: 30)
precondition(h.snoozeUntil != nil)
assertReset()
prime()
h.snoozeOff()
precondition(h.snoozeUntil == nil && h.paused)
assertReset()
h.disabled = false
h.paused = false
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
