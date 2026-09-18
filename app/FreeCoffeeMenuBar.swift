/*
 * FreeCoffeeMenuBar.swift
 * =======================
 * FreeCoffee demo — a single-file macOS status area app (AppKit + Foundation only,
 * macOS 13+). Builds with:
 *
 *     swiftc -O FreeCoffeeMenuBar.swift -o FreeCoffeeMenuBar
 *
 * The same file is also compiled into dist/FreeCoffee.app by build.sh. From a
 * bundle it gains a "Launch at Login" toggle (SMAppService, macOS 13+);
 * running as the bare dev binary that menu item shows a disabled state.
 *
 * Interaction model (matches the web reference):
  *   • LEFT-CLICK  the status item → an NSPopover opens with the earnings panel:
  *       header row (brand tile, name + dynamic description line — live
  *       sponsor, "No sponsors available", or demo sponsor — plus an
  *       Advertise-here button when the feed is empty; status dot
  *       "Earning"/"Waiting"),
 *       divider, TOTAL BALANCE block (oversized mono figure + cups hint +
 *       right-aligned available/pending), the caramel "70% base + 10% launch share" boost line (launch bonus
 *       funded by the platform), an "Earnings · 7 days" inset bar chart
 *       (custom NSView, weekday letters M T W T F S S + value labels, drawn
 *       from the persisted day-by-day ledger history), the gray rearrange
 *       tip line, a divider, and a footer with four buttons:
 *       Settings (opens the demo dashboard), Snooze (pause 30 min with a
 *       live countdown), Disable (persisted earning toggle), Account
  *       (opens the demo profile page). Snooze pauses earning for a chosen
  *       duration (30 minutes, 2 hours, or 6 hours) with a live countdown; the
  *       right-click menu carries the same choices as a submenu, plus
  *       "Turn off snooze".
  *   • RIGHT-CLICK the status item → a menu: Sponsor (live feed only — opens
  *       the current campaign's https click URL), Advertise here (feed
  *       configured but empty — opens the advertiser pitch), Pause toggle,
  *       Snooze submenu (30 minutes / 2 hours / 6 hours / Turn off snooze),
  *       Reload campaigns (live feed only), Launch at Login (bundled app
  *       only), About, Quit.
  *
  * NO-SPONSOR BEHAVIOR (the bar is never a dead end):
  *   • No feed configured (demo): the chip rotates fictional demo sponsors
  *     as logo tile + headline (same cast as the web demo), clearly marked
  *     simulated — display only, the earning tick stays the flat demo rate.
  *   • Feed configured but nothing usable (empty feed, all below the floor,
  *     fetch failing on an empty cache): the chip becomes an acquisition
  *     slot, megaphone + "Your brand here", and the popover + menu offer
  *     "Advertise here", opening the public advertiser pitch. The full
  *     description lives in the tooltip on hover and the popover header —
  *     two lines can't fit the Mac status area. Zero earnings impact.
 *
 * SNOOZE SEMANTICS: while snoozed the Mac status area chip reads
 * "☕ FreeCoffee — snoozed until HH:MM", no earning ticks accrue, no live
 * ad rotation happens, and the deadline auto-resumes earning via a
 * Date-based check in the 60 s sponsor timer (plus the 1 s countdown
 * heartbeat). The deadline persists to ledger.json as a snoozeUntil ISO
 * field, so a relaunch mid-snooze resumes (and lifts) correctly.
 *
 * REAL-ADVERTISER BRIDGE (the only network code, opt-in):
 *   If ~/Library/Application Support/FreeCoffee/config.json contains
 *   { "adFeedURL": "https://…" }, the app fetches that HTTPS feed on launch
 *   and every 30 minutes, validates it field-by-field (https-only click
 *   URLs, trimmed/capped strings, cpm clamped 0–100, deduped by id, cap 20
 *   — mirroring assets/js/demo.js → fetchLiveCampaigns), caches the last
 *   good list to campaigns-cache.json, and shows those campaigns in the
 *   Mac status area chip and popover, marked LIVE. Highest bid wins: the shown
 *   list is pickAd(campaigns, minCPM) — sorted cpm DESC (ties by id ASC),
 *   and campaigns below the optional config.json "minCPM" floor (default 0)
 *   are filtered out entirely. Any failure falls back to the fictional
 *   demo sponsors. No identifiers or telemetry are sent — the configured
 *   feed URL is the one outbound request the user opts into.
 *
 * UPDATER (the only other network code — anonymous, one-way):
 *   On launch and every 6 hours the app asks the public GitHub Releases
 *   API "what is the latest published release?" — a plain GET of
  *   https://api.github.com/repos/ayodhyamohanthy/freecoffee-dist/releases/latest,
 *   with no token, no account, and no body. If that release's FreeCoffee.dmg
 *   asset carries a CFBundleShortVersionString newer than the running one,
 *   the DMG is downloaded, its sha256 is compared against the checksum in
 *   the release's source-code link (SHA256: <hex>), and on match the app is
 *   replaced atomically (extract in Application Support, swap in place,
 *   relaunch via the new binary). Auto-download happens at most once per
 *   release version and only while running from a .app bundle in
 *   /Applications; the bare dev binary gets an "Open releases page" menu
 *   item instead. The updater sends nothing anywhere — the request URL
 *   itself carries no identifier, and there is no ping-back.
 *
 * ------------------------------------------------------------------------
 * PRIVACY BOUNDARY — the whole contract, in one paragraph:
 *
 * FreeCoffee collects nothing and sends nothing anywhere. The only network
 * code is (a) the opt-in real-advertiser bridge described above — it reads
 * the one HTTPS feed URL the user configured and sends nothing back — and
 * (b) the anonymous one-way update check described above. Neither request
 * carries an identifier, a token, or any payload; no telemetry, impression,
 * or earnings data ever leaves the machine. One deliberate exception, and
 * only on your click: opening a live sponsor's link navigates your browser
 * to the advertiser's URL — that navigation is visible to the advertiser
 * exactly like any link you open. The app never reads screen
 * contents, files, browser history, keystrokes, screenshots, or
 * window titles — no such API is called from this process. The ONLY
 * signals it touches are:
 *   1. Whether the Mac is awake (NSWorkspace sleep/wake notifications), so
 *      simulated earning pauses while you are away or asleep.
 *   2. Its own internal timers and its own files at
 *      ~/Library/Application Support/FreeCoffee/: ledger.json always, plus
 *      config.json (read) and campaigns-cache.json (written) only when the
 *      live ad feed is configured.
 * Without a configured ad feed, all sponsors, bids, and earnings are
 * simulated demo data.
 * ------------------------------------------------------------------------
 */

import AppKit
import Foundation
import ServiceManagement
import IOKit

/// The persisted shape: ~/Library/Application Support/FreeCoffee/ledger.json
/// `history` maps yyyy-MM-dd → cents earned that day (drives the 7-day chart).
/// Decoding is lenient (every key defaults) so older files stay readable —
/// only a missing file seeds the demo, and only truly malformed JSON is
/// quarantined (see loadState).
private struct DemoEligibility {
    struct Conditions {
        var paused = false
        var disabled = false
        var snoozed = false
        var awake = true
        var unlocked = true
        var idleSeconds: TimeInterval? = 0
        var placementVisible = true
        var demo = true
        var creative: String? = "demo"

        var eligible: Bool {
            guard let idleSeconds, idleSeconds.isFinite, idleSeconds >= 0,
                  let creative, !creative.isEmpty else { return false }
            return !paused && !disabled && !snoozed && awake && unlocked &&
                idleSeconds <= 300 && placementVisible && demo
        }
    }

    private(set) var startedAt: TimeInterval?
    private var lastSample: TimeInterval?
    private var creative: String?

    mutating func reset() {
        startedAt = nil
        lastSample = nil
        creative = nil
    }

    mutating func sample(at now: TimeInterval, conditions: Conditions) -> Bool {
        guard now.isFinite, conditions.eligible else { reset(); return false }
        if let lastSample, now < lastSample || now - lastSample > 2.5 { reset() }
        if creative != conditions.creative { reset() }
        creative = conditions.creative
        lastSample = now
        guard let startedAt else { self.startedAt = now; return false }
        guard now - startedAt >= 60 else { return false }
        self.startedAt = now
        return true
    }
}

private struct DemoAccrual: Codable {
    static let cpm = 2
    static let baseShare = 70
    static let launchShare = 10
    static let microsPerInterval = cpm * 1_000 * (baseShare + launchShare) / 100
    var balanceRemainder = 0
    var dayRemainder = 0
    var day = ""

    mutating func credit(on date: Date) -> (balance: Int, today: Int) {
        let key = dayKey(date)
        if day != key { day = key; dayRemainder = 0 }
        balanceRemainder += Self.microsPerInterval
        dayRemainder += Self.microsPerInterval
        let result = (balanceRemainder / 10_000, dayRemainder / 10_000)
        balanceRemainder %= 10_000
        dayRemainder %= 10_000
        return result
    }
}

private func restOfDayDeadline(from date: Date, calendar: Calendar = .current) -> Date? {
    calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date))
}

private struct FreeCoffeeState: Codable {
    var balance: Double
    var today: Double
    var paused: Bool
    var disabled: Bool
    var snoozeUntil: Date?
    var history: [String: Int]
    var lastTick: Date?
    var updateSkipped: String?
    var updateSeen: String?
    var demoAccrual: DemoAccrual

    init(balance: Double, today: Double, paused: Bool, disabled: Bool,
         snoozeUntil: Date?, history: [String: Int], lastTick: Date?,
          updateSkipped: String?, updateSeen: String?, demoAccrual: DemoAccrual = DemoAccrual()) {
        self.balance = balance
        self.today = today
        self.paused = paused
        self.disabled = disabled
        self.snoozeUntil = snoozeUntil
        self.history = history
        self.lastTick = lastTick
        self.updateSkipped = updateSkipped
        self.updateSeen = updateSeen
        self.demoAccrual = demoAccrual
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        balance = try c.decodeIfPresent(Double.self, forKey: .balance) ?? 0
        today = try c.decodeIfPresent(Double.self, forKey: .today) ?? 0
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
        snoozeUntil = try c.decodeIfPresent(Date.self, forKey: .snoozeUntil)
        history = try c.decodeIfPresent([String: Int].self, forKey: .history) ?? [:]
        lastTick = try c.decodeIfPresent(Date.self, forKey: .lastTick)
        updateSkipped = try c.decodeIfPresent(String.self, forKey: .updateSkipped)
        updateSeen = try c.decodeIfPresent(String.self, forKey: .updateSeen)
        demoAccrual = try c.decodeIfPresent(DemoAccrual.self, forKey: .demoAccrual) ?? DemoAccrual()
    }
}

// MARK: - Coffee palette (mirrors assets/css/styles.css)

private enum Coffee {
    static let panel = NSColor(srgbRed: 0x24 / 255.0, green: 0x1C / 255.0, blue: 0x15 / 255.0, alpha: 1)   // #241C15 popover
    static let inset = NSColor(srgbRed: 0x0F / 255.0, green: 0x0B / 255.0, blue: 0x08 / 255.0, alpha: 1)   // #0F0B08 inset
    static let insetLine = NSColor(srgbRed: 0x3A / 255.0, green: 0x2B / 255.0, blue: 0x1E / 255.0, alpha: 1)
    static let line = NSColor(srgbRed: 0x38 / 255.0, green: 0x29 / 255.0, blue: 0x1D / 255.0, alpha: 1)
    static let text = NSColor(srgbRed: 0xF5 / 255.0, green: 0xEF / 255.0, blue: 0xE6 / 255.0, alpha: 1)    // #F5EFE6
    static let textDim = NSColor(srgbRed: 0xB3 / 255.0, green: 0xA1 / 255.0, blue: 0x90 / 255.0, alpha: 1) // #B3A190
    static let textFaint = NSColor(srgbRed: 0x7E / 255.0, green: 0x6F / 255.0, blue: 0x5F / 255.0, alpha: 1) // #7E6F5F
    static let gold = NSColor(srgbRed: 0xE0 / 255.0, green: 0xA9 / 255.0, blue: 0x3E / 255.0, alpha: 1)    // #E0A93E
    static let goldBright = NSColor(srgbRed: 0xEF / 255.0, green: 0xBE / 255.0, blue: 0x5A / 255.0, alpha: 1)
    static let goldDeep = NSColor(srgbRed: 0xC9 / 255.0, green: 0x7B / 255.0, blue: 0x2D / 255.0, alpha: 1) // #C97B2D
    static let caramel = NSColor(srgbRed: 0xC9 / 255.0, green: 0x8F / 255.0, blue: 0x4E / 255.0, alpha: 1) // #C98F4E
    static let success = NSColor(srgbRed: 0x6F / 255.0, green: 0xBF / 255.0, blue: 0x8B / 255.0, alpha: 1) // #6FBF8B
    static let waiting = NSColor(srgbRed: 0xE2 / 255.0, green: 0xB4 / 255.0, blue: 0x5A / 255.0, alpha: 1) // amber
}

