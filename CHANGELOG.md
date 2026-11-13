# Changelog

All notable changes to Kanopa are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

The first public release, for Windows and macOS.

### Added

- A context menu on the tree, with the actions that fit the entry.
- A confirmation field when you set a password, so a typo cannot lock someone out.
- Find an entry from the header search: type a name, a mail address, a DN or an LDAP filter, and open the result in the tree.
- Night forest, a dark theme, next to the light Clearing theme. Kanopa follows your system or keeps the choice you make.
- Support for servers that do not page results or do not say how many children an entry has.
- An app menu (the gear) on the Welcome and connected screens: Theme, About Kanopa and Open log folder. About shows the version, commit, OS and web engine, and copies diagnostics without host names, DNs or secrets.
- A crash screen. If a screen fails to draw, Kanopa offers Try again (your pending changes are kept) and Reload window, and can copy the details or open the log folder. A panic in the Go side is logged with a stack trace and shown as a normal error.
- The window remembers its size, position and maximized state, and stays on screen if a monitor goes away. The tree pane's width and the entry view's last tab are remembered too.
- Starting Kanopa a second time focuses the open window instead of opening another.
- On macOS, an app menu so Copy, Paste and Select all work, and Cmd+Q asks before it drops pending changes, as closing the window does.
- Installers for Windows (an installer and a portable zip) and a universal `.dmg` for macOS, built by GitHub Actions on each release tag.

### Changed

- Long lists (an OU with thousands of children, a group with thousands of members, the LDIF view) draw only the rows on screen. An attribute with many values shows the first 25, with a button to show them all.
- Every screen and dialog is checked against WCAG 2.2 AA in both themes on each test run. Rows and buttons carry names that include their visible text.
- A right click on the tree opens the menu without selecting the entry. Only a left click selects.
- Interface text follows one voice: sentence case, no "please" or "successfully", and errors that name the LDAP result code.
- Small windows and zoom: the status bar, attribute table and dialogs now fit instead of overflowing.

### Known performance

Measured on a laptop against the large test profile (an OU with 10,000 children, a group with 5,000 members, 11,000 people in all). These are what the integration tests recorded, not promises:

| What | Time |
|---|---|
| Open an OU with 10,000 children (all read at once, shown 500 at a time) | 188 ms |
| Count those children without reading them | 124 ms |
| Open a group with 5,000 members | 7 ms |
| Find the groups of one member | 11 ms |
| Header search over 11,000 people, for a word | 10 ms |
| Header search for one entry | 14 ms |
| Header search by an LDAP filter | 3 ms |

### Known limitations

- The Windows installer and the macOS app are not code-signed. Windows SmartScreen and macOS Gatekeeper will warn on first launch; the README says how to continue.
- macOS builds have had less testing than Windows.
- Tested against OpenLDAP. Other servers (Active Directory, 389 Directory Server) should work through standard LDAP but are not validated.
- Referrals are listed as entries or ignored, as you choose. Kanopa does not follow them.
- Only simple binds (anonymous, or a DN and password) are supported. SASL is not.
- There is no LDIF import or export, schema browser or access view yet.

## [0.0.5] - 2026-11-11

### Added

- Create people, groups and other entries the schema allows, rename and delete entries, and manage group members. All of it goes through pending changes, and pending work survives a dropped connection.

## [0.0.4] - 2026-11-11

### Added

- Change attributes on existing entries. Each change is shown against what the server holds, you review the exact LDIF, then apply or discard. Nothing reaches the server until you press Apply.

## [0.0.3] - 2026-11-06

### Added

- Browse a directory without risk: walk the tree page by page, open any entry, read every attribute and its LDIF, follow DN links, and see which groups a person belongs to.
- If the server drops, Kanopa says so and reconnects.

## [0.0.2] - 2026-11-06

### Added

- Saved connections. Passwords go to the Windows Credential Manager or the macOS Keychain, never to a file.
- Connect with Enter from the list of saved directories, and see the server's identity once connected: vendor, version, naming contexts and supported controls.

## [0.0.1] - 2026-11-06

### Added

- Type a server URL, bind DN and password, and press Test connection. You get "Bound as … in 42 ms over LDAPS", or an exact error with its LDAP result code.

[Unreleased]: https://github.com/S0obi/kanopa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/S0obi/kanopa/compare/v0.0.5...v0.1.0
[0.0.5]: https://github.com/S0obi/kanopa/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/S0obi/kanopa/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/S0obi/kanopa/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/S0obi/kanopa/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/S0obi/kanopa/releases/tag/v0.0.1
