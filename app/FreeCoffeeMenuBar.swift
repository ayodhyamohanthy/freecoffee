/* ==========================================================================
   FreeCoffee — macOS menu bar app (single-file Swift/AppKit, no Xcode needed)

   ☕ FreeCoffee lives where SponsorBar lives: the macOS menu bar.
   Left-click the status item for the popover (balance, 7-day chart,
   snooze/disable/settings); right-click for pause / launch-at-login / quit.

   PRIVACY — read this before changing anything:
   This app collects NOTHING. No screen capture, no file access, no
   keystroke monitoring, no window titles, no browser history, no
   identifiers of any kind. The only signals it touches are:
     • awake/asleep state (so minutes don't accrue while you sleep), and
     • its own timer.
   The demo ledger ticks $0.01 / 90 s locally; wiring it to the Cloudflare
   Worker backend (`backend/`) only ever sends {deviceId, type, campaignId,
   minutes} — never anything about you or your machine.

   Build & run:  see build.sh  (./build.sh → dist/FreeCoffee.app + .dmg)
   ========================================================================== */

import AppKit
import ServiceManagement

// ------------------------------- persistence ------------------------------

struct Ledger: Codable {
    var balance: Double = 0
    var today: Double = 0
    var paused: Bool = false
    var disabled: Bool = false
    var snoozeUntil: Date? = nil
    var history: [String: Double] = [:]      // "2026-09-08" -> earned that day
    var lastTick: Date? = nil
}

final class Store {
    static let shared = Store()
    private let dir: URL
    private let file: URL
    var ledger = Ledger()   // internal setter: app mutates via tick/pause/snooze

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        dir = base.appendingPathComponent("FreeCoffee", isDirectory: true)
        file = dir.appendingPathComponent("ledger.json")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        load()
    }

    private func load() {
        guard let data = try? Data(contentsOf: file) else { return }
        if let l = try? JSONDecoder().decode(Ledger.self, from: data) { ledger = l }
    }

    func save() {
        guard let data = try? JSONEncoder().encode(ledger) else { return }
        try? data.write(to: file, options: .atomic)
    }

    func reset() { ledger = Ledger(); save() }
}

// --------------------------------- helpers --------------------------------

func dayKey(_ d: Date = Date()) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: d)
}

func money(_ v: Double) -> String {
    String(format: "$%.2f", v)
}

// ------------------------------- chart view -------------------------------

/// Inset 7-day bar chart with value labels — drawn by hand, no frameworks.
final class BarChartView: NSView {
    var values: [(label: String, v: Double)] = [] {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let bg = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
        NSColor(calibratedRed: 0.945, green: 0.918, blue: 0.855, alpha: 1).setFill()  // #F1EADA
        bg.fill()
        _ = ctx

        guard !values.isEmpty else { return }
        let maxV = max(values.map { $0.v }.max() ?? 0.0001, 0.0001)
        let inset: CGFloat = 10
        // room: 20pt on top for value labels, 18pt at the bottom for day letters
        let plot = NSRect(x: inset, y: 18,
                          width: bounds.width - inset * 2,
                          height: bounds.height - 38)
        let slot = plot.width / CGFloat(values.count)
        let barW: CGFloat = min(34, slot * 0.62)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .medium),
            .foregroundColor: NSColor(calibratedRed: 0.48, green: 0.42, blue: 0.31, alpha: 1),
        ]
        let valAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .semibold),
            .foregroundColor: NSColor(calibratedRed: 0.34, green: 0.29, blue: 0.20, alpha: 1),
        ]
        let barColor = NSColor(calibratedRed: 0.435, green: 0.647, blue: 0.722, alpha: 1)  // slate teal

        for (i, item) in values.enumerated() {
            let cx = plot.minX + slot * CGFloat(i) + slot / 2
            let h = max(2, CGFloat(item.v / maxV) * plot.height)
            let rect = NSRect(x: cx - barW / 2, y: plot.minY, width: barW, height: h)
            barColor.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()

            let lbl = NSAttributedString(string: item.label, attributes: attrs)
            lbl.draw(at: NSPoint(x: cx - lbl.size().width / 2, y: bounds.minY + 3))
            let vs = NSAttributedString(string: item.v > 0 ? String(format: "$%.2f", item.v) : "$0", attributes: valAttrs)
            vs.draw(at: NSPoint(x: cx - vs.size().width / 2, y: plot.minY + h + 3))
        }
    }
}

// -------------------------------- popover UI ------------------------------

final class PopoverController: NSViewController, NSPopoverDelegate {
    let store = Store.shared
    var statusItem: NSStatusItem?

    var popover = NSPopover()
    var snoozeTimer: Timer?