private func money(_ cents: Int) -> String {
    String(format: "$%.2f", Double(cents) / 100.0)
}

// MARK: - Real-advertiser bridge (AD FEED CONTRACT)
//
// A feed is any HTTPS URL returning a JSON array of campaigns. Validation
// mirrors the web app's fetchLiveCampaigns (assets/js/demo.js): https-only
// click URLs, trimmed + length-capped strings, cpm clamped 0–100, accent
// must match #RRGGBB, deduped by id, capped at 20 campaigns.

/// Validation limits — keep in sync with assets/js/demo.js (LIVE_LIMITS).
private enum FeedLimits {
    static let maxCampaigns = 20
    static let timeout: TimeInterval = 8
    static let idMax = 40
    static let sponsorMax = 40
    static let taglineMax = 90
    static let logoTextMax = 2
    static let cpmRange = 0.0...100.0
    static let defaultAccent = "#C98F4E"
    static let refreshInterval: TimeInterval = 30 * 60
}

/// One validated campaign from a live advertiser feed. Display only — live
/// campaigns never touch the ledger or the earning tick.
private struct LiveCampaign: Codable {
    var id: String
    var sponsor: String
    var tagline: String
    var clickUrl: String
    var cpm: Double
    var logoText: String
    var accent: String
}

/// The persisted last-good campaign list: campaigns-cache.json.
private struct CampaignCache: Codable {
    var fetchedAt: Date
    var feedURL: String
    var campaigns: [LiveCampaign]
}

/// Raw shape of ~/Library/Application Support/FreeCoffee/config.json.
/// `minCPM` is optional and defaults to 0, so pre-auction config.json files
/// (with only adFeedURL, or missing entirely) stay valid.
private struct FeedConfig: Codable {
    var adFeedURL: String?
    var minCPM: Double?
}

/// Strict validation helpers (same rules as the web layer).
private enum FeedValidate {
    static func trimmed(_ s: String?, cappedTo max: Int) -> String {
        guard let s = s else { return "" }
        return String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(max))
    }

    static func httpsURL(_ s: String?) -> URL? {
        guard let s = s else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.lowercased().hasPrefix("https://"),
              let url = URL(string: t),
              url.scheme?.lowercased() == "https",
              url.host != nil else { return nil }
        return url
    }

    static func hexColor(_ s: String?) -> String? {
        guard let s = s else { return nil }
        let pattern = "^#[0-9A-Fa-f]{6}$"
        return s.range(of: pattern, options: .regularExpression) != nil ? s : nil
    }
}

/// Fetches + validates a campaign feed. All work runs on a background
/// queue; results are delivered to the main thread via the callback.
private final class CampaignFeedClient {
    typealias Handler = ([LiveCampaign]?, String?) -> Void   // campaigns | error

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = FeedLimits.timeout
        config.timeoutIntervalForResource = FeedLimits.timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    /// Fetch + validate `limit` campaigns from the feed, then call `handler`
    /// on the main queue. Never crashes on malformed input — invalid
    /// entries are skipped, failures return an error string.
    func fetchCampaigns(from feedURL: URL, limit: Int = FeedLimits.maxCampaigns,
                        completion handler: @escaping Handler) {
        session.dataTask(with: feedURL) { data, response, error in
            let result: ([LiveCampaign]?, String?)
            if let error = error {
                result = (nil, "Feed fetch failed: \(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                result = (nil, "Feed fetch failed — HTTP \(http.statusCode)")
            } else if let data = data {
                result = Self.validate(data, limit: limit)
            } else {
                result = (nil, "Feed fetch failed — empty response")
            }
            DispatchQueue.main.async { handler(result.0, result.1) }
        }.resume()
    }

    /// Strict validation of a feed payload: top-level JSON array, entries
    /// validated field-by-field, deduped by id, capped. Mirrors demo.js.
    static func validate(_ data: Data, limit: Int) -> ([LiveCampaign]?, String?) {
        var raws: [[String: Any]]
        do {
            let obj = try JSONSerialization.jsonObject(with: data, options: [])
            guard let arr = obj as? [Any] else {
                return (nil, "Feed must be a JSON array of campaigns")
            }
            raws = arr.compactMap { $0 as? [String: Any] }
        } catch {
            return (nil, "Feed is not valid JSON")
        }

        var seen = Set<String>()
        var campaigns: [LiveCampaign] = []
        for (index, raw) in raws.enumerated() where campaigns.count < limit {
            let sponsor = FeedValidate.trimmed(raw["sponsor"] as? String, cappedTo: FeedLimits.sponsorMax)
            guard !sponsor.isEmpty else { continue }    // unnamed campaigns are unusable

            let id = FeedValidate.trimmed(raw["id"] as? String, cappedTo: FeedLimits.idMax)
            let finalID = id.isEmpty ? "camp_\(index + 1)" : id
            guard !seen.contains(finalID) else { continue }   // dedupe by id
            seen.insert(finalID)

            var cpm = Double(0)
            if let n = raw["cpm"] as? NSNumber, n.doubleValue.isFinite {
                cpm = min(FeedLimits.cpmRange.upperBound, max(FeedLimits.cpmRange.lowerBound, n.doubleValue))
            }

            let click = FeedValidate.httpsURL(raw["clickUrl"] as? String)?.absoluteString ?? ""
            let tagline = FeedValidate.trimmed(raw["tagline"] as? String, cappedTo: FeedLimits.taglineMax)
            var logo = FeedValidate.trimmed(raw["logoText"] as? String, cappedTo: FeedLimits.logoTextMax)
            if logo.isEmpty {
                logo = String(sponsor.split(separator: " ").compactMap { $0.first }).prefix(2).uppercased()
            }
            let accent = FeedValidate.hexColor(raw["accent"] as? String) ?? FeedLimits.defaultAccent

            campaigns.append(LiveCampaign(id: finalID, sponsor: sponsor, tagline: tagline,
                                          clickUrl: click, cpm: cpm, logoText: logo, accent: accent))
        }
        if campaigns.isEmpty {
            return (nil, "Feed contained no valid campaigns")
        }
        return (campaigns, nil)
    }
}

/// Highest-bid-wins auction selector — mirrors assets/js/demo.js → pickAd:
/// eligible campaigns (cpm >= minCpm) sorted by cpm DESC, ties broken by
/// id ASC. Returns a new array; the input is never mutated.
private func pickAd(_ campaigns: [LiveCampaign], minCpm: Double) -> [LiveCampaign] {
    let floor = minCpm.isFinite ? max(0, minCpm) : 0
    return campaigns
        .filter { $0.cpm >= floor }
        .sorted { lhs, rhs in
            if lhs.cpm != rhs.cpm { return lhs.cpm > rhs.cpm }
            return lhs.id < rhs.id
        }
}

private func dayKey(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}

private func tracked(_ text: String, size: CGFloat, weight: NSFont.Weight,
                     color: NSColor, kern: CGFloat = 1.1) -> NSAttributedString {
    NSAttributedString(string: text, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color,
        .kern: kern
    ])
}

// MARK: - 7-day earnings chart (custom NSView)

/// Inset bar chart: one caramel-gradient bar per day, weekday letter below,
/// mono value label above — the popover reference layout.
final class EarningsChartView: NSView {
    var values: [Int] = [] {        // cents per day, oldest → newest
        didSet { needsDisplay = true }
    }
    var labels: [String] = [] {     // weekday letters, e.g. ["M","T","W","T","F","S","S"]
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !values.isEmpty, values.count == labels.count else { return }

        // Inset panel: #0F0B08 with a #3A2B1E hairline.
        let panel = NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9)
        Coffee.inset.setFill()
        panel.fill()
        Coffee.insetLine.setStroke()
        panel.lineWidth = 1
        panel.stroke()

        let sidePad = CGFloat(10)
        let gap = CGFloat(7)
        let top = CGFloat(19)
        let bottom = CGFloat(17)
        let plotH = bounds.height - top - bottom
        if plotH <= 4 { return }
        let n = CGFloat(values.count)
        let slot = (bounds.width - sidePad * 2 - gap * (n - 1)) / n
        let maxV = max(values.max() ?? 1, 1)

        let valueAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 7.5, weight: .medium),
            .foregroundColor: Coffee.textFaint
        ]
        let letterAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 8.5, weight: .medium),
            .foregroundColor: Coffee.textFaint
        ]

        for i in 0..<values.count {
            let x = sidePad + CGFloat(i) * (slot + gap)
            let frac = CGFloat(values[i]) / CGFloat(maxV)
            let h = max(3, plotH * frac)
            let barRect = NSRect(x: x, y: bottom, width: slot, height: h)
            let bar = NSBezierPath(roundedRect: barRect, xRadius: 3.5, yRadius: 3.5)
            NSGradient(starting: Coffee.gold, ending: Coffee.goldDeep)?
                .draw(in: bar, angle: -90)

            // Value label just above the bar.
            let val = NSAttributedString(string: money(values[i]), attributes: valueAttrs)
            let valSize = val.size()
            val.draw(at: NSPoint(x: x + (slot - valSize.width) / 2,
                                 y: min(bottom + h + 2.5, bounds.height - valSize.height)))

            // Weekday letter under the column.
            let letter = NSAttributedString(string: labels[i], attributes: letterAttrs)
            let letterSize = letter.size()
            letter.draw(at: NSPoint(x: x + (slot - letterSize.width) / 2, y: 4))
        }
    }
}

// MARK: - Popover view controller

final class PopoverViewController: NSViewController {

    weak var app: AppDelegate?

    private let statusDot = NSView()
    private let statusLabel = NSTextField(labelWithString: "Waiting")
    private let sponsorLine = NSTextField(labelWithString: "")
    private let balanceField = NSTextField(labelWithString: "$0.00")
    private let splitLabel = NSTextField(labelWithString: "")
    private let cupsLabel = NSTextField(labelWithString: "")
    private let snoozeButton = NSButton(title: "Snooze", target: nil, action: nil)
    private let disableButton = NSButton(title: "Disable", target: nil, action: nil)
    private let advertiseButton = NSButton(title: "✨ Advertise here", target: nil, action: nil)
    private let chartView = EarningsChartView(frame: NSRect(x: 0, y: 0, width: 268, height: 84))

    override func loadView() {
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 4
        root.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        root.translatesAutoresizingMaskIntoConstraints = false
        root.wantsLayer = true
        root.layer?.backgroundColor = Coffee.panel.cgColor
        root.layer?.cornerRadius = 12
        root.layer?.masksToBounds = true
        view = root

        // ---- Header row: brand tile, name + dynamic description line.
        // The tile shows the real AppIcon when the bundle resource resolves,
        // falling back to the gold cup glyph (e.g. bare dev runs).
        let iconTile = NSView()
        iconTile.wantsLayer = true
        iconTile.layer?.cornerRadius = 8
        iconTile.translatesAutoresizingMaskIntoConstraints = false
        let iconView = NSImageView()
        var glyphSize: CGFloat = 17
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let brandMark = NSImage(contentsOf: iconURL) {
            iconTile.layer?.backgroundColor = NSColor.clear.cgColor
            iconView.image = brandMark
            glyphSize = 26
        } else {
            iconTile.layer?.backgroundColor = Coffee.gold.cgColor
            iconView.image = NSImage(systemSymbolName: "cup.and.saucer.fill",
                                     accessibilityDescription: "FreeCoffee")
            iconView.contentTintColor = Coffee.panel
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconTile.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconTile.widthAnchor.constraint(equalToConstant: 30),
            iconTile.heightAnchor.constraint(equalToConstant: 30),
            iconView.centerXAnchor.constraint(equalTo: iconTile.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconTile.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: glyphSize),
            iconView.heightAnchor.constraint(equalToConstant: glyphSize)
        ])

