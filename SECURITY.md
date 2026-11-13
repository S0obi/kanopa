# Security policy

Kanopa edits directories, so a security problem in it can matter. Thank you for reporting one carefully.

## Reporting a vulnerability

Please report it **privately**, not in a public issue:

1. Open [Report a vulnerability](https://github.com/S0obi/kanopa/security/advisories/new) on this repository.
2. Say what you found, how to reproduce it, and what it could let someone do.

Please do not include real passwords, bind DNs or data from a directory you do not own.

You can expect an answer within about a week. This is a small project, so that is a best effort, not a promise. If the report holds up, the fix is released as a new version and credited to you in the release notes, unless you would rather stay unnamed.

## Supported versions

Only the latest release gets fixes. Please check that the problem is still there in the newest version before you report it.

## What is in scope

- Passwords or secrets stored, logged or shown where they should not be.
- Changes sent to a server that the person did not review and apply.
- Ways to make Kanopa read or write files, or run code, outside what it is meant to.
- Mistakes in how a connection is secured (TLS or StartTLS), such as a check that is skipped without being asked to.

Kanopa keeps passwords in the Windows Credential Manager or the macOS Keychain, never in its settings file. It sends nothing anywhere except to the directories you connect to, and it has no telemetry. The Windows installer and the macOS app are not code-signed yet, so your system will warn you on first launch.

## Out of scope

- Problems that need an attacker who already controls your computer or your directory server.
- Behavior of a directory server itself, such as its access rules or its password hashing.
