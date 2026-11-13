<p align="center">
  <img src="docs/screenshots/banner.png" alt="Kanopa: a calm, exact LDAP client for Windows and macOS" width="100%">
</p>

<p align="center">
  <a href="https://github.com/S0obi/kanopa/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/S0obi/kanopa?include_prereleases&color=6aa384"></a>
  <a href="https://github.com/S0obi/kanopa/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/S0obi/kanopa/ci.yml?branch=main&label=CI"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6aa384"></a>
</p>

Kanopa is a desktop app for looking after an LDAP directory. Connect, walk the tree, read an entry, change it, and see exactly what will be sent before anything is.

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Kanopa: connect, browse the tree, change a title, save, disconnect" width="880">
</p>

## What you get

- **A directory that stays easy to read.** The tree loads as you open it, and long lists (an OU with 10,000 children, a group with 5,000 members) only draw what is on screen, so they stay quick.
- **Changes you can check.** Edits pile up as pending changes. Read them as LDIF, then apply them together. Nothing reaches the server until you do, and you can discard them at any time.
- **Saved connections, kept safe.** Passwords go to the Windows Credential Manager or the macOS Keychain, never to a settings file.
- **Easy on the eyes.** A light theme (Clearing) and a dark one (Night forest), following your system or set by hand. Everything works from the keyboard.

## Quick start

**1. Download** the latest build from the [Releases page](https://github.com/S0obi/kanopa/releases/latest).

| System | Download | First launch |
|---|---|---|
| **Windows 10 and 11** | The installer (`.exe`), or the portable `.zip` if you would rather not install | Windows SmartScreen may say it "protected your PC". Choose **More info**, then **Run anyway**. Kanopa is not code-signed yet. |
| **macOS 12 or later** | The `.dmg` (Apple Silicon and Intel). Drag Kanopa to Applications | macOS may say it cannot verify the app. Open **System Settings → Privacy & Security** and choose **Open Anyway** next to Kanopa. |

If Open Anyway does not appear, or macOS says the app is damaged, remove the download quarantine flag in Terminal and open Kanopa again:

```bash
xattr -dr com.apple.quarantine /Applications/Kanopa.app
```

macOS is newer and has had less testing than Windows, so please tell us what you run into.

**2. Connect.** Open Kanopa, choose **New connection**, and fill in the server address (for example `ldaps://ldap.example.org`), how to secure it, and your bind DN and password. Use **Test connection** to check the details, then **Save and connect**.

**3. Look around.** Open a branch of the tree, pick an entry, and read its attributes. To change something, hover a row and choose **Edit**. Review your pending changes, then **Apply**.

> **This is an early release.** Found a bug or have an idea? [Open an issue](https://github.com/S0obi/kanopa/issues/new). It helps most when you say what you did, what you expected, and what you saw. The **About Kanopa** dialog can copy diagnostics (versions only; no host names, DNs or secrets) to paste into your report.

## Your data

- Kanopa keeps its settings, your saved connections (without passwords) and its log in `%AppData%\Kanopa` on Windows and `~/Library/Application Support/Kanopa` on macOS. **Open log folder** in the app menu takes you there.
- Passwords live in the Windows Credential Manager or the macOS Keychain, under "Kanopa".
- Kanopa talks to the directories you connect to, and nothing else. There is no account and no telemetry.
- Uninstalling removes the app and leaves your settings behind, so you can come back to them.

## Contributing

Kanopa is built with Go and React on [Wails](https://wails.io). Ideas and fixes are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run it, test it and build it.

## License

[MIT](LICENSE)