        let nameStack = NSStackView()
        nameStack.orientation = .vertical
        nameStack.alignment = .leading
        nameStack.spacing = 1
        let name = NSTextField(labelWithString: "☕ FreeCoffee")
        name.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        name.textColor = Coffee.text
        // Description line (second row, like the reference): the live
        // campaign, the empty state, or the demo sponsor — set in refresh().
        sponsorLine.font = NSFont.systemFont(ofSize: 9.5)
        sponsorLine.textColor = Coffee.textFaint
        nameStack.addArrangedSubview(name)
        nameStack.addArrangedSubview(sponsorLine)
        // Empty-inventory CTA — hidden unless the feed is configured but
        // yields nothing (see refresh). Opens the advertiser pitch.
        advertiseButton.target = self
        advertiseButton.action = #selector(advertiseTapped)
        advertiseButton.isBordered = false
        advertiseButton.font = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
        advertiseButton.contentTintColor = Coffee.goldBright
        advertiseButton.isHidden = true
        nameStack.addArrangedSubview(advertiseButton)

        statusDot.wantsLayer = true
        statusDot.layer?.backgroundColor = Coffee.success.cgColor
        statusDot.layer?.cornerRadius = 3.5
        statusDot.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = NSFont.systemFont(ofSize: 9.5, weight: .bold)
        statusLabel.textColor = Coffee.success

        let statusStack = NSStackView(views: [statusDot, statusLabel])
        statusStack.orientation = .horizontal
        statusStack.spacing = 5
        statusStack.alignment = .centerY

        let header = NSStackView(views: [iconTile, nameStack, statusStack])
        header.orientation = .horizontal
        header.spacing = 9
        header.alignment = .centerY

        // ---- TOTAL BALANCE block.
        let totalCaption = NSTextField(labelWithAttributedString:
            tracked("DEMO BALANCE", size: 8.5, weight: .bold, color: Coffee.textFaint))
        balanceField.font = NSFont.monospacedDigitSystemFont(ofSize: 27, weight: .bold)
        balanceField.textColor = Coffee.text
        splitLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular)
        splitLabel.textColor = Coffee.textFaint
        splitLabel.alignment = .right
        cupsLabel.font = NSFont.systemFont(ofSize: 10)
        cupsLabel.textColor = Coffee.textFaint

        // ---- Boost line (caramel gradient tint).
        let boost = NSTextField(wrappingLabelWithString: "70% base + 10% launch share\nLaunch bonus funded by the platform")
        boost.font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        boost.textColor = Coffee.goldBright
        let boostBox = NSView()
        boostBox.wantsLayer = true
        boostBox.layer?.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.05).cgColor
        boostBox.layer?.cornerRadius = 8
        boostBox.layer?.borderWidth = 1
        boostBox.layer?.borderColor = Coffee.gold.withAlphaComponent(0.28).cgColor
        boostBox.translatesAutoresizingMaskIntoConstraints = false
        boost.translatesAutoresizingMaskIntoConstraints = false
        boostBox.addSubview(boost)
        // NOTE: only constraints internal to boostBox are activated here.
        // boostBox does not join the view hierarchy until it is added to `root`
        // further down, and activating a constraint between two views that share
        // no common ancestor makes NSLayoutConstraint.activate spin forever —
        // which hangs the whole launch. The panel-width constraint is therefore
        // installed after the addArrangedSubview(boostBox) call below.
        NSLayoutConstraint.activate([
            boost.leadingAnchor.constraint(equalTo: boostBox.leadingAnchor, constant: 10),
            boost.trailingAnchor.constraint(equalTo: boostBox.trailingAnchor, constant: -10),
            boost.topAnchor.constraint(equalTo: boostBox.topAnchor, constant: 6),
            boost.bottomAnchor.constraint(equalTo: boostBox.bottomAnchor, constant: -6)
        ])

        // ---- Earnings · 7 days + chart.
        let weekCaption = NSTextField(labelWithAttributedString:
            tracked("EARNINGS · 7 DAYS", size: 8.5, weight: .bold, color: Coffee.textFaint))
        chartView.widthAnchor.constraint(equalToConstant: 268).isActive = true
        chartView.heightAnchor.constraint(equalToConstant: 84).isActive = true

        // ---- Tip line.
        let tip = NSTextField(wrappingLabelWithString:
            "Tip: Hold ⌘ and drag Mac status area items to rearrange them.")
        tip.font = NSFont.systemFont(ofSize: 9.5)
        tip.textColor = Coffee.textFaint
        tip.preferredMaxLayoutWidth = 268

        // ---- Footer: 4 icon+label buttons.
        snoozeButton.target = self
        snoozeButton.action = #selector(snoozeTapped)
        disableButton.target = self
        disableButton.action = #selector(disableTapped)
        let settingsButton = footerButton("gearshape", "Settings", #selector(settingsTapped))
        let accountButton = footerButton("person.crop.circle", "Account", #selector(accountTapped))
        styleFooterButton(snoozeButton, symbol: "zzz")
        styleFooterButton(disableButton, symbol: "power")

        let footer = NSStackView(views: [settingsButton, snoozeButton, disableButton, accountButton])
        footer.orientation = .horizontal
        footer.spacing = 6
        footer.alignment = .centerY
        footer.distribution = .fillEqually

        root.addArrangedSubview(header)
        addDivider(to: root)
        root.addArrangedSubview(totalCaption)
        root.addArrangedSubview(balanceField)
        root.addArrangedSubview(splitLabel)
        root.addArrangedSubview(cupsLabel)
        root.addArrangedSubview(boostBox)
        // Safe here: boostBox and root are now in the same hierarchy.
        boostBox.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32).isActive = true
        root.addArrangedSubview(weekCaption)
        root.addArrangedSubview(chartView)
        root.addArrangedSubview(tip)
        addDivider(to: root)
        root.addArrangedSubview(footer)

        root.setCustomSpacing(10, after: header)
        root.setCustomSpacing(10, after: totalCaption)
        root.setCustomSpacing(2, after: balanceField)
        root.setCustomSpacing(10, after: cupsLabel)
        root.setCustomSpacing(10, after: boostBox)
        root.setCustomSpacing(7, after: weekCaption)
        root.setCustomSpacing(10, after: chartView)
        root.setCustomSpacing(10, after: tip)

        root.widthAnchor.constraint(equalToConstant: 300).isActive = true
        // Right-align the available/pending split under the figure.
        splitLabel.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32).isActive = true
    }

    /// 1pt hairline spanning the panel. The line is added to `stack` here
    /// rather than returned to the caller because the width constraint can only
    /// be activated once the line and the stack share a hierarchy — activating
    /// a constraint between unrelated views hangs NSLayoutConstraint.activate
    /// (see the note in loadView).
    private func addDivider(to stack: NSStackView) {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Coffee.line.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        stack.addArrangedSubview(line)
        line.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32).isActive = true
    }

    private func footerButton(_ symbol: String, _ title: String, _ action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        styleFooterButton(b, symbol: symbol)
        return b
    }

    private func styleFooterButton(_ b: NSButton, symbol: String) {
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: b.title)
        b.imagePosition = .imageLeading
        b.isBordered = false
        b.font = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
        b.contentTintColor = Coffee.textDim
    }

    // MARK: Refresh (called by AppDelegate on every state change / tick)

    func refresh() {
        guard let app = app else { return }
        let state = app.uiState

        // Status dot + label: Earning / Waiting / Disabled, with a LIVE
        // marker while a real-advertiser campaign is showing.
        let earning = app.demoEligible
        let (dotColor, textColor, label): (NSColor, NSColor, String) = {
            if state.disabled { return (Coffee.textFaint, Coffee.textFaint, "Disabled") }
            if !earning { return (Coffee.waiting, Coffee.waiting, "Waiting") }
            return (Coffee.success, Coffee.success, "Demo")
        }()
        statusDot.layer?.backgroundColor = dotColor.cgColor
        statusLabel.textColor = textColor
        if let camp = app.currentLiveCampaign {
            statusLabel.stringValue = "Preview"
            sponsorLine.stringValue = "Feed preview · \(camp.sponsor)" +
                (camp.tagline.isEmpty ? "" : " — \(camp.tagline)")
            sponsorLine.font = NSFont.systemFont(ofSize: 9.5, weight: .medium)
            sponsorLine.textColor = Coffee.goldBright
            sponsorLine.isHidden = false
            advertiseButton.isHidden = true
        } else if app.awaitingSponsors {
            statusLabel.stringValue = label
            sponsorLine.stringValue = "No sponsors available"
            sponsorLine.font = NSFont.systemFont(ofSize: 9.5)
            sponsorLine.textColor = Coffee.textDim
            sponsorLine.isHidden = false
            advertiseButton.isHidden = false
        } else {
            statusLabel.stringValue = label
            sponsorLine.stringValue = "Demo · \(app.demoSponsor) (fictional)"
            sponsorLine.font = NSFont.systemFont(ofSize: 9.5)
            sponsorLine.textColor = Coffee.textFaint
            sponsorLine.isHidden = false
            advertiseButton.isHidden = true
        }

        balanceField.stringValue = money(state.balanceCents)
        splitLabel.stringValue = "Simulated only · not withdrawable"
        cupsLabel.stringValue = "$2 CPM · $0.0016 per eligible 60 seconds"

        chartView.values = state.weekValues
        chartView.labels = state.weekLetters
        chartView.needsDisplay = true

        // Snooze button: while snoozed it shows the live countdown; the
        // next tap turns the snooze off. Not snoozed → "Snooze" starts
        // the default 30-minute snooze.
        if let until = app.snoozeUntil, until > Date() {
            let secs = Int(until.timeIntervalSinceNow.rounded(.up))
            snoozeButton.title = String(format: "Snoozed %02d:%02d", secs / 60, secs % 60)
        } else {
            snoozeButton.title = "Snooze"
        }
        disableButton.title = state.disabled ? "Enable" : "Disable"
    }

    // MARK: Footer actions

    @objc private func settingsTapped() {
        view.window?.orderOut(nil)
        app?.openDashboard()
    }

    @objc private func accountTapped() {
        view.window?.orderOut(nil)
        app?.openAccount()
    }

    @objc private func advertiseTapped() {
        view.window?.orderOut(nil)
        app?.openAdvertisePage()
    }

    @objc private func snoozeTapped() {
        app?.snoozeToggled()
        refresh()
    }

    @objc private func disableTapped() {
        app?.disableToggled()
        refresh()
    }
}

// MARK: - App delegate

// MARK: - Updater (anonymous GitHub Releases check + checksum-verified swap)

/// Checks the public GitHub Releases API for a newer FreeCoffee.dmg,
/// verifies its sha256 against the checksum published in the release body,
/// and swaps the running app in place — all without any identifier or
/// telemetry. See the UPDATER block in the file header for the contract.
final class UpdateEngine: NSObject {

    /// From the bundle's Info.plist (build.sh injects it); bare dev builds fall back.
    static let version: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.1.0"

    static let releasesAPI = URL(string: "https://api.github.com/repos/ayodhyamohanthy/freecoffee-dist/releases/latest")!
    static let releasesPage = URL(string: "https://github.com/ayodhyamohanthy/freecoffee-dist/releases/latest")!
    static let checkInterval: TimeInterval = 6 * 60 * 60   // re-check every 6 h

    enum Status: Equatable {
        case idle
        case checking
        case upToDate(current: String)
        case available(version: String, notes: URL)          // dev binary or unverifiable release → manual path
        case downloading
        case ready(version: String)                          // installed — offered on next launch
        case failed(reason: String)
    }

    var onStatusChange: ((Status) -> Void)?

    private(set) var status: Status = .idle { didSet { onStatusChange?(status) } }
    private var session: URLSession
    private var updateTask: Task<Void, Never>?
    private let fm = FileManager.default

    override init() {
        let config = URLSessionConfiguration.ephemeral          // nothing touches the shared cookie/data store
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 10 * 60             // a slow DMG download shouldn't be cut off
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["Accept": "application/vnd.github+json"]
        session = URLSession(configuration: config)
        super.init()
    }

