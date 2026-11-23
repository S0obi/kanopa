# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Status: Windows builds are not signed yet. Signing starts with the first release after SignPath approves the project. This page describes how it will work, and it will be kept up to date.

## What is signed

- **Windows:** `kanopa.exe` (inside the installer and the portable zip) and the installer `Kanopa-<version>-windows-amd64-setup.exe`. Windows shows the publisher as **SignPath Foundation**.
- **Not signed by SignPath:** the uninstaller that the installer writes, and the macOS app (ad hoc signed).

Every signed file is built from this repository by the [release workflow](.github/workflows/release.yml), from a version tag, on GitHub-hosted runners. Nothing built on a personal machine is signed. Each release is approved by hand before it is signed.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [Thibault Soubiran](https://github.com/S0obi) |
| Approvers | [Thibault Soubiran](https://github.com/S0obi) |

Committers may change the source without further review. Changes from anyone else arrive as pull requests and are reviewed by a reviewer before they are merged. Approvers approve every signing request.

## Privacy

Kanopa sends nothing to any system except the LDAP directories you choose to connect to. It has no account, no telemetry and no update check. See [Your data](README.md#your-data).

## Check a download

In PowerShell:

    Get-AuthenticodeSignature .\Kanopa-<version>-windows-amd64-setup.exe | Format-List Status, SignerCertificate

A signed release reports `Status: Valid` and a signer of `SignPath Foundation`.

## Reporting

If you think a signed file was misused or did not come from this project, report it privately as described in [SECURITY.md](SECURITY.md).
