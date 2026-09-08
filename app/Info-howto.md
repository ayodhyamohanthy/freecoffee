# FreeCoffee Mac app — first launch, Gatekeeper & login

## Install

1. Open `app/dist/FreeCoffee.dmg` and drag **FreeCoffee** into `/Applications`.
2. Double-click FreeCoffee once.

## First launch (unsigned build — the $0 path)

The app is **ad-hoc signed, not Apple-notarized** (that's what makes free
distribution possible — no $99/year developer program). macOS Sequoia (15+)
therefore shows a one-time security prompt. Two ways through it:

**Finder way (recommended):**
1. Double-click FreeCoffee → macOS says it "cannot check for malicious software" (or "not opened"). **Cancel** that dialog.
2. Open **System Settings → Privacy & Security**, scroll to the **Security** section.
3. Click **Open Anyway**, authenticate with Touch ID / password, then **Open**.

This is a once-per-version step. After the first successful launch the app
starts normally like any other menu bar item.

**Terminal way (one line):**

```bash
xattr -dr com.apple.quarantine /Applications/FreeCoffee.app
```

This removes the quarantine stamp macOS puts on downloaded files — after it,
the app opens with no prompts at all. (A future `install-mac.sh` does this
automatically after verifying the release checksum.)

> Why is this OK? The download is bound to exactly what GitHub Actions built
> via the `SHA256SUMS.txt` shipped with every Release. Verify it with
> `shasum -a 256 --check SHA256SUMS.txt`. Unsigned ≠ unverified.

## Launch at Login

- **Bundled app** (`/Applications/FreeCoffee.app`): right-click the ☕ menu bar
  item → **Launch at Login**. Uses `SMAppService` (macOS 13+). The first
  enable may need approval in **System Settings → General → Login Items &
  Extensions** → allow "FreeCoffee".
- **Bare dev binary** (`./FreeCoffeeMenuBar`): the toggle is disabled by
  design — register it manually in System Settings → Login Items (add the
  binary), or move to the .app bundle first.

## Reset the demo ledger

```bash
rm ~/Library/Application\ Support/FreeCoffee/ledger.json
```

## Privacy

The app collects nothing — no screen, file, keystroke, or window-title
access. The only signals it touches are awake/asleep state and its own
timer. See the comment block at the top of `FreeCoffeeMenuBar.swift`.