    var supportDir: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.homeDirectoryForCurrentUser
        return base.appendingPathComponent("FreeCoffee", isDirectory: true)
    }
    private var pendingAppURL: URL { supportDir.appendingPathComponent("update/FreeCoffee.app", isDirectory: true) }

    /// Version staged in Application Support by an earlier check (nil when
    /// nothing usable is staged). Lets check() offer .ready without
    /// re-downloading, and lets the boot swap refuse stale stages.
    var stagedVersion: String? {
        guard fm.fileExists(atPath: pendingAppURL.path) else { return nil }
        let plist = pendingAppURL.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist),
              let pd = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let v = pd["CFBundleShortVersionString"] as? String else { return nil }
        return v
    }

    /// Drop a staged update entirely (skip-this-version path): marker plus
    /// staged bundle, so a declined release can never install later.
    func discardStagedUpdate() {
        UserDefaults.standard.removeObject(forKey: "FreeCoffeePendingUpdatePath")
        try? fm.removeItem(at: supportDir.appendingPathComponent("update", isDirectory: true))
    }

    /// Which app bundle we're replacing. Dev runs of the bare binary have no
    /// bundle to swap — they surface the releases page instead.
    private var installedAppURL: URL? {
        Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundleURL : nil
    }

    // MARK: Check (called on launch + every 6 h; also from the menu item)

    func checkForUpdate(force: Bool = false, completion: ((Status) -> Void)? = nil) {
        updateTask?.cancel()
        updateTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.check(force: force)
            // Status drives UI (refreshUI, modal alerts) — always deliver on main.
            await MainActor.run {
                self.status = result
                completion?(result)
            }
        }
    }

    // MARK: Update handling (see UpdateEngine — anonymous, checksum-verified)

    /// Current "skip this version" choice (persisted in ledger.json).
    var skippedVersion: String?

    func skipCurrentVersion(_ version: String) {
        skippedVersion = version
    }

    private func check(force: Bool = false) async -> Status {
        await MainActor.run { self.status = .checking }
        do {
            let (data, resp) = try await session.data(from: Self.releasesAPI)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                return .failed(reason: "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .failed(reason: "Malformed release feed")
            }
            guard let tag = obj["tag_name"] as? String else {
                return .failed(reason: "Release feed has no tag")
            }
            let latest = tag.trimmingCharacters(in: CharacterSet(charactersIn: "v "))
            guard Self.isNewer(latest, than: Self.version) else {
                return .upToDate(current: Self.version)
            }
            // A version the user explicitly skipped never re-downloads on the
            // silent path; a manual check (force) always offers it.
            if !force && latest == skippedVersion {
                return .upToDate(current: Self.version)
            }
            guard let assets = obj["assets"] as? [[String: Any]],
                  let dmg = assets.first(where: { ($0["name"] as? String) == "FreeCoffee.dmg" }),
                  let dmgURLString = dmg["browser_download_url"] as? String,
                  let dmgURL = URL(string: dmgURLString) else {
                return .failed(reason: "Release \(latest) has no FreeCoffee.dmg asset")
            }
            // Published checksum: the release body carries "SHA256: <64 hex>".
            let body = (obj["body"] as? String) ?? ""
            var expectedSHA = ""
            if let range = body.range(of: "SHA256:[ ]*([0-9a-fA-F]{64})", options: .regularExpression) {
                expectedSHA = String(body[range]).replacingOccurrences(of: " ", with: "")
                    .replacingOccurrences(of: "SHA256:", with: "").lowercased()
            }
            guard expectedSHA.count == 64 else {
                return .available(version: latest, notes: Self.releasesPage)   // can't verify → manual path
            }
            guard installedAppURL != nil else {
                return .available(version: latest, notes: Self.releasesPage)   // dev binary → show page
            }
            // Already staged for this exact release (downloaded earlier, app
            // restarted before relaunch): offer it without re-downloading.
            if let staged = stagedVersion, staged == latest {
                return .ready(version: latest)
            }
            await MainActor.run { self.status = .downloading }
            let (tmpURL, dlResp) = try await session.download(from: dmgURL)
            guard let dlHTTP = dlResp as? HTTPURLResponse, dlHTTP.statusCode == 200 else {
                try? fm.removeItem(at: tmpURL)
                return .failed(reason: "Download HTTP \((dlResp as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            let sha = sha256(fileURL: tmpURL)
            guard sha == expectedSHA else {
                try? fm.removeItem(at: tmpURL)
                NSLog("FreeCoffee updater: checksum mismatch (\(sha.prefix(12))… != \(expectedSHA.prefix(12))…)")
                return .failed(reason: "Checksum mismatch — download discarded")
            }
            if install(fromDMG: tmpURL) {
                try? fm.removeItem(at: tmpURL)   // staged copy lives in Application Support now
                return .ready(version: latest)
            }
            try? fm.removeItem(at: tmpURL)
            return .failed(reason: "Install failed — DMG could not be applied")
        } catch is CancellationError {
            // Superseded by a newer check — back to idle so a stranded
            // manual flag can't stick (see .idle in handleUpdateStatus).
            return .idle
        } catch {
            return .failed(reason: error.localizedDescription)
        }
    }

    // MARK: Version comparison (numeric segments: 1.2.10 > 1.2.9)

    private static func isNewer(_ candidate: String, than current: String) -> Bool {
        let c = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let cur = current.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(c.count, cur.count) {
            let a = i < c.count ? c[i] : 0
            let b = i < cur.count ? cur[i] : 0
            if a != b { return a > b }
        }
        return false
    }

    // MARK: Install — extract DMG in Application Support, stage bundle for relaunch

    private func install(fromDMG dmgURL: URL) -> Bool {
        guard let source = mount(dmgURL) else { return false }
        defer { unmount(source.volume) }

        let updateDir = supportDir.appendingPathComponent("update", isDirectory: true)
        try? fm.removeItem(at: updateDir)
        do {
            try fm.createDirectory(at: updateDir, withIntermediateDirectories: true)
            try fm.copyItem(at: source.appURL, to: pendingAppURL)
        } catch {
            NSLog("FreeCoffee updater: copy failed: \(error.localizedDescription)")
            return false
        }
        // Stage the replacement; the relaunched process swaps old → new on boot
        // (applyPendingUpdateAndRelaunch) and always opens the NEW binary.
        UserDefaults.standard.set(pendingAppURL.path, forKey: "FreeCoffeePendingUpdatePath")
        return true
    }

    /// Called by the AppDelegate at startup: if a staged update exists,
    /// replace the installed bundle with it, then open the (new) app.
    static func applyPendingUpdateAndRelaunch() {
        let defaults = UserDefaults.standard
        guard let stagedPath = defaults.string(forKey: "FreeCoffeePendingUpdatePath") else { return }

        let fm = FileManager.default
        let target = Bundle.main.bundleURL
        let staged = URL(fileURLWithPath: stagedPath, isDirectory: true)

        /// Give up without touching the installed app. The pending marker is
        /// cleared so the updater simply offers the release again later.
        func abandon(_ reason: String) {
            NSLog("FreeCoffee updater: staged update not applied — \(reason)")
            defaults.removeObject(forKey: "FreeCoffeePendingUpdatePath")
            try? fm.removeItem(at: staged)
        }

        // Refuse the swap when it cannot be done safely:
        //  • running outside a bundle (bare dev binary) — there is nothing to swap;
        //  • the bundle is App-Translocated. macOS relocates a quarantined app to
        //    /private/var/folders/…/AppTranslocation/… on a read-only volume, so
        //    neither the old nor the staged bundle can be moved into place;
        //  • the staged copy is not a usable bundle;
        //  • the folder holding the installed app is not writable.
        guard target.pathExtension == "app" else {
            abandon("running outside an app bundle")
            return
        }
        guard !target.path.contains("/AppTranslocation/") else {
            abandon("bundle is App-Translocated — reinstall from the DMG")
            return
        }
        let stagedExecutable = staged.appendingPathComponent("Contents/MacOS/FreeCoffeeMenuBar")
        guard fm.isExecutableFile(atPath: stagedExecutable.path) else {
            abandon("staged copy is not a usable bundle")
            return
        }
        let parent = target.deletingLastPathComponent()
        guard fm.isWritableFile(atPath: parent.path) else {
            abandon("\(parent.path) is not writable")
            return
        }

        // Refuse a stale stage: without this, a newer hand-installed build
        // could be clobbered by an older staged update on next launch.
        let currentVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        let stagedPlistData = try? Data(contentsOf: staged.appendingPathComponent("Contents/Info.plist"))
        let stagedPlist = stagedPlistData.flatMap {
            try? PropertyListSerialization.propertyList(from: $0, options: [], format: nil)
        } as? [String: Any]
        let stagedV = stagedPlist?["CFBundleShortVersionString"] as? String ?? ""
        guard !stagedV.isEmpty, Self.isNewer(stagedV, than: currentVersion) else {
            abandon("staged version (\(stagedV.isEmpty ? "unreadable" : stagedV)) is not newer than installed (\(currentVersion))")
            return
        }

        defaults.removeObject(forKey: "FreeCoffeePendingUpdatePath")

        // Replace the running bundle: move old aside → move staged in → delete old.
        // If the second move fails the old bundle is moved back, so a failed
        // update can never leave /Applications without FreeCoffee.
        let aside = parent.appendingPathComponent(
            ".FreeCoffee-old-\(ProcessInfo.processInfo.globallyUniqueString)")
        do {
            try fm.moveItem(at: target, to: aside)
        } catch {
            NSLog("FreeCoffee updater: could not move the installed bundle aside: \(error.localizedDescription)")
            abandon("installed bundle could not be moved")
            return
        }
        do {
            try fm.moveItem(at: staged, to: target)
        } catch {
            NSLog("FreeCoffee updater: swap failed, rolling back: \(error.localizedDescription)")
            try? fm.moveItem(at: aside, to: target)   // the app must still exist
            try? fm.removeItem(at: staged)
            return
        }
        try? fm.removeItem(at: aside)
        // Relaunch through the new bundle — and only exit once the open
        // succeeds. If it fails, this (old, in-memory) process keeps running
        // instead of leaving the user with no app at all.
        NSWorkspace.shared.openApplication(at: target, configuration: NSWorkspace.OpenConfiguration()) { app, error in
            if error == nil, app != nil {
                exit(0)
            } else {
                NSLog("FreeCoffee updater: relaunch failed (\(error?.localizedDescription ?? "unknown error")) — v\(stagedV) is installed; please quit and reopen FreeCoffee")
            }
        }
    }

    // MARK: hdiutil plumbing

    private typealias Mount = (volume: URL, appURL: URL)

    private func mount(_ dmg: URL) -> Mount? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        proc.arguments = ["attach", dmg.path, "-nobrowse", "-readonly", "-plist"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0,
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let entities = plist["system-entities"] as? [[String: Any]],
              let entry = entities.first(where: { ($0["mount_point"] as? String)?.isEmpty == false }),
              let mountPoint = entry["mount_point"] as? String else { return nil }
        let volume = URL(fileURLWithPath: mountPoint)
        let appURL = volume.appendingPathComponent("FreeCoffee.app", isDirectory: true)
        guard fm.fileExists(atPath: appURL.path) else {
            // Detach before bailing — otherwise every bad DMG leaks a /Volumes mount.
            unmount(volume)
            return nil
        }
        return (volume, appURL)
    }

    private func unmount(_ volume: URL) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        proc.arguments = ["detach", volume.path, "-force"]
        try? proc.run()
        proc.waitUntilExit()
    }

    // MARK: sha256 (streamed via CommonCrypto — no shasum subprocess)

    private func sha256(fileURL: URL) -> String {
        var context = CC_SHA256_CTX()
        CC_SHA256_Init(&context)
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return "" }
        defer { try? handle.close() }
        while true {
            let chunk = handle.readData(ofLength: 1 << 20)
            if chunk.isEmpty { break }
            chunk.withUnsafeBytes { ptr in
                _ = CC_SHA256_Update(&context, ptr.baseAddress, CC_LONG(chunk.count))
            }
        }
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256_Final(&digest, &context)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Open the releases page (dev-binary path, "Skip", and "Release notes" routes).
    func openReleasesPage() {
        NSWorkspace.shared.open(Self.releasesPage)
    }
}

