/*
 * FreeCoffeeMenuBar.swift
 * =======================
 * FreeCoffee demo — a single-file macOS menu-bar app (AppKit + Foundation only,
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
 *       header row (icon, name + subtitle, status dot "Earning"/"Waiting"),
 *       divider, TOTAL BALANCE block (oversized mono figure + cups hint +
 *       right-aligned available/pending), the caramel "65% base share —
 *       always on" boost line, an "Earnings · 7 days" inset bar chart
 *       (custom NSView, weekday letters M T W T F S S + value labels, drawn
 *       from the persisted day-by-day ledger history), the gray rearrange
 *       tip line, a divider, and a footer with four buttons:
 *       Settings (opens the demo dashboard), Snooze (pause 30 min with a
 *       live countdown), Disable (persisted earning toggle), Account
 *       (opens the demo profile page).
 *   • RIGHT-CLICK the status item → a menu: Sponsor (live feed only — opens
 *       the current campaign's https click URL), Pause toggle, Reload
 *       campaigns (live feed only), Launch at Login (bundled app only),
 *       About, Quit.
 *
 * REAL-ADVERTISER BRIDGE (the only network code, opt-in):
 *   If ~/Library/Application Support/FreeCoffee/config.json contains
 *   { "adFeedURL": "https://…" }, the app fetches that HTTPS feed on launch
 *   and every 30 minutes, validates it field-by-field (https-only click
 *   URLs, trimmed/capped strings, cpm clamped 0–100, deduped by id, cap 20
 *   — mirroring assets/js/demo.js → fetchLiveCampaigns), caches the last
 *   good list to campaigns-cache.json, and shows those campaigns in the
 *   menu-bar chip and popover, marked LIVE. Highest bid wins: the shown
 *   list is pickAd(campaigns, minCPM) — sorted cpm DESC (ties by id ASC),
 *   and campaigns below the optional config.json "minCPM" floor (default 0)
 *   are filtered out entirely. Any failure falls back to the fictional
 *   demo sponsors. No identifiers or telemetry are sent — the configured
 *   feed URL is the single outbound request.
 *
 * ------------------------------------------------------------------------
 * PRIVACY BOUNDARY — the whole contract, in one paragraph:
 *
 * FreeCoffee collects nothing and sends nothing anywhere. The only network
 * code is the opt-in real-advertiser bridge described above: it reads the
 * one HTTPS feed URL the user configured, and sends nothing back — no
 * identifiers, no telemetry, no impression or earnings data. It never reads
 * screen contents, files, browser history, keystrokes, screenshots, or
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

/// The persisted shape: ~/Library/Application Support/FreeCoffee/ledger.json
/// `history` maps yyyy-MM-dd → cents earned that day (drives the 7-day chart).
private struct FreeCoffeeState: Codable {
    var balance: Double
    var today: Double
    var paused: Bool
    var disabled: Bool
    var snoozeUntil: Date?
    var history: [String: Int]
    var lastTick: Date?
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
    private let statusLabel = NSTextField(labelWithString: "Earning")
    private let sponsorLine = NSTextField(labelWithString: "")
    private let balanceField = NSTextField(labelWithString: "$0.00")
    private let splitLabel = NSTextField(labelWithString: "")
    private let cupsLabel = NSTextField(labelWithString: "")
    private let snoozeButton = NSButton(title: "Snooze", target: nil, action: nil)
    private let disableButton = NSButton(title: "Disable", target: nil, action: nil)
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

        // ---- Header row: icon tile, name + subtitle, status dot + label.
        let iconTile = NSView()
        iconTile.wantsLayer = true
        iconTile.layer?.backgroundColor = Coffee.gold.cgColor
        iconTile.layer?.cornerRadius = 8
        iconTile.translatesAutoresizingMaskIntoConstraints = false
        let iconView = NSImageView()
        iconView.image = NSImage(systemSymbolName: "cup.and.saucer.fill",
                                 accessibilityDescription: "FreeCoffee")
        iconView.contentTintColor = Coffee.panel
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconTile.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconTile.widthAnchor.constraint(equalToConstant: 30),
            iconTile.heightAnchor.constraint(equalToConstant: 30),
            iconView.centerXAnchor.constraint(equalTo: iconTile.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconTile.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 17),
            iconView.heightAnchor.constraint(equalToConstant: 17)
        ])

        let nameStack = NSStackView()
        nameStack.orientation = .vertical
        nameStack.alignment = .leading
        nameStack.spacing = 1
        let name = NSTextField(labelWithString: "☕ FreeCoffee")
        name.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        name.textColor = Coffee.text
        let subtitle = NSTextField(labelWithString: "Menu-bar advertising · demo")
        subtitle.font = NSFont.systemFont(ofSize: 9.5)
        subtitle.textColor = Coffee.textFaint
        // Popover header sponsor line — carries the live campaign
        // (sponsor + tagline) when a feed is configured, hidden otherwise.
        sponsorLine.font = NSFont.systemFont(ofSize: 9.5, weight: .medium)
        sponsorLine.textColor = Coffee.goldBright
        sponsorLine.isHidden = true
        nameStack.addArrangedSubview(name)
        nameStack.addArrangedSubview(subtitle)
        nameStack.addArrangedSubview(sponsorLine)

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
            tracked("TOTAL BALANCE", size: 8.5, weight: .bold, color: Coffee.textFaint))
        balanceField.font = NSFont.monospacedDigitSystemFont(ofSize: 27, weight: .bold)
        balanceField.textColor = Coffee.text
        splitLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular)
        splitLabel.textColor = Coffee.textFaint
        splitLabel.alignment = .right
        cupsLabel.font = NSFont.systemFont(ofSize: 10)
        cupsLabel.textColor = Coffee.textFaint

        // ---- Boost line (caramel gradient tint).
        let boost = NSTextField(labelWithString: "☕ 65% base share — always on")
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
        NSLayoutConstraint.activate([
            boost.leadingAnchor.constraint(equalTo: boostBox.leadingAnchor, constant: 10),
            boost.trailingAnchor.constraint(equalTo: boostBox.trailingAnchor, constant: -10),
            boost.topAnchor.constraint(equalTo: boostBox.topAnchor, constant: 6),
            boost.bottomAnchor.constraint(equalTo: boostBox.bottomAnchor, constant: -6),
            boostBox.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32)
        ])

        // ---- Earnings · 7 days + chart.
        let weekCaption = NSTextField(labelWithAttributedString:
            tracked("EARNINGS · 7 DAYS", size: 8.5, weight: .bold, color: Coffee.textFaint))
        chartView.widthAnchor.constraint(equalToConstant: 268).isActive = true
        chartView.heightAnchor.constraint(equalToConstant: 84).isActive = true

        // ---- Tip line.
        let tip = NSTextField(wrappingLabelWithString:
            "Tip: Hold ⌘ and drag menu-bar items to rearrange them.")
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
        root.addArrangedSubview(divider())
        root.addArrangedSubview(totalCaption)
        root.addArrangedSubview(balanceField)
        root.addArrangedSubview(splitLabel)
        root.addArrangedSubview(cupsLabel)
        root.addArrangedSubview(boostBox)
        root.addArrangedSubview(weekCaption)
        root.addArrangedSubview(chartView)
        root.addArrangedSubview(tip)
        root.addArrangedSubview(divider())
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

    private func divider() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Coffee.line.cgColor
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        line.widthAnchor.constraint(equalTo: view.widthAnchor, constant: -32).isActive = true
        return line
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
        let earning = !state.disabled && !state.paused && app.isAwake
        let (dotColor, textColor, label): (NSColor, NSColor, String) = {
            if state.disabled { return (Coffee.textFaint, Coffee.textFaint, "Disabled") }
            if !earning { return (Coffee.waiting, Coffee.waiting, "Waiting") }
            return (Coffee.success, Coffee.success, "Earning")
        }()
        statusDot.layer?.backgroundColor = dotColor.cgColor
        statusLabel.textColor = textColor
        if let camp = app.currentLiveCampaign {
            statusLabel.stringValue = label + " · LIVE"
            sponsorLine.stringValue = "LIVE · \(camp.sponsor)" +
                (camp.tagline.isEmpty ? "" : " — \(camp.tagline)")
            sponsorLine.isHidden = false
        } else {
            statusLabel.stringValue = label
            sponsorLine.stringValue = ""
            sponsorLine.isHidden = true
        }

        balanceField.stringValue = money(state.balanceCents)
        splitLabel.stringValue = "available \(money(state.availableCents)) · pending \(money(state.pendingCents))"
        cupsLabel.stringValue = "≈ \(state.balanceCents / 500) cups of coffee"

        chartView.values = state.weekValues
        chartView.labels = state.weekLetters
        chartView.needsDisplay = true

        // Snooze button shows the live countdown while snoozed.
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

final class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: State (main thread only — timers and notifications are main-bound)

    private(set) var balanceCents = 0
    private(set) var todayCents = 0
    private(set) var paused = false
    private(set) var disabled = false
    private(set) var snoozeUntil: Date?
    private(set) var isAwake = true
    private var history: [String: Int] = [:]   // yyyy-MM-dd → cents earned
    private var lastTick: Date?

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let menu = NSMenu()
    private var popoverVC: PopoverViewController!

    private var menuPauseItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var countdownTimer: Timer?

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
    private var reloadMenuItem: NSMenuItem?        // "Reload campaigns" (feed only)

    /// The campaign currently shown on the chip + popover header (or nil
    /// when running on the fictional demo sponsors).
    fileprivate var currentLiveCampaign: LiveCampaign? {
        guard !liveCampaigns.isEmpty else { return nil }
        return liveCampaigns[liveCampaignIndex % liveCampaigns.count]
    }

    // Demo pages. In production these would be the signed-in web app; for the
    // demo they point at the local static server from README.md
    // (cd freecoffee && python3 -m http.server 8090).
    private static let dashboardURL = URL(string: "http://127.0.0.1:8090/dashboard.html")!
    private static let profileURL = URL(string: "http://127.0.0.1:8090/profile.html")!

    // First run is seeded to match the web demo's deterministic ledger
    // (seed 42 lifetime, $28.55), so both layers tell the same story.
    // The seven seeded day buckets sum to exactly 2855 cents.
    private static let demoSeedBalanceCents = 2855
    private static let demoSeedWeek: [Int] = [180, 420, 390, 510, 460, 495, 400]

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        loadState()

        statusItem.button?.title = "☕ FreeCoffee"
        statusItem.button?.toolTip = "FreeCoffee demo — simulated data. Nothing is collected."

        buildMenu()

        popoverVC = PopoverViewController()
        popoverVC.app = self
        popover.contentViewController = popoverVC
        popover.behavior = .transient
        popover.appearance = NSAppearance(named: .darkAqua)

        // LEFT-click → popover; RIGHT-click → menu (see statusItemClicked).
        statusItem.button?.action = #selector(statusItemClicked(_:))
        statusItem.button?.target = self

        observeSleepWake()
        scheduleTimers()

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
        // Menu-bar chip: shows the current live sponsor when a feed is
        // connected, the plain FreeCoffee brand otherwise.
        if let camp = currentLiveCampaign {
            statusItem.button?.title = "☕ " + truncateForBar(camp.sponsor)
            statusItem.button?.toolTip = "FreeCoffee — LIVE campaign: \(camp.sponsor). " +
                "Nothing is collected; the configured feed URL is the only outbound request."
        } else {
            statusItem.button?.title = "☕ FreeCoffee"
            statusItem.button?.toolTip = "FreeCoffee demo — simulated data. Nothing is collected."
        }
        popoverVC?.refresh()
        updateMenu()
    }

    /// Chip-safe sponsor name: the menu bar is narrow.
    private func truncateForBar(_ s: String) -> String {
        s.count <= 20 ? s : String(s.prefix(19)) + "…"
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
        } else if let button = statusItem.button {
            refreshUI()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
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

        menuPauseItem = NSMenuItem(title: "Pause earning", action: #selector(togglePause(_:)), keyEquivalent: "p")
        menuPauseItem.target = self
        menu.addItem(menuPauseItem)

        // Launch at Login (SMAppService, macOS 13+). Only meaningful when
        // running from an .app bundle; updateMenu() disables the item for
        // the bare dev binary. See refreshLoginItem().
        loginItem = NSMenuItem(title: "Launch at Login",
                               action: #selector(toggleLaunchAtLogin(_:)), keyEquivalent: "l")
        loginItem.target = self
        menu.addItem(loginItem)

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
        } else {
            sponsorMenuItem?.isHidden = true
            sponsorMenuItem?.title = "Sponsor: —"
        }
        reloadMenuItem?.isHidden = (adFeedURL == nil)
        refreshLoginItem()
    }

    /// NSMenuItem validation: the sponsor item is only clickable when the
    /// current campaign carries a validated https clickUrl.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem == sponsorMenuItem {
            guard let camp = currentLiveCampaign else { return false }
            return FeedValidate.httpsURL(camp.clickUrl) != nil
        }
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
            loginItem.action = nil
            loginItem.title = "Launch at Login (unavailable)"
            loginItem.state = .off
            return
        }
        refreshLoginItem()
    }

    // MARK: Timers

    private func scheduleTimers() {
        // Earning: +$0.01 every 90 s while awake and not paused/disabled.
        let earn = Timer.scheduledTimer(timeInterval: 90, target: self,
                                        selector: #selector(earnTick),
                                        userInfo: nil, repeats: true)
        RunLoop.main.add(earn, forMode: .common)

        // Countdown: 1 s heartbeat while snoozed, so the popover button and
        // status line tick down and the pause lifts on time.
        let countdown = Timer.scheduledTimer(timeInterval: 1, target: self,
                                             selector: #selector(countdownTick),
                                             userInfo: nil, repeats: true)
        RunLoop.main.add(countdown, forMode: .common)
    }

    private var snoozed: Bool {
        snoozeUntil != nil && snoozeUntil! > Date()
    }

    @objc private func earnTick() {
        guard !disabled, !paused, isAwake else { return }
        balanceCents += 1             // $0.01
        todayCents += 1
        history[dayKey(Date()), default: 0] += 1
        lastTick = Date()
        refreshUI()
        persist()
    }

    @objc private func countdownTick() {
        guard snoozeUntil != nil else { return }
        if let until = snoozeUntil, until <= Date() {
            // Snooze window elapsed — resume earning.
            snoozeUntil = nil
            paused = false
            persist()
        }
        refreshUI()
    }

    // MARK: Real-advertiser bridge (config.json → feed → cache → UI)

    private func scheduleLiveFeedTimers() {
        guard adFeedURL != nil else { return }

        // Refresh the feed every 30 minutes. The fetch itself runs on the
        // URLSession background queue; only the UI update lands on main.
        let refresh = Timer.scheduledTimer(timeInterval: FeedLimits.refreshInterval,
                                           target: self,
                                           selector: #selector(feedRefreshTick),
                                           userInfo: nil, repeats: true)
        RunLoop.main.add(refresh, forMode: .common)
        feedRefreshTimer = refresh

        // Rotate the shown campaign every 60 s (chip + popover header).
        let rotate = Timer.scheduledTimer(timeInterval: 60,
                                          target: self,
                                          selector: #selector(campaignRotateTick),
                                          userInfo: nil, repeats: true)
        RunLoop.main.add(rotate, forMode: .common)
        campaignRotateTimer = rotate
    }

    @objc private func feedRefreshTick() {
        fetchLiveCampaigns()
    }

    @objc private func campaignRotateTick() {
        guard liveCampaigns.count > 1 else { return }
        liveCampaignIndex = (liveCampaignIndex + 1) % liveCampaigns.count
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
            if let campaigns = campaigns, !campaigns.isEmpty {
                // Auction order: highest CPM first, floor applied (pickAd
                // mirrors assets/js/demo.js). Below-floor campaigns are
                // filtered out entirely.
                self.liveCampaigns = pickAd(campaigns, minCpm: self.minCPM)
                self.liveCampaignIndex = 0
                self.saveCampaignCache(campaigns)
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
    /// user-visible). Failures fall back to the fictional sponsors.
    private func loadCampaignCache() -> [LiveCampaign] {
        do {
            let data = try Data(contentsOf: Self.campaignCacheURL())
            let cache = try JSONDecoder().decode(CampaignCache.self, from: data)
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
        paused.toggle()
        if !paused { snoozeUntil = nil }   // manual resume clears any snooze
        refreshUI()
        persist()
    }

    /// Snooze = pause for 30 minutes with a live countdown.
    func snoozeToggled() {
        if snoozed {
            snoozeUntil = nil
            paused = false
        } else {
            snoozeUntil = Date().addingTimeInterval(30 * 60)
            paused = true
        }
        refreshUI()
        persist()
    }

    /// Disable = persisted earning kill-switch until re-enabled.
    func disableToggled() {
        disabled.toggle()
        if !disabled { snoozeUntil = nil }
        refreshUI()
        persist()
    }

    func openDashboard() {
        NSWorkspace.shared.open(Self.dashboardURL)
    }

    func openAccount() {
        NSWorkspace.shared.open(Self.profileURL)
    }

    @objc private func showAbout(_ sender: NSMenuItem) {
        let alert = NSAlert()
        alert.messageText = "FreeCoffee demo"
        alert.informativeText = """
        Your menu bar buys the coffee. Menu-bar advertising demo — without a configured ad feed, \
        sponsors, bids, and earnings are simulated; no real money moves and nothing is collected: \
        no screen contents, files, browser history, keystrokes, screenshots, or window titles. \
        Optionally, config.json can point at an HTTPS advertiser feed — the app fetches that one \
        URL (nothing is sent back) and shows those campaigns marked LIVE; their earnings settle \
        once the platform backend is live. Balances also read as "≈ N cups" (1 cup = $5). \
        Not affiliated with SponsorBar or KickBot Inc.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: Sleep / wake (the only external signal — see privacy note above)

    private func observeSleepWake() {
        let center = NSWorkspace.shared.notificationCenter
        sleepObserver = center.addObserver(forName: NSWorkspace.willSleepNotification,
                                           object: nil, queue: .main) { [weak self] _ in
            self?.isAwake = false
            self?.refreshUI()
            self?.persist()
        }
        wakeObserver = center.addObserver(forName: NSWorkspace.didWakeNotification,
                                          object: nil, queue: .main) { [weak self] _ in
            self?.isAwake = true
            self?.refreshUI()
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
                                        lastTick: lastTick)
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
            if let until = snoozeUntil, until <= Date() {
                // Stale snooze from a previous run — start fresh.
                snoozeUntil = nil
                paused = false
            }
        } catch {
            // First run (or unreadable file): seed the demo balance and a
            // 7-day history consistent with the web demo's ledger.
            balanceCents = Self.demoSeedBalanceCents
            todayCents = 0
            paused = false
            disabled = false
            snoozeUntil = nil
            lastTick = nil
            history = [:]
            let cal = Calendar.current
            for (offset, cents) in Self.demoSeedWeek.reversed().enumerated() {
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
