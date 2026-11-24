# Changelog

All notable changes to Kanopa are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Updates.** Kanopa asks once whether to keep itself up to date, and the answer is off until you say yes. When it is on, Kanopa asks GitHub for the latest stable release when it starts and once a day. On Windows, in a per-user install or a portable copy in a folder you can write to, a newer version downloads in the background, is checked against the release's checksum, and waits for **Restart to update**; that button stays off while changes are pending. On macOS Kanopa tells you a new version exists and links to the download. **Check for updates…** and **Check for updates automatically** are in the app menu. If an update doesn't install, Kanopa stays as it was and says so. The check sends nothing but a plain request to `api.github.com`; the checksum catches a damaged download, not a tampered release (see SECURITY.md).

- **Export LDIF…** on any entry, from the right-click menu and the entry's More menu: write the entry, or the entry and everything below it, to an LDIF file through the Save dialog. Password hashes and other secrets are left out unless you tick a box, and operational attributes are never written. A big branch is written a page at a time with a running count, and Cancel leaves no file behind and never touches a file you were replacing. If the server stops early (its size limit, or a dropped connection), Kanopa keeps what it got, says why, and ends the file with a comment that says so; references to other servers are listed, not followed. The file starts with `version: 1`, names no server, and a warning appears if an entry comes before its parent. Export only reads, so it works on a read-only connection.

- **Account status** on a person, from the password policy (OpenLDAP's ppolicy): one banner above the attributes says when the account is locked, when the password has expired or when the person must choose a new one at the next login. A lock has an **Unlock** button, which adds the change to your pending changes like any edit, with Undo. An expired password has a **Reset password…** button. Expiry is only said where Kanopa can read the policy, and a lock that may have run out says so. No banner means no known problem, not a guarantee.

- **Reset password…** on a person, from the right-click menu, the entry's More menu, and Edit on the `userPassword` row: one dialog with the password generator. On a server with a password policy (OpenLDAP's ppolicy), a checkbox asks the person to choose their own password at the next sign-in; it is locked on when the person's own policy requires that, and a new person gets it checked. Kanopa sets the password first and the flag after it, and retries the flag under the Relax Rules control if the server refuses it. The item is off, with the reason, on a read-only connection and on Active Directory, where Kanopa does not set passwords yet.

- A password generator. The dice in every new-password field (editing `userPassword`, a new person, other password attributes) fills in 20 random characters, with upper and lower case, digits and symbols, and leaves out look-alikes such as `0` and `O`. A generated password is shown in plain text, needs no confirmation and can be copied. It stays on the clipboard for 60 seconds, is cleared sooner if Kanopa quits, and is never cleared if you copied something else meanwhile.
- You can copy a generated password until you apply: from the changes bar and from the entry. After Apply, a notice offers one more Copy for each person, and Kanopa forgets the password when you close it, or after five minutes.
- When the server refuses a generated password, the message says so and suggests typing one or generating another.

### Changed

- **The Windows installer now installs for your account only** (in `%LocalAppData%\Programs\Kanopa`), with no administrator prompt, so Kanopa can later update itself without one. If you installed an earlier version for all users, uninstall it from Settings, Apps first, then run the new installer once. Your settings and saved connections are kept.

## [0.1.1] - 2026-11-13

### Added

- New entry offers a **POSIX user**: a person who is also a `posixAccount`. Kanopa suggests the next free `uidNumber` and warns when a number is already used, lets you pick the primary group from the POSIX groups on the server, and fills in `/home/<uid>` and `/bin/bash`, which you can edit.
- The bind name of a connection can also be an Active Directory name: `DOMAIN\user` or `user@example.org`, not only a DN.

### Changed

- A new person's User ID now starts as the first letter of the first name followed by the last name ("Ada Lovelace" is `alovelace`), until you edit it.
- When the server lists an entry but refuses to open it, Kanopa now says so in plain words, shows the DN to copy for whoever runs the directory, and offers Try again.

### Fixed

- Removing a member from a POSIX group no longer fails with "Unavailable critical extension" on servers that list the assertion control but refuse it for that attribute. Kanopa now sends the change without it, after checking the entry just before.
- A bind DN or base DN with an escaped comma, such as `CN=Soubiran\, Thibault,OU=Users,DC=example,DC=org` (how Active Directory names people), is no longer refused as "Invalid DN syntax".

## [0.1.0] - 2026-11-13

The first public release, for Windows and macOS.

### Added

- POSIX groups. A group that lists its members by uid (`memberUid`) now has a Members tab like any other: add and remove people, see who each uid stands for, and spot a uid no entry carries. A person's Member of tab shows how many groups list them, includes the POSIX groups that list their uid (however the person is named), and can join and leave them, deleting or renaming a user keeps `memberUid` in step, and New entry can create a POSIX group with the next free `gidNumber`.
- New entry works below any entry that can hold children, not only the root and organizational units: an `organizationalRole` that holds groups, for example, or any entry that already has children.
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
- Dropdowns use a list in Kanopa's own style, in both themes, instead of the system list. They work with the mouse and the keyboard (arrows, Home, End, Enter, Esc, and typing to jump).
- A right click on the tree opens the menu without selecting the entry. Only a left click selects.
- Interface text follows one voice: sentence case, no "please" or "successfully", and errors that name the LDAP result code.
- Small windows and zoom: the status bar, attribute table and dialogs now fit instead of overflowing.

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

[Unreleased]: https://github.com/S0obi/kanopa/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/S0obi/kanopa/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/S0obi/kanopa/compare/v0.0.5...v0.1.0
[0.0.5]: https://github.com/S0obi/kanopa/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/S0obi/kanopa/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/S0obi/kanopa/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/S0obi/kanopa/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/S0obi/kanopa/releases/tag/v0.0.1