#if canImport(Darwin)
import CommonCrypto
#endif

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {

    // MARK: State (main thread only — timers and notifications are main-bound)

    private(set) var balanceCents = 0
    private(set) var todayCents = 0
    private(set) var paused = false
    private(set) var disabled = false
    private(set) var snoozeUntil: Date?
    private(set) var isAwake = true
    private var sessionActive = true
    private var screenLocked = false
    private var displaysAwake = true
    private var eligibility = DemoEligibility()
    private var demoAccrual = DemoAccrual()
    private var eligibilityObservers: [NSObjectProtocol] = []
    private var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    private(set) var demoEligible = false
    private var history: [String: Int] = [:]   // yyyy-MM-dd → cents earned
    private var lastTick: Date?
    private var updateSeen: String?             // release version already auto-staged once
    private var isManualCheck = false           // menu-triggered check → dialog instead of silent policy

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let menu = NSMenu()
    private var popoverVC: PopoverViewController!
    private let updateEngine = UpdateEngine()

    private var menuPauseItem: NSMenuItem!
    private var snooze30Item: NSMenuItem!
    private var snooze2hItem: NSMenuItem!
    private var snooze6hItem: NSMenuItem!
    private var snoozeOffItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var updateMenuItem: NSMenuItem!
    private var loginItemFailed = false   // sticky: a failed toggle must survive refreshLoginItem()

    private var sleepObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?

    // ---- Real-advertiser bridge state (display only — never the ledger) ----
    private var adFeedURL: URL?
    private var minCPM: Double = 0               // optional config.json floor, 0 = no floor
    private var liveCampaigns: [LiveCampaign] = []   // kept in pickAd order (highest CPM first)
    private var liveCampaignIndex = 0
    private var feedClient: CampaignFeedClient?
    private var feedRefreshTimer: Timer?
    private var campaignRotateTimer: Timer?
    private var sponsorMenuItem: NSMenuItem?       // present only when a feed is live
    private var advertiseMenuItem: NSMenuItem?    // present only when a feed is configured but empty
    private var reloadMenuItem: NSMenuItem?        // "Reload campaigns" (feed only)

    /// Fictional demo sponsors (same cast as the web demo) — display-only
    /// rotation while no live feed is configured. They earn nothing extra;
    /// the tick stays the flat demo rate.
    private static let demoSponsors = ["Northline", "Ledgerly", "Fernhill Coffee", "Breeze VPN", "Kite Studio"]
    private var demoSponsorIndex = 0
    var demoSponsor: String { Self.demoSponsors[demoSponsorIndex % Self.demoSponsors.count] }

    /// Feed configured but nothing usable right now (empty feed, all below
    /// the floor, fetch failing on an empty cache). The Mac status area turns into
    /// advertiser acquisition instead of a dead end.
    var awaitingSponsors: Bool { adFeedURL != nil && currentLiveCampaign == nil }

    /// The campaign currently shown on the chip + popover header (or nil
    /// when running on the fictional demo sponsors).
    fileprivate var currentLiveCampaign: LiveCampaign? {
        guard !liveCampaigns.isEmpty else { return nil }
        return liveCampaigns[liveCampaignIndex % liveCampaigns.count]
    }

    // Dashboard + profile open the live site (always reachable for an
    // installed app). Developers hacking on the pages locally can still use
    // http://127.0.0.1:8090/… via a static server — these constants are the
    // only place that choice lives.
    private static let dashboardURL = URL(string: "https://freecoffee.tech/dashboard.html")
    private static let profileURL = URL(string: "https://freecoffee.tech/profile.html")
    private static let advertiseURL = URL(string: "https://freecoffee.tech/advertisers.html")

    // First run is seeded to match the web demo's deterministic ledger
    // (seed 42 lifetime, $28.55), so both layers tell the same story.
    // The seven seeded day buckets sum to exactly 2855 cents.
    private static let demoSeedBalanceCents = 2855
    private static let demoSeedWeek: [Int] = [180, 420, 390, 510, 460, 495, 400]

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        UpdateEngine.applyPendingUpdateAndRelaunch()   // staged updater swap, if any (exits when it runs)
        loadState()

        statusItem.button?.title = "☕ FreeCoffee"
        statusItem.button?.toolTip = "FreeCoffee demo — simulated data. Nothing is collected."

        buildMenu()

        popoverVC = PopoverViewController()
        popoverVC.app = self
        popover.contentViewController = popoverVC
        popover.behavior = .transient
        popover.delegate = self
        popover.appearance = NSAppearance(named: .darkAqua)

        // LEFT-click → popover; RIGHT-click → menu (see statusItemClicked).
        statusItem.button?.action = #selector(statusItemClicked(_:))
        statusItem.button?.target = self
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        setupChipPill()   // dark pill + status dot behind logo + texts

        observeSleepWake()
        scheduleTimers()
        scheduleUpdateCheck()

        // Real-advertiser bridge: read config.json, prime the UI from the
        // cached last-good campaign list, then fetch fresh — and keep
        // refreshing every 30 min / rotating every 60 s. Display only.
        loadLiveFeedConfig()
        if adFeedURL != nil {
            liveCampaigns = pickAd(loadCampaignCache(), minCpm: minCPM)
            if currentLiveCampaign != nil { refreshUI() }
            fetchLiveCampaigns()
        }
        scheduleLiveFeedTimers()

        refreshUI()
        persist()
    }

    func applicationWillTerminate(_ notification: Notification) {
        persist()
    }

    // MARK: UI state for the popover (derived snapshot)

    struct UIState {
        let balanceCents: Int
        let availableCents: Int
        let pendingCents: Int
        let disabled: Bool
        let paused: Bool
        let weekValues: [Int]
        let weekLetters: [String]
    }

    var uiState: UIState {
        let week = last7Days()
        return UIState(
            balanceCents: balanceCents,
            availableCents: max(0, balanceCents - todayCents),
            pendingCents: todayCents,
            disabled: disabled,
            paused: paused,
            weekValues: week.values,
            weekLetters: week.letters
        )
    }

    /// Last 7 calendar days, oldest → newest, with very-short weekday letters
    /// (S M T W T F S — actual letters of the actual dates).
    private func last7Days() -> (values: [Int], letters: [String]) {
        let cal = Calendar.current
        let symbols = cal.veryShortWeekdaySymbols
        var values: [Int] = []
        var letters: [String] = []
        for offset in stride(from: 6, through: 0, by: -1) {
            let day = cal.date(byAdding: .day, value: -offset, to: Date()) ?? Date()
            values.append(history[dayKey(day)] ?? 0)
            let wd = cal.component(.weekday, from: day)
            letters.append(wd >= 1 && wd <= 7 ? symbols[wd - 1] : "?")
        }
        return (values, letters)
    }

    private func refreshUI() {
        // Mac status area chip: snoozed → countdown; live sponsor when a feed is
        // connected; acquisition slot when the feed is empty; otherwise the
        // rotating fictional demo sponsors (simulated, display only).
        if snoozed {
            chipLogo.isHidden = true
            chipHeadline.isHidden = true
            chipDescription.isHidden = true
            statusItem.button?.image = nil
            // Single line, untruncated in code (the bar itself clips) so the
            // resume time is never cut by the headline cap. The dot zone is
            // reserved by fitChipWidth.
            let snoozePara = NSMutableParagraphStyle()
            snoozePara.lineBreakMode = .byTruncatingTail
            let snoozeTitle = NSMutableAttributedString(
                string: "☕ FreeCoffee — snoozed until \(snoozeEndTimeLabel())",
                attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .regular),
                             .foregroundColor: NSColor.white])
            snoozeTitle.addAttribute(.paragraphStyle, value: snoozePara,
                                     range: NSRange(location: 0, length: snoozeTitle.length))
            statusItem.button?.attributedTitle = snoozeTitle
            statusItem.button?.toolTip = "FreeCoffee — snoozed (no earning ticks, no ad rotation). " +
                "Earning resumes automatically. Nothing is collected."
            chipDotColor = Coffee.textFaint
        } else if let camp = currentLiveCampaign {
            setChipContent(
                image: chipTile(monogram: chipMonogram(logoText: camp.logoText, sponsor: camp.sponsor), accentHex: camp.accent),
                headline: camp.sponsor,
                description: camp.tagline.isEmpty ? "LIVE" : camp.tagline)
            statusItem.button?.toolTip = "FreeCoffee — LIVE: \(camp.sponsor)" +
                (camp.tagline.isEmpty ? "" : " — \(camp.tagline)") + ". Nothing is collected."
            chipDotColor = Coffee.success
        } else if awaitingSponsors {
            setChipContent(
                image: chipTile(monogram: "FC", accentHex: "#E0A93E"),
                headline: "Your brand here",
                description: "No sponsors available")
            statusItem.button?.toolTip = "No sponsors right now — put your brand in this Mac status area. " +
                "Click for details."
            chipDotColor = Coffee.waiting
        } else {
            setChipContent(
                image: chipTile(monogram: chipMonogram(logoText: "", sponsor: demoSponsor), accentHex: "#E0A93E"),
                headline: demoSponsor,
                description: "Demo · fictional")
            statusItem.button?.toolTip = "FreeCoffee demo sponsor (simulated) — no real campaign, " +
                "nothing is collected."
            chipDotColor = Coffee.success
        }
        fitChipWidth()
        placeChipDot(color: chipDotColor)
        popoverVC?.refresh()
        updateMenu()
    }

    /// "HH:MM" for the snooze deadline (local 24-hour clock, e.g. "14:05").
    private func snoozeEndTimeLabel() -> String {
        guard let until = snoozeUntil else { return "--:--" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: until)
    }

    /// Chip-safe sponsor name: the Mac status area is narrow.
    private func truncateForBar(_ s: String, max: Int = 20) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)) + "…"
    }

    /// The bar sizes the button to the title alone, which lets long lines
    /// slide under the status dot. Widen by the dot zone + padding after
    /// every title change (refreshUI covers all branches). Skips redundant
    /// resizes so the 1 s heartbeat can't fight the status-bar layout.
    private var lastChipWidth: CGFloat = 0

    private func fitChipWidth() {
        guard let button = statusItem.button else { return }
        let h = button.bounds.height

        // Snooze mode hides both labels and draws ONE attributed title on the
        // button. Size the pill from that title — measuring the hidden labels
        // instead used their stale (last sponsor) widths and clipped the
        // countdown.
        if chipHeadline.isHidden && chipDescription.isHidden {
            let titleW = button.attributedTitle.size().width
            let want = min(max(120, titleW + 22), 300)
            if abs(want - lastChipWidth) > 0.5 { statusItem.length = want }
            lastChipWidth = want
            return
        }

        // Width goes through statusItem.length — resizing the button frame
        // directly fights the Mac status bar's layout pass.
        let textWidth = max(chipHeadline.intrinsicContentSize.width, chipDescription.intrinsicContentSize.width)
        let want = min(max(132, 7 + 16 + 8 + textWidth + 24), 236)
        // Skip redundant writes so the 1 s heartbeat can never fight the
        // status bar's own layout pass (statusItem.length is a setter that
        // triggers a full bar relayout on every call).
        if abs(want - lastChipWidth) > 0.5 { statusItem.length = want }
        lastChipWidth = want

        // Tile: 16pt, vertically centered.
        chipLogo.frame = NSRect(x: 7, y: (h - 16) / 2, width: 16, height: 16)

        // Two-line text block, vertically centered as ONE unit: 11pt headline
        // over 8pt description. Anchoring both lines to midY (the old
        // behaviour) pushed the block 4pt below center and let the headline
        // clip on the stock 22pt bar.
        let textX: CGFloat = 7 + 16 + 6            // tile + gap
        let textW = max(24, want - textX - 20)     // reserve dot zone + padding
        let headlineH: CGFloat = 11
        let descH: CGFloat = 8
        let blockH = headlineH + descH
        let blockBottom = (h - blockH) / 2
        chipDescription.frame = NSRect(x: textX, y: blockBottom, width: textW, height: descH)
        chipHeadline.frame = NSRect(x: textX, y: blockBottom + descH, width: textW, height: headlineH)
    }

    private func setChipContent(image: NSImage?, headline: String, description: String) {
        statusItem.button?.image = nil
        statusItem.button?.attributedTitle = NSAttributedString(string: "")
        chipLogo.image = image
        chipHeadline.stringValue = truncateForBar(headline, max: 22)
        chipDescription.stringValue = truncateForBar(description, max: 28)
        chipLogo.isHidden = false
        chipHeadline.isHidden = false
        chipDescription.isHidden = false
    }

    /// Dark pill behind logo + texts, like the reference (opaque dark
    /// capsule + trailing status dot). Layer-backed status button — no
    /// deprecated statusItem.view involved. Called once at launch.
    private let chipDot = NSView(frame: NSRect(x: 0, y: 0, width: 6, height: 6))
    private let chipLogo = NSImageView(frame: NSRect(x: 7, y: 4, width: 18, height: 18))
    private let chipHeadline = NSTextField(labelWithString: "")
    private let chipDescription = NSTextField(labelWithString: "")

    private func setupChipPill() {
        guard let button = statusItem.button else { return }
        // Compact two-line micro chip: 16px tile + 9.5pt semibold headline /
        // 7.5pt secondary line + 6px status dot. Total text block ≈ 18pt so it
        // sits comfortably inside the ~22pt status bar without clipping.
        chipLogo.imageScaling = .scaleProportionallyDown
        chipHeadline.font = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
        chipHeadline.textColor = .white
        chipHeadline.lineBreakMode = .byTruncatingTail
        chipDescription.font = NSFont.systemFont(ofSize: 7.5, weight: .regular)
        chipDescription.textColor = NSColor(srgbRed: 0xB0 / 255.0, green: 0xB0 / 255.0, blue: 0xB8 / 255.0, alpha: 1)
        chipDescription.lineBreakMode = .byTruncatingTail
        button.addSubview(chipLogo)
        button.addSubview(chipHeadline)
        button.addSubview(chipDescription)
        button.imagePosition = .imageLeading
        button.imageScaling = .scaleProportionallyDown
        button.alignment = .left
        button.wantsLayer = true
        button.layer?.masksToBounds = true
        button.layer?.backgroundColor = NSColor(srgbRed: 0x2C / 255.0, green: 0x2C / 255.0, blue: 0x30 / 255.0, alpha: 0.95).cgColor
        button.layer?.cornerRadius = 8
        // (NSButton has no contentInsets: left padding comes from the tile
        // itself, right padding from the dot's 8pt trailing offset below.)
        chipDot.wantsLayer = true
        chipDot.layer?.cornerRadius = 3
        chipDot.layer?.backgroundColor = Coffee.textFaint.cgColor
        button.addSubview(chipDot)
    }

    /// Keep the dot pinned to the pill's right edge, colored by state.
    /// Called after fitChipWidth (order matters — widening moves the edge).
    private var chipDotColor: NSColor = Coffee.success

    private func placeChipDot(color: NSColor) {
        guard let button = statusItem.button else { return }
        let d: CGFloat = 6
        // statusItem.length is the source of truth: button.bounds can still
        // hold the PREVIOUS width on the frame where we widen the pill.
        let w = max(button.bounds.width, lastChipWidth)
        chipDot.frame = NSRect(x: w - 8 - d,
                               y: (button.bounds.height - d) / 2,
                               width: d, height: d)
        chipDot.layer?.backgroundColor = color.cgColor
    }

    /// Mac status area tile: accent rounded square + monogram, i.e. the reference
    /// pill's logo + headline (a description line can't fit the bar — it
    /// lives in the tooltip on hover and in the popover header instead).
    /// Mac status area tile cache — NSCache (bounded, main-thread only like all
    /// refreshUI callers) instead of an unbounded dict.
    private static let tileCache: NSCache<NSString, NSImage> = {
        let c = NSCache<NSString, NSImage>()
        c.countLimit = 40
        return c
    }()

    private static func hexToColor(_ hex: String) -> NSColor? {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255.0,
                       green: CGFloat((v >> 8) & 0xFF) / 255.0,
                       blue: CGFloat(v & 0xFF) / 255.0, alpha: 1)
    }

    private func chipTile(monogram: String, accentHex: String) -> NSImage? {
        let mono = monogram.isEmpty ? "☕" : monogram
        let key = (mono + "|" + accentHex) as NSString
        if let cached = Self.tileCache.object(forKey: key) { return cached }
        let pt: CGFloat = 16
        // Drawing-handler initializer: resolution-independent, crisp on Retina.
        let img = NSImage(size: NSSize(width: pt, height: pt), flipped: false) { dst in
            let path = NSBezierPath(roundedRect: dst, xRadius: pt * 0.3, yRadius: pt * 0.3)
            (Self.hexToColor(accentHex) ?? Coffee.gold).setFill()
            path.fill()
            let fs: CGFloat = mono.count > 1 ? pt * 0.4 : pt * 0.52
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fs, weight: .bold),
                .foregroundColor: NSColor.white
            ]
            let s = mono as NSString
            let ts = s.size(withAttributes: attrs)
            s.draw(at: NSPoint(x: dst.midX - ts.width / 2, y: dst.midY - ts.height / 2 - 0.5),
                   withAttributes: attrs)
            return true
        }
        img.isTemplate = false
        Self.tileCache.setObject(img, forKey: key)
        return img
    }

    /// Monogram for the tile: campaign logoText, else initials like the web.
    private func chipMonogram(logoText: String, sponsor: String) -> String {
        let t = logoText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return String(t.prefix(2)).uppercased() }
        let initials = sponsor.split(separator: " ").compactMap { $0.first }.map(String.init).joined()
        return String(initials.prefix(2)).uppercased()
    }

    // MARK: Status item click routing (left → popover, right → menu)

    @objc private func statusItemClicked(_ sender: Any) {
        guard let event = NSApp.currentEvent else {
            togglePopover()
            return
        }
        if event.type == .rightMouseUp || (event.type == .leftMouseUp && event.modifierFlags.contains(.control)) {
            showMenu()
        } else {
            togglePopover()
        }
    }

    private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
        } else if statusItem.button != nil {
            refreshUI()
            // Present on the next runloop turn, activated (only when another
            // app is frontmost — never steal focus otherwise): presenting a
            // transient popover synchronously inside the opening click's
            // mouse-up makes newer macOS dismiss it immediately, so the
            // panel never appears. Activation keeps .transient
            // click-outside-to-close semantics for a background app.
            if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
            DispatchQueue.main.async { [weak self] in
                guard let self, let button = self.statusItem.button,
                      !self.popover.isShown else { return }
                self.popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            }
        }
    }

    private func showMenu() {
        updateMenu()
        statusItem.menu = menu
        statusItem.button?.performClick(nil)   // opens the menu synchronously
        statusItem.menu = nil                  // restore left-click popover behavior
    }

    // MARK: Right-click menu

    private func buildMenu() {
        // Sponsor item — hidden unless a live campaign is showing (see
        // updateMenu). Opens the current campaign's validated https URL.
        let sponsor = NSMenuItem(title: "Sponsor: —",
                                 action: #selector(openCurrentCampaign(_:)), keyEquivalent: "")
        sponsor.target = self
        sponsor.isHidden = true
        menu.addItem(sponsor)
        sponsorMenuItem = sponsor

        // Acquisition slot — visible only when a feed is configured but
        // empty (see updateMenu). Opens the public advertiser pitch.
        let advertise = NSMenuItem(title: "Advertise here…",
                                   action: #selector(openAdvertisePageTapped(_:)), keyEquivalent: "")
        advertise.target = self
        advertise.isHidden = true
        menu.addItem(advertise)
        advertiseMenuItem = advertise

        menuPauseItem = NSMenuItem(title: "Pause earning", action: #selector(togglePause(_:)), keyEquivalent: "p")
        menuPauseItem.target = self
        menu.addItem(menuPauseItem)

        // Snooze submenu — the same choices as the popover button: pause
        // earning for 30 minutes, 2 hours, or 6 hours, or turn an active snooze off.
        let snoozeSub = NSMenu()
        snooze30Item = NSMenuItem(title: "Snooze 30 minutes",
                                  action: #selector(snooze30(_:)), keyEquivalent: "s")
        snooze30Item.target = self
        snoozeSub.addItem(snooze30Item)
        snooze2hItem = NSMenuItem(title: "Snooze 2 hours",
                                  action: #selector(snooze2h(_:)), keyEquivalent: "")
        snooze2hItem.target = self
        snoozeSub.addItem(snooze2hItem)
        snooze6hItem = NSMenuItem(title: "Snooze 6 hours",
                                  action: #selector(snooze6h(_:)), keyEquivalent: "")
        snooze6hItem.target = self
        snoozeSub.addItem(snooze6hItem)
        let restDay = NSMenuItem(title: "Snooze rest of day",
                                 action: #selector(snoozeRestOfDay(_:)), keyEquivalent: "")
        restDay.target = self
        snoozeSub.addItem(restDay)
        snoozeOffItem = NSMenuItem(title: "Turn off snooze",
                                   action: #selector(snoozeOff(_:)), keyEquivalent: "")
        snoozeOffItem.target = self
        snoozeOffItem.isEnabled = false
        snoozeSub.addItem(snoozeOffItem)

        let snoozeParent = NSMenuItem(title: "Snooze", action: nil, keyEquivalent: "")
        snoozeParent.submenu = snoozeSub
        menu.addItem(snoozeParent)

        // Launch at Login (SMAppService, macOS 13+). Only meaningful when
        // running from an .app bundle; updateMenu() disables the item for
        // the bare dev binary. See refreshLoginItem().
        loginItem = NSMenuItem(title: "Launch at Login",
                               action: #selector(toggleLaunchAtLogin(_:)), keyEquivalent: "l")
        loginItem.target = self
        menu.addItem(loginItem)

        // Updater: manual check is always available; auto-download (when a
        // verified DMG exists) is handled by the same engine on a 6 h timer.
        updateMenuItem = NSMenuItem(title: "Check for Updates…",
                                    action: #selector(checkForUpdatesTapped(_:)), keyEquivalent: "u")
        updateMenuItem.target = self
        menu.addItem(updateMenuItem)

        // Reload campaigns — visible only when a feed is configured.
        let reload = NSMenuItem(title: "Reload campaigns",
                                action: #selector(reloadCampaigns(_:)), keyEquivalent: "r")
        reload.target = self
        reload.isHidden = true
        menu.addItem(reload)
        reloadMenuItem = reload

        let about = NSMenuItem(title: "About FreeCoffee demo",
                               action: #selector(showAbout(_:)), keyEquivalent: "")
        about.target = self
        menu.addItem(about)

        menu.addItem(.separator())

        menu.addItem(NSMenuItem(title: "Quit FreeCoffee",
                                action: #selector(NSApplication.terminate(_:)),
                                keyEquivalent: "q"))
    }

    private func updateMenu() {
        if disabled {
            menuPauseItem.title = "Enable earning"
            menuPauseItem.state = .on
        } else if paused {
            menuPauseItem.title = "Resume earning"
            menuPauseItem.state = .on
        } else {
            menuPauseItem.title = "Pause earning"
            menuPauseItem.state = .off
        }
        // Live-feed items: sponsor (opens the current campaign) + reload.
        if let camp = currentLiveCampaign {
            sponsorMenuItem?.isHidden = false
            sponsorMenuItem?.title = "Sponsor: \(camp.sponsor) — LIVE"
            sponsorMenuItem?.toolTip = camp.tagline.isEmpty
                ? "Opens the live campaign page (https)"
                : camp.tagline
            advertiseMenuItem?.isHidden = true
        } else {
            sponsorMenuItem?.isHidden = true
            sponsorMenuItem?.title = "Sponsor: —"
            // Feed configured but empty: offer the slot instead of a dead end.
            advertiseMenuItem?.isHidden = (adFeedURL == nil)
        }
        // Snooze submenu state: the duration items start a snooze; "Turn
        // off snooze" is only enabled (and check-marked) while one is active.
        let snoozing = snoozed
        snooze30Item?.state = .off
        snooze2hItem?.state = .off
        snooze6hItem?.state = .off
        snoozeOffItem?.isEnabled = snoozing
        snoozeOffItem?.state = snoozing ? .on : .off
        reloadMenuItem?.isHidden = (adFeedURL == nil)
        refreshLoginItem()

        // Updater item: reflects the live engine state (see UpdateEngine.Status).
        switch updateEngine.status {
        case .checking:
            updateMenuItem?.title = "Checking for Updates…"
            updateMenuItem?.isEnabled = false
        case .downloading:
            updateMenuItem?.title = "Downloading update…"
            updateMenuItem?.isEnabled = false
        case .available:
            updateMenuItem?.title = "Update Available — Open Releases Page"
            updateMenuItem?.isEnabled = true
        case .ready:
            updateMenuItem?.title = "Update & Relaunch"
            updateMenuItem?.isEnabled = true
        case .failed:
            updateMenuItem?.title = "Update Check Failed — Try Again"
            updateMenuItem?.isEnabled = true
        case .upToDate, .idle:
            updateMenuItem?.title = "Check for Updates…"
            updateMenuItem?.isEnabled = true
        }
    }

    /// NSMenuItem validation: the sponsor item is only clickable when the
    /// current campaign carries a validated https clickUrl, and "Turn off
    /// snooze" is only enabled while a snooze is actually active (the
    /// menu's auto-enabling asks here, so updateMenu's isEnabled alone
    /// wouldn't stick).
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem == sponsorMenuItem {
            guard let camp = currentLiveCampaign else { return false }
            return FeedValidate.httpsURL(camp.clickUrl) != nil
        }
        if menuItem == snoozeOffItem { return snoozed }
        return true
    }

    /// Open the current live campaign's clickUrl — https only, via
    /// NSWorkspace (the same rule as everywhere else: no other schemes).
    @objc private func openCurrentCampaign(_ sender: NSMenuItem) {
        guard let camp = currentLiveCampaign,
              let url = FeedValidate.httpsURL(camp.clickUrl) else { return }
        NSWorkspace.shared.open(url)
    }

    /// Menu action: force a fresh fetch of the configured feed.
    @objc private func reloadCampaigns(_ sender: NSMenuItem) {
        fetchLiveCampaigns()
    }

    // MARK: Launch at Login (bundled app only — see buildMenu note)

    private func refreshLoginItem() {
        if loginItemFailed {
            // A failed toggle stays failed until one succeeds — otherwise
            // the next refreshUI() would silently re-arm a broken switch.
            loginItem.action = nil
            loginItem.title = "Launch at Login (unavailable)"
            loginItem.state = .off
            return
        }
        if #available(macOS 13.0, *),
           Bundle.main.bundleURL.pathExtension == "app" {
            loginItem.action = #selector(toggleLaunchAtLogin(_:))
            switch SMAppService.mainApp.status {
            case .enabled:
                loginItem.title = "Launch at Login"
                loginItem.state = .on
            case .requiresApproval:
                loginItem.title = "Launch at Login — approve in System Settings"
                loginItem.state = .off
            default:
                loginItem.title = "Launch at Login"
                loginItem.state = .off
            }
        } else {
            // Bare dev binary (or pre-13 macOS): there is no bundle identity
            // to register, so show the item disabled instead of risking a
            // crash. nil action renders it grayed out like the info rows.
            loginItem.action = nil
            loginItem.title = "Launch at Login (app bundle only)"
            loginItem.state = .off
        }
    }

    @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            // Non-fatal: on failure show a disabled state rather than a
            // toggle that would silently do nothing.
            NSLog("FreeCoffee: launch-at-login toggle failed (non-fatal): \(error.localizedDescription)")
            loginItemFailed = true
            refreshLoginItem()
            return
        }
        loginItemFailed = false
        refreshLoginItem()
    }

    // MARK: Update handling (see UpdateEngine — anonymous, checksum-verified)

    /// Silent check on launch + every 6 h. Auto-download only when a verified
    /// DMG can be staged; a version the user "skipped" is never re-prompted.
    private func scheduleUpdateCheck() {
        updateEngine.onStatusChange = { [weak self] newStatus in
            self?.handleUpdateStatus(newStatus)
        }
        updateEngine.checkForUpdate()
        let timer = Timer.scheduledTimer(timeInterval: UpdateEngine.checkInterval, target: self,
                                         selector: #selector(updateTimerTick), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
    }

    @objc private func updateTimerTick() {
        guard !isManualCheck else { return }
        updateEngine.checkForUpdate()
    }

    private func handleUpdateStatus(_ newStatus: UpdateEngine.Status) {
        refreshUI()
        switch newStatus {
        case .failed(let reason):
            NSLog("FreeCoffee updater: \(reason)")
            if isManualCheck {
                isManualCheck = false
                dialog(title: "Update check failed",
                       body: "FreeCoffee could not check for updates:\n\(reason)\n\nYou can always download the latest build from the releases page.")
            }

        case .available(let version, _):
            if isManualCheck {
                isManualCheck = false
                dialog(title: "Update available — v\(version)",
                       body: "The latest release is v\(version). This dev build has no installed app bundle to update, so grab the new DMG from the releases page.",
                       button: "Open Releases Page") { [weak self] in self?.updateEngine.openReleasesPage() }
            }

        case .upToDate(let current):
            if isManualCheck {
                isManualCheck = false
                dialog(title: "You're up to date",
                       body: "FreeCoffee v\(current) is the latest version.")
            }

        case .ready(let version):
            // Auto path completed: new app staged. Offer one-click install,
            // skip-this-version, or dismiss (applies on next launch either way
            // unless skipped — a skipped version is never re-downloaded).
            if updateSeen != version { updateSeen = version; persist() }
            let alert = NSAlert()
            alert.messageText = "Update ready — v\(version)"
            alert.informativeText = "FreeCoffee v\(version) has been downloaded and verified (checksum OK).\n\nUpdate & Relaunch now, or keep working — the update applies automatically the next time you open the app."
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Update & Relaunch")
            alert.addButton(withTitle: "Skip this version")
            alert.addButton(withTitle: "Later")
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn {
                updateAndRelaunchTapped()
            } else if choice == .alertSecondButtonReturn {
                updateEngine.skipCurrentVersion(version)
                // A skipped version must never install later: drop the
                // staged bundle + pending marker, not just the preference.
                updateEngine.discardStagedUpdate()
                persist()
            }

        case .checking, .downloading:
            break

        case .idle:
            // A superseded check (cancelled by a newer one) lands here —
            // release the manual flag so future ticks keep working.
            isManualCheck = false
        }
    }

    @objc private func checkForUpdatesTapped(_ sender: NSMenuItem) {
        isManualCheck = true
        updateEngine.checkForUpdate(force: true) { [weak self] _ in
            self?.refreshUI()
        }
        refreshUI()
    }

    @objc private func updateAndRelaunchTapped() {
        UpdateEngine.applyPendingUpdateAndRelaunch()
        // If we get here there was nothing staged (e.g. user acted after the
        // temp dir was cleaned) — fall back to the releases page.
        updateEngine.openReleasesPage()
    }

    // MARK: Timers

    private func scheduleTimers() {
        let heartbeat = Timer.scheduledTimer(timeInterval: 1, target: self,
                                             selector: #selector(countdownTick),
                                             userInfo: nil, repeats: true)
        RunLoop.main.add(heartbeat, forMode: .common)
    }

    private var snoozed: Bool {
        snoozeUntil != nil && snoozeUntil! > Date()
    }

    private func resetEligibility() {
        eligibility.reset()
        demoEligible = false
    }

    private func idleSeconds() -> TimeInterval? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString,
                                                         kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else {
            return nil
        }
        return value.doubleValue / 1_000_000_000
    }

    private var placementVisible: Bool {
        guard popover.isShown, NSApp.isActive,
              let window = popoverVC?.view.window, window.isVisible, window.isKeyWindow,
              window.alphaValue == 1, window.occlusionState.contains(.visible),
              let screen = window.screen, screen.visibleFrame.contains(window.frame),
              !popoverVC.view.isHiddenOrHasHiddenAncestor else { return false }
        return true
    }

    @objc private func earnTick() {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool == true
        let locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? true
        var conditions = DemoEligibility.Conditions()
        conditions.paused = paused
        conditions.disabled = disabled
        conditions.snoozed = snoozed
        conditions.awake = isAwake && displaysAwake
        conditions.unlocked = sessionActive && onConsole && !screenLocked && !locked
        conditions.idleSeconds = idleSeconds()
        conditions.placementVisible = placementVisible
        conditions.demo = adFeedURL == nil
        conditions.creative = demoSponsor
        demoEligible = conditions.eligible
        guard eligibility.sample(at: clock(), conditions: conditions) else { return }
        let now = Date()
        let credit = demoAccrual.credit(on: now)
        balanceCents += credit.balance
        history[dayKey(now), default: 0] += credit.today
        todayCents = history[dayKey(now), default: 0]
        lastTick = now
        persist()
        campaignRotateTick()
    }

    @objc private func countdownTick() {
        if let until = snoozeUntil, until <= Date() {
            snoozeUntil = nil
            resetEligibility()
            persist()
        }
        todayCents = history[dayKey(Date()), default: 0]
        earnTick()
        refreshUI()
    }

    func popoverWillClose(_ notification: Notification) {
        resetEligibility()
    }

    // MARK: Real-advertiser bridge (config.json → feed → cache → UI)

    private func scheduleLiveFeedTimers() {
        guard adFeedURL != nil else { return }

        // Refresh the feed every 30 minutes. The fetch itself runs on the
        // URLSession background queue; only the UI update lands on main.
        // (The 60 s rotation tick lives in scheduleTimers — it also drives
        // the demo-sponsor rotation when no feed is configured.)
        let refresh = Timer.scheduledTimer(timeInterval: FeedLimits.refreshInterval,
                                           target: self,
                                           selector: #selector(feedRefreshTick),
                                           userInfo: nil, repeats: true)
        RunLoop.main.add(refresh, forMode: .common)
        feedRefreshTimer = refresh
    }

    @objc private func feedRefreshTick() {
        fetchLiveCampaigns()
    }

    @objc private func campaignRotateTick() {
        guard !snoozed, !paused, !disabled, isAwake, displaysAwake, sessionActive, !screenLocked else { return }
        resetEligibility()
        if liveCampaigns.count > 1 {
            liveCampaignIndex = (liveCampaignIndex + 1) % liveCampaigns.count
        } else if adFeedURL == nil {
            demoSponsorIndex = (demoSponsorIndex + 1) % Self.demoSponsors.count
        }
        refreshUI()
    }

    /// Fetch + validate the configured feed on a background queue, then
    /// apply on main. On any failure the last-good campaigns stay showing
    /// (and the fictional sponsors remain the fallback when there are none).
    func fetchLiveCampaigns() {
        guard let feedURL = adFeedURL else { return }
        let client = feedClient ?? CampaignFeedClient()
        feedClient = client
        client.fetchCampaigns(from: feedURL) { [weak self] campaigns, error in
            guard let self = self else { return }
            self.resetEligibility()
            if let campaigns = campaigns, !campaigns.isEmpty {
                // Auction order: highest CPM first, floor applied (pickAd
                // mirrors assets/js/demo.js). Below-floor campaigns are
                // filtered out entirely — but a filter that removes
                // everything keeps the last-good list, it never blanks live UI.
                self.saveCampaignCache(campaigns)
                let eligible = pickAd(campaigns, minCpm: self.minCPM)
                if eligible.isEmpty {
                    NSLog("FreeCoffee: live feed has no campaigns above the minCPM floor — keeping last-good list")
                } else {
                    self.liveCampaigns = eligible
                    self.liveCampaignIndex = 0
                }
            } else if let error = error {
                // Non-fatal: keep last-good campaigns (or fictional sponsors).
                NSLog("FreeCoffee: live feed unavailable (non-fatal): \(error)")
            }
            self.refreshUI()
        }
    }

    private static func supportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("FreeCoffee", isDirectory: true)
    }

    private static func configURL() -> URL {
        supportDirectory().appendingPathComponent("config.json")
    }

    private static func campaignCacheURL() -> URL {
        supportDirectory().appendingPathComponent("campaigns-cache.json")
    }

    /// Read config.json → { "adFeedURL": "https://…", "minCPM": 2.5 }. Both
    /// fields optional; minCPM defaults to 0 (no floor) and is clamped to the
    /// same 0–100 range as campaign cpm, so old config.json files stay valid.
    /// Any failure (missing file, malformed JSON, non-https URL) means "no
    /// live feed" — the demo sponsors keep running. Do/catch, non-fatal.
    private func loadLiveFeedConfig() {
        do {
            let data = try Data(contentsOf: Self.configURL())
            let config = try JSONDecoder().decode(FeedConfig.self, from: data)
            adFeedURL = FeedValidate.httpsURL(config.adFeedURL)
            let floor = config.minCPM ?? 0
            minCPM = floor.isFinite
                ? min(FeedLimits.cpmRange.upperBound, max(FeedLimits.cpmRange.lowerBound, floor))
                : 0
        } catch {
            // No config / unreadable / wrong shape — fictional sponsors.
            adFeedURL = nil
            minCPM = 0
        }
    }

    /// Persist the last-good campaign list (best-effort, non-fatal).
    private func saveCampaignCache(_ campaigns: [LiveCampaign]) {
        let cache = CampaignCache(fetchedAt: Date(),
                                  feedURL: adFeedURL?.absoluteString ?? "",
                                  campaigns: campaigns)
        do {
            let url = Self.campaignCacheURL()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(cache)
            try data.write(to: url, options: .atomic)
        } catch {
            NSLog("FreeCoffee: campaign cache write failed (non-fatal): \(error.localizedDescription)")
        }
    }

    /// Load the last-good campaign list (re-validated — the cache file is
    /// user-visible). Failures, or a cache from a different feed URL than
    /// the one currently configured, fall back to the fictional sponsors.
    private func loadCampaignCache() -> [LiveCampaign] {
        do {
            let data = try Data(contentsOf: Self.campaignCacheURL())
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let cache = try decoder.decode(CampaignCache.self, from: data)
            guard cache.feedURL == adFeedURL?.absoluteString else { return [] }
            return sanitizeCampaigns(cache.campaigns)
        } catch {
            return []
        }
    }

    /// Re-apply the validation caps to an already-structured list (used for
    /// the cache file, which is readable/editable outside the app).
    private func sanitizeCampaigns(_ campaigns: [LiveCampaign]) -> [LiveCampaign] {
        var seen = Set<String>()
        var out: [LiveCampaign] = []
        for camp in campaigns where out.count < FeedLimits.maxCampaigns {
            let sponsor = FeedValidate.trimmed(camp.sponsor, cappedTo: FeedLimits.sponsorMax)
            guard !sponsor.isEmpty else { continue }
            let id = FeedValidate.trimmed(camp.id, cappedTo: FeedLimits.idMax)
            let finalID = id.isEmpty ? "camp_\(out.count + 1)" : id
            guard !seen.contains(finalID) else { continue }
            seen.insert(finalID)
            var fixed = camp
            fixed.id = finalID
            fixed.sponsor = sponsor
            fixed.tagline = FeedValidate.trimmed(camp.tagline, cappedTo: FeedLimits.taglineMax)
            fixed.clickUrl = FeedValidate.httpsURL(camp.clickUrl)?.absoluteString ?? ""
            fixed.cpm = min(FeedLimits.cpmRange.upperBound, max(FeedLimits.cpmRange.lowerBound, camp.cpm.isFinite ? camp.cpm : 0))
            fixed.logoText = FeedValidate.trimmed(camp.logoText, cappedTo: FeedLimits.logoTextMax)
            fixed.accent = FeedValidate.hexColor(camp.accent) ?? FeedLimits.defaultAccent
            out.append(fixed)
        }
        return out
    }

    // MARK: Actions

    @objc private func togglePause(_ sender: NSMenuItem) {
        resetEligibility()
        if disabled {
            // The menu says "Enable earning": clear every earning blocker.
            disabled = false
            paused = false
        } else {
            paused.toggle()
        }
        if !paused { snoozeUntil = nil }   // manual resume clears any snooze
        refreshUI()
        persist()
    }

    /// Snooze = pause earning for a chosen duration with a live countdown.
    /// The deadline persists to ledger.json (snoozeUntil, ISO date) and
    /// auto-resumes via the Date-based checks in the timers.
    func snoozeToggled() {
        resetEligibility()
        guard let submenu = snooze30Item?.menu, let button = statusItem.button else { return }
        updateMenu()
        submenu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.minY), in: button)
    }

    /// Start a snooze of `minutes` (30 min from the popover; 30 min, 2 h, or
    /// 6 h from the right-click submenu). While snoozed: no earning ticks, no
    /// live-ad rotation, and the chip reads "snoozed until HH:MM".
    func startSnooze(minutes: TimeInterval) {
        guard minutes.isFinite, minutes > 0 else { return }
        resetEligibility()
        snoozeUntil = Date().addingTimeInterval(minutes * 60)
        refreshUI()
        persist()
    }

    /// Turn an active snooze off immediately (popover button or submenu).
    func snoozeOff() {
        resetEligibility()
        snoozeUntil = nil
        refreshUI()
        persist()
    }

    // MARK: Right-click menu actions (snooze submenu)

    @objc private func snooze30(_ sender: NSMenuItem) {
        startSnooze(minutes: 30)
    }

    @objc private func snooze2h(_ sender: NSMenuItem) {
        startSnooze(minutes: 2 * 60)
    }

    @objc private func snooze6h(_ sender: NSMenuItem) {
        startSnooze(minutes: 6 * 60)
    }

    @objc private func snoozeRestOfDay(_ sender: NSMenuItem) {
        guard let deadline = restOfDayDeadline(from: Date()) else { return }
        resetEligibility()
        snoozeUntil = deadline
        refreshUI()
        persist()
    }

    @objc private func snoozeOff(_ sender: NSMenuItem) {
        snoozeOff()
    }

    /// Disable = persisted earning kill-switch until re-enabled.
    func disableToggled() {
        resetEligibility()
        disabled.toggle()
        if !disabled {
            snoozeUntil = nil
            paused = false
        }
        refreshUI()
        persist()
    }

    func openDashboard() {
        guard let dashURL = Self.dashboardURL else { return }
        if !NSWorkspace.shared.open(dashURL) {
            dialog(title: "Dashboard unavailable",
                   body: "FreeCoffee couldn't open the dashboard. Visit https://freecoffee.tech/dashboard.html in your browser.")
        }
    }

    func openAccount() {
        guard let profURL = Self.profileURL else { return }
        if !NSWorkspace.shared.open(profURL) {
            dialog(title: "Profile unavailable",
                   body: "FreeCoffee couldn't open the profile page. Visit https://freecoffee.tech/profile.html in your browser.")
        }
    }

    /// Public advertiser pitch (empty-inventory CTA). Unlike the dashboard
    /// links above this is the live site, not the local demo server.
    func openAdvertisePage() {
        guard let url = Self.advertiseURL else { return }
        if !NSWorkspace.shared.open(url) {
            dialog(title: "Advertiser page unavailable",
                   body: "FreeCoffee couldn't open the advertiser page. Visit https://freecoffee.tech/advertisers.html in your browser.")
        }
    }

    @objc private func openAdvertisePageTapped(_ sender: NSMenuItem) {
        openAdvertisePage()
    }

    @objc private func showAbout(_ sender: NSMenuItem) {
        let alert = NSAlert()
        alert.messageText = "FreeCoffee demo"
        alert.informativeText = """
        Your Mac status area buys the coffee. Mac status area advertising demo — without a configured ad feed, \
        sponsors, bids, and earnings are simulated; no real money moves and nothing is collected: \
        no screen contents, files, browser history, keystrokes, screenshots, or window titles. \
        Optionally, config.json can point at an HTTPS advertiser feed — the app fetches that one \
        URL (nothing is sent back) and shows those campaigns marked LIVE; their earnings settle \
        once the platform backend is live. The app checks GitHub Releases for updates (anonymous, \
        one-way) and installs checksum-verified updates with your click. Balances also read as \
        "≈ N cups" (1 cup = $5).
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Two-button alert: default button runs `action` when chosen.
    private func dialog(title: String, body: String, button: String, action: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .informational
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn { action() }
    }

    /// Single-button informational alert.
    private func dialog(title: String, body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: Sleep / wake (the only external signal — see privacy note above)

    private func observeSleepWake() {
        let center = NSWorkspace.shared.notificationCenter
        let signals: [(Notification.Name, (AppDelegate) -> Void)] = [
            (NSWorkspace.willSleepNotification, { $0.isAwake = false }),
            (NSWorkspace.didWakeNotification, { $0.isAwake = true }),
            (NSWorkspace.screensDidSleepNotification, { $0.displaysAwake = false }),
            (NSWorkspace.screensDidWakeNotification, { $0.displaysAwake = true }),
            (NSWorkspace.sessionDidResignActiveNotification, { $0.sessionActive = false }),
            (NSWorkspace.sessionDidBecomeActiveNotification, { $0.sessionActive = true }),
            (NSWorkspace.activeSpaceDidChangeNotification, { _ in })
        ]
        for (name, update) in signals {
            eligibilityObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                update(self)
                self.resetEligibility()
                self.refreshUI()
            })
        }
        for (name, locked) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            eligibilityObservers.append(DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                    self?.screenLocked = locked
                    self?.resetEligibility()
                    self?.refreshUI()
                })
        }
        for name in [NSApplication.didResignActiveNotification, NSApplication.didChangeScreenParametersNotification,
                     NSWindow.didResignKeyNotification, NSWindow.didChangeOcclusionStateNotification,
                     NSWindow.willMoveNotification, NSWindow.didResizeNotification, NSWindow.didChangeScreenNotification] {
            eligibilityObservers.append(NotificationCenter.default.addObserver(
                forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.resetEligibility()
                })
        }
    }

    // MARK: Persistence (do/catch, non-fatal on failure)

    private static func ledgerURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base
            .appendingPathComponent("FreeCoffee", isDirectory: true)
            .appendingPathComponent("ledger.json")
    }

    private func pruneHistory() {
        // Keep the last 14 day buckets — more than the 7-day chart needs.
        let cutoff = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date()
        let cutoffKey = dayKey(cutoff)
        history = history.filter { $0.key >= cutoffKey }
    }

    private func persist() {
        pruneHistory()
        let url = Self.ledgerURL()
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let state = FreeCoffeeState(balance: Double(balanceCents) / 100.0,
                                        today: Double(todayCents) / 100.0,
                                        paused: paused,
                                        disabled: disabled,
                                        snoozeUntil: snoozeUntil,
                                        history: history,
                                        lastTick: lastTick,
                                        updateSkipped: updateEngine.skippedVersion,
                                        updateSeen: updateSeen,
                                        demoAccrual: demoAccrual)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(state)
            try data.write(to: url, options: .atomic)
        } catch {
            // Non-fatal: the demo keeps running from memory.
            NSLog("FreeCoffee: persist failed (non-fatal): \(error.localizedDescription)")
        }
    }

    private func loadState() {
        let url = Self.ledgerURL()
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let state = try decoder.decode(FreeCoffeeState.self, from: data)
            balanceCents = Int((state.balance * 100).rounded())
            todayCents = Int((state.today * 100).rounded())
            paused = state.paused
            disabled = state.disabled
            snoozeUntil = state.snoozeUntil
            history = state.history
            lastTick = state.lastTick
            updateSeen = state.updateSeen
            demoAccrual = state.demoAccrual
            demoAccrual.balanceRemainder = min(9_999, max(0, demoAccrual.balanceRemainder))
            demoAccrual.dayRemainder = min(9_999, max(0, demoAccrual.dayRemainder))
            todayCents = history[dayKey(Date()), default: 0]
            updateEngine.skippedVersion = state.updateSkipped
            if let until = snoozeUntil, until <= Date() {
                // Stale snooze from a previous run — start fresh.
                snoozeUntil = nil
            }
        } catch {
            if FileManager.default.fileExists(atPath: url.path) {
                // Present but undecodable: quarantine for inspection instead
                // of silently discarding the user's earned balance.
                let backup = url.deletingLastPathComponent()
                    .appendingPathComponent("ledger-corrupt-\(Int(Date().timeIntervalSince1970)).json")
                try? FileManager.default.moveItem(at: url, to: backup)
                NSLog("FreeCoffee: ledger.json unreadable — moved to \(backup.lastPathComponent), reseeding demo balance")
            }
            // First run (or quarantined file): seed the demo balance and a
            // 7-day history consistent with the web demo's ledger.
            balanceCents = Self.demoSeedBalanceCents
            todayCents = 0
            paused = false
            disabled = false
            snoozeUntil = nil
            lastTick = nil
            updateSeen = nil
            history = [:]
            let cal = Calendar.current
            for (offset, cents) in Self.demoSeedWeek.enumerated() {
                guard let day = cal.date(byAdding: .day, value: -(6 - offset), to: Date()) else { continue }
                history[dayKey(day)] = cents
            }
            todayCents = history[dayKey(Date())] ?? 0
        }
    }
}

// MARK: - Agent app entry point (no xcodeproj, no dock icon)

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
