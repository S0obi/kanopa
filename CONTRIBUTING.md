# Contributing to Kanopa

Thanks for helping. This page is for running Kanopa from source. For what the app does and how to install it, see the [README](README.md).

## What you need

- Go 1.26+ and Node.js 22+
- The `wails3` CLI: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`
- Docker, for the test directory (on Windows: Docker Engine inside WSL, see [test/ldap/README.md](test/ldap/README.md))
- Windows: WebView2 (it ships with Windows 11). macOS: Xcode Command Line Tools

## Run it

Start the test directory, then the app:

```bash
wails3 task ldap:up
```

```bash
wails3 dev
```

`wails3 dev` starts Vite on port 9245 and opens the app window with hot reload. To work on the UI in a plain browser against a fake directory, run `npm run dev -- --mode fake` in `frontend/`.

The test directory has accounts and sample data (Ada, Grace, groups, a large profile, awkward entries in `ou=edge`). They are listed in [test/ldap/README.md](test/ldap/README.md).

## Test

```bash
wails3 task test
```

That runs `test:go` (Go unit), `test:web` (Vitest), `test:e2e` (Playwright, fake backend) and `test:it` (Go against OpenLDAP in Docker). The first Playwright run needs `npx playwright install chromium` in `frontend/`.

After changing a Go service's methods, regenerate the bindings with `wails3 generate bindings -clean=true -ts -i` (or run `wails3 dev` or `wails3 build`). After editing `tokens.json`, run `npm run tokens` in `frontend/`.

A commit runs the checks through lefthook: golangci-lint with gosec, govulncheck, `npm audit`, oxlint and `tsc`. Install the tools once with `wails3 task tools`.

## Build

```bash
wails3 build
```

This produces `bin/kanopa.exe` on Windows. A local build reports itself as `0.1.0-dev`; a release build passes `VERSION=0.1.1`.

## Releasing

Releases are cut from `main`. Put the changes under a new version in `CHANGELOG.md` and set the version in `build/config.yml`, `frontend/package.json` and the Windows and macOS metadata, then tag:

```bash
git tag v0.1.0-rc.1 && git push origin v0.1.0-rc.1
```

The Release workflow builds the Windows installer and portable zip and the universal macOS `.dmg`, and attaches them to a draft release whose notes are the tag's CHANGELOG section. A tag with a suffix (`-rc.1`) is a dry run and is marked as a pre-release. Check the draft's files on each system, then push the plain tag (`v0.1.0`) and publish the draft.

## README images

`npm run screenshots` and `npm run demo`, in `frontend/`, redraw the banner and the GIF in `docs/screenshots/`. The demo needs `ffmpeg`.

## Where things are

```
main.go                 app, window, services
services/               Go services exposed to the frontend (bindings in frontend/bindings)
internal/ldapx/         dial, TLS, bind, root DSE, errors worded with result codes
internal/applog/        rotating log file, secrets dropped
internal/testldap/      starts the OpenLDAP fixture for integration tests
test/ldap/              the OpenLDAP fixture
frontend/src/ui/        Kanopa components
frontend/src/features/  screens
frontend/src/api/       backend interface: Wails bindings, or a fake for tests
build/                  packaging; app name, id and version in build/config.yml
```

## Stack

Wails 3 (Go) for the shell, `go-ldap` for LDAP, React 19 with TypeScript and Vite for the UI, Tailwind CSS themed from `frontend/src/theme/tokens.json`. Tests are Go (unit and testcontainers), Vitest with Testing Library, and Playwright.

## Writing style

Interface text is sentence case, plain, and says what happened with the LDAP result code in brackets, for example "Invalid credentials (49)". No "please", no "successfully", no exclamation marks. Tests in `copy_test.go` and `frontend/src/copy.test.ts` check this.