    // UI
    let subtitle = NSTextField(labelWithString: "Earning — ad live")
    let dot = NSView(frame: .zero)
    let dotLabel = NSTextField(labelWithString: "Earning")
    let balance = NSTextField(labelWithString: "$0.00")
    let available = NSTextField(labelWithString: "$0.00 available")
    let pending = NSTextField(labelWithString: "$0.00 pending")
    let cups = NSTextField(labelWithString: "≈ 0 cups of coffee")
    let chart = BarChartView(frame: NSRect(x: 0, y: 0, width: 328, height: 108))
    let weekTotal = NSTextField(labelWithString: "$0.00")
    let snoozeBtn = NSButton(title: "Snooze", target: nil, action: nil)
    let disableBtn = NSButton(title: "Disable", target: nil, action: nil)

    override func loadView() {
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 512))
        v.wantsLayer = true
        view = v
        buildUI()
        refresh(all: true)
    }

    private func card(_ rect: NSRect) -> NSView {
        let c = NSView(frame: rect)
        c.wantsLayer = true
        c.layer?.backgroundColor = NSColor(calibratedRed: 1, green: 0.992, blue: 0.965, alpha: 1).cgColor  // #FFFDF6
        c.layer?.borderColor = NSColor(calibratedRed: 0.910, green: 0.875, blue: 0.788, alpha: 1).cgColor  // #E8DFC9
        c.layer?.borderWidth = 1
        return c
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                       color: NSColor = .textColor, mono: Bool = false) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = mono ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
                      : NSFont.systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }

    private func divider(y: CGFloat, in v: NSView) {
        let d = NSView(frame: NSRect(x: 0, y: y, width: v.frame.width, height: 1))
        d.wantsLayer = true
        d.layer?.backgroundColor = NSColor(calibratedRed: 0.910, green: 0.875, blue: 0.788, alpha: 1).cgColor
        v.addSubview(d)
    }

    private func footerButton(_ title: String, _ icon: String, _ action: Selector) -> NSButton {
        let b = NSButton(title: "", target: self, action: action)
        b.isBordered = false
        b.wantsLayer = true
        b.image = NSImage(systemSymbolName: icon, accessibilityDescription: title)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        b.imagePosition = .imageAbove
        b.font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        b.title = title
        return b
    }

    private func buildUI() {
        let W = view.frame.width

        // header -------------------------------------------------------
        let cup = NSView(frame: NSRect(x: 16, y: 428, width: 40, height: 40))
        cup.wantsLayer = true
        cup.layer?.backgroundColor = NSColor(calibratedRed: 0.878, green: 0.663, blue: 0.243, alpha: 1).cgColor // #E0A93E
        cup.layer?.cornerRadius = 10
        let cupLbl = label("☕", size: 20)
        cupLbl.frame = NSRect(x: 8, y: 7, width: 24, height: 26)
        cup.addSubview(cupLbl)
        view.addSubview(cup)

        let name = label("FreeCoffee", size: 15, weight: .bold)
        name.frame = NSRect(x: 66, y: 450, width: 200, height: 18)
        view.addSubview(name)
        subtitle.frame = NSRect(x: 66, y: 432, width: 220, height: 15)
        subtitle.font = NSFont.systemFont(ofSize: 11)
        subtitle.textColor = .secondaryLabelColor
        view.addSubview(subtitle)

        dot.frame = NSRect(x: W - 96, y: 449, width: 8, height: 8)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        view.addSubview(dot)
        dotLabel.frame = NSRect(x: W - 82, y: 446, width: 70, height: 14)
        dotLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        dotLabel.textColor = .secondaryLabelColor
        view.addSubview(dotLabel)

        divider(y: 416, in: view)

        // balance card ---------------------------------------------------
        let bal = card(NSRect(x: 0, y: 258, width: W, height: 158))
        view.addSubview(bal)
        let balTitle = label("TOTAL BALANCE", size: 10, weight: .heavy, color: .secondaryLabelColor)
        balTitle.frame = NSRect(x: 16, y: 122, width: 160, height: 12)
        bal.addSubview(balTitle)
        balance.font = NSFont.monospacedDigitSystemFont(ofSize: 33, weight: .bold)
        balance.frame = NSRect(x: 15, y: 82, width: 190, height: 38)
        bal.addSubview(balance)
        available.frame = NSRect(x: W - 150, y: 104, width: 134, height: 14)
        available.alignment = .right
        available.font = NSFont.systemFont(ofSize: 11)
        available.textColor = .secondaryLabelColor
        bal.addSubview(available)
        pending.frame = NSRect(x: W - 150, y: 88, width: 134, height: 14)
        pending.alignment = .right
        pending.font = NSFont.systemFont(ofSize: 11)
        pending.textColor = .secondaryLabelColor
        bal.addSubview(pending)
        cups.frame = NSRect(x: W - 150, y: 72, width: 134, height: 14)
        cups.alignment = .right
        cups.font = NSFont.systemFont(ofSize: 11)
        cups.textColor = .tertiaryLabelColor
        bal.addSubview(cups)

        let boost = label("☕ 65% base share — always on", size: 12, weight: .semibold,
                          color: NSColor(calibratedRed: 0.690, green: 0.471, blue: 0.094, alpha: 1))
        boost.frame = NSRect(x: 16, y: 48, width: 260, height: 16)
        bal.addSubview(boost)

        divider(y: 258, in: view)

        // chart card -------------------------------------------------------
        let ct = label("Earnings · 7 days", size: 13, weight: .semibold)
        ct.frame = NSRect(x: 16, y: 218, width: 160, height: 16)
        view.addSubview(ct)
        weekTotal.frame = NSRect(x: W - 76, y: 218, width: 60, height: 16)
        weekTotal.alignment = .right
        weekTotal.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        view.addSubview(weekTotal)
        chart.frame = NSRect(x: 16, y: 112, width: W - 32, height: 100)
        view.addSubview(chart)

        let tip = label("Tip: Hold ⌘ and drag menu-bar items to rearrange them.", size: 10.5,
                        color: .tertiaryLabelColor)
        tip.frame = NSRect(x: 16, y: 92, width: W - 32, height: 14)
        view.addSubview(tip)

        divider(y: 84, in: view)

        // footer -----------------------------------------------------------
        let settings = footerButton("Settings", "gearshape", #selector(openSettings))
        settings.frame = NSRect(x: 0, y: 6, width: W / 4, height: 72)
        view.addSubview(settings)
        snoozeBtn.target = self
        snoozeBtn.action = #selector(toggleSnooze)
        snoozeBtn.isBordered = false
        snoozeBtn.image = NSImage(systemSymbolName: "zzz", accessibilityDescription: "Snooze")?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        snoozeBtn.imagePosition = .imageAbove
        snoozeBtn.font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        snoozeBtn.title = "Snooze"
        snoozeBtn.frame = NSRect(x: W / 4, y: 6, width: W / 4, height: 72)
        view.addSubview(snoozeBtn)
        disableBtn.target = self
        disableBtn.action = #selector(toggleDisable)
        disableBtn.isBordered = false
        disableBtn.image = NSImage(systemSymbolName: "power", accessibilityDescription: "Disable")?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        disableBtn.imagePosition = .imageAbove
        disableBtn.font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        disableBtn.title = "Disable"
        disableBtn.frame = NSRect(x: W / 2, y: 6, width: W / 4, height: 72)
        view.addSubview(disableBtn)
        let account = footerButton("Account", "person.crop.circle", #selector(openAccount))
        account.frame = NSRect(x: W * 3 / 4, y: 6, width: W / 4, height: 72)
        view.addSubview(account)

        snoozeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refresh(all: false)
        }
    }

    // ------------------------------------------------------------------

    func refresh(all: Bool) {
        let l = store.ledger
        balance.stringValue = money(l.balance)
        available.stringValue = "\(money(l.balance)) available"
        pending.stringValue = "\(money(0)) pending"
        let nCups = l.balance / 5.0
        cups.stringValue = nCups >= 0.1 ? "≈ \(String(format: "%.1f", nCups)) cups of coffee" : "≈ 0 cups of coffee"

        // 7-day history
        var days: [(String, Double)] = []
        let cal = Calendar(identifier: .gregorian)
        for i in stride(from: 6, through: 0, by: -1) {
            let d = cal.date(byAdding: .day, value: -i, to: Date())!
            let wd = cal.component(.weekday, from: d)
            days.append((String(Array("SMTWTFS")[wd - 1]), l.history[dayKey(d)] ?? 0))
        }
        chart.values = days
        weekTotal.stringValue = money(days.reduce(0) { $0 + $1.1 })

        // status
        var sub: String
        var live = false
        if l.disabled { sub = "Disabled — enable to start earning" }
        else if let until = l.snoozeUntil, until > Date() {
            let m = Int(until.timeIntervalSinceNow / 60) + 1
            sub = "Snoozed — \(m) min left"
        }
        else if l.paused { sub = "Paused — resume from the menu" }
        else { sub = "Earning — ad live"; live = true }
        subtitle.stringValue = sub
        dot.layer?.backgroundColor = live
            ? NSColor(calibratedRed: 0.133, green: 0.639, blue: 0.357, alpha: 1).cgColor
            : NSColor.tertiaryLabelColor.cgColor
        dotLabel.stringValue = live ? "Earning" : "Waiting"
        snoozeBtn.title = (l.snoozeUntil ?? .distantPast) > Date() ? "Resume" : "Snooze"
        disableBtn.title = l.disabled ? "Enable" : "Disable"
        if all { paintTray() }
    }

    func paintTray() {
        let l = store.ledger
        let active = !l.disabled && !l.paused && (l.snoozeUntil ?? .distantPast) < Date()
        statusItem?.button?.title = active ? "☕ FreeCoffee" : "☕ FreeCoffee — Paused"
    }

    // ---------------------------------------------------------- actions

    @objc func openSettings() {
        if let u = URL(string: "http://127.0.0.1:8090/dashboard.html") { openURL(u) }
    }
    @objc func openAccount() {
        if let u = URL(string: "http://127.0.0.1:8090/profile.html") { openURL(u) }
    }
    private func openURL(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    @objc func toggleSnooze() {
        let l = store.ledger
        if let until = l.snoozeUntil, until > Date() {
            store.ledger.snoozeUntil = nil
        } else {
            store.ledger.snoozeUntil = Date().addingTimeInterval(30 * 60)
        }
        store.save()
        refresh(all: true)
    }

    @objc func toggleDisable() {
        store.ledger.disabled.toggle()
        store.ledger.paused = store.ledger.disabled
        store.save()
        refresh(all: true)
    }
}

// ------------------------------- app delegate ------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store.shared
    var controller = PopoverController()
    var statusItem: NSStatusItem?
    var tick: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu bar app — no Dock icon
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "☕ FreeCoffee"
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item
        controller.statusItem = item
        controller.paintTray()

        controller.refresh(all: true)

        // the honest demo minute: +$0.01 per 90 s, only while awake & enabled
        tick = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in
            self?.earnTick()
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.controller.refresh(all: true) }
    }

    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let pause = NSMenuItem(title: "Pause earning", action: #selector(togglePause), keyEquivalent: "p")
        pause.target = self
        pause.state = store.ledger.paused ? .on : .off
        menu.addItem(pause)

        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        let bundled = Bundle.main.bundlePath.hasSuffix(".app")
        login.isEnabled = false
        if #available(macOS 13.0, *) {
            login.isEnabled = bundled
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        menu.addItem(login)

        menu.addItem(.separator())
        let about = NSMenuItem(title: "About FreeCoffee demo", action: #selector(about), keyEquivalent: "")
        about.target = self
        menu.addItem(about)
        let quit = NSMenuItem(title: "Quit FreeCoffee", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    @objc func togglePopover() {
        guard let item = statusItem, let button = item.button else { return }
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            // right-click → context menu (menu must be set only for the click,
            // otherwise the item stops sending actions entirely)
            item.menu = buildMenu()
            button.performClick(nil)
            item.menu = nil
            return
        }
        if controller.popover.isShown {
            controller.popover.performClose(nil)
        } else {
            controller.popover.contentViewController = controller
            controller.popover.behavior = .transient
            controller.popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            controller.refresh(all: false)
        }
    }

    @objc func togglePause() {
        store.ledger.paused.toggle()
        if store.ledger.paused { store.ledger.snoozeUntil = nil }
        store.save()
        controller.refresh(all: true)
    }

    @objc func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        switch SMAppService.mainApp.status {
        case .enabled:
            try? SMAppService.mainApp.unregister()
        default:
            try? SMAppService.mainApp.register()
        }
    }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "FreeCoffee demo"
        a.informativeText = """
        Paid ads in your macOS menu bar — 65% of every ad dollar goes to the user.

        Demo ledger: +$0.01 every 90 s while your Mac is awake.
        Privacy: collects nothing — no screen, file, keystroke, or window access.
        Data: ~/Library/Application Support/FreeCoffee/ledger.json (delete to reset).

        https://freecoffee.tech
        """
        a.runModal()
    }

    @objc func quit() { NSApp.terminate(nil) }

    func earnTick() {
        let l = store.ledger
        guard !l.disabled, !l.paused, (l.snoozeUntil ?? .distantPast) < Date() else { return }
        let k = dayKey()
        store.ledger.balance = (l.balance * 100 + 1).rounded() / 100
        store.ledger.today = (l.today * 100 + 1).rounded() / 100
        store.ledger.history[k] = ((l.history[k] ?? 0) * 100 + 1).rounded() / 100
        store.ledger.lastTick = Date()
        store.save()
        controller.refresh(all: false)
    }
}

// ---------------------------------- main -----------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
