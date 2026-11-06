# Kanopa

A calm, exact LDAP client for Windows and macOS. The road to v0.1.0 is in [docs/plan.html](docs/plan.html).

## Stack

| Layer | Choice |
|---|---|
| Shell | Wails 3 (Go) |
| LDAP | `github.com/go-ldap/ldap/v3`, wrapped in `internal/ldapx` |
| Frontend | React 19 + TypeScript 7 + Vite 8 |
| Components | The Kanopa design system ported to TSX in `frontend/src/ui` |
| Style | Tailwind CSS 4, themed from `frontend/src/theme/tokens.json` |
| Forms | React Hook Form + Zod |
| Tests | Go (unit + testcontainers), Vitest + Testing Library, Playwright |

## Layout

```
main.go                 app, window, services
services/               Go services exposed to the frontend (bindings in frontend/bindings)
internal/ldapx/         dial, TLS, bind, root DSE, errors worded with result codes
internal/applog/        rotating log file, secrets dropped
internal/testldap/      starts the OpenLDAP fixture for integration tests
test/ldap/              the OpenLDAP fixture (see its README for accounts)
frontend/src/ui/        Kanopa components
frontend/src/features/  screens
frontend/src/api/       backend interface: Wails bindings, or a fake for tests
build/                  packaging; app name, id and version in build/config.yml
```

## Develop

```bash
wails3 task ldap:up
```

```bash
wails3 dev
```

`wails3 dev` starts Vite on port 9245 and opens the app window with hot reload. To work on the UI in a plain browser against the fake backend, run `npm run dev -- --mode fake` in `frontend/`.

Kanopa keeps its files in `%AppData%\Kanopa` on Windows and `~/Library/Application Support/Kanopa` on macOS: `connections.json` (saved connections, never passwords) and `logs/`. Passwords are in the Windows Credential Manager or the macOS Keychain, under "Kanopa".

## Test

```bash
wails3 task test
```

That runs `test:go` (Go unit), `test:web` (Vitest), `test:e2e` (Playwright, fake backend) and `test:it` (Go against OpenLDAP in Docker). On Windows, Docker runs inside WSL: see [test/ldap/README.md](test/ldap/README.md). The first Playwright run needs `npx playwright install chromium` in `frontend/`.

After changing a Go service's methods, regenerate the bindings with `wails3 generate bindings -clean=true -ts -i` (or run `wails3 dev`/`wails3 build`). After editing `tokens.json`, run `npm run tokens` in `frontend/`.

## Build

```bash
wails3 build
```

This produces `bin/kanopa.exe` on Windows. Packaging (`wails3 package`, `wails3 task darwin:package:dmg`) comes in stage 6.

## Prerequisites

- Go 1.26+, Node.js 22+
- `wails3` CLI: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`
- Docker (on Windows: Docker Engine in WSL, see test/ldap/README.md)
- Windows: WebView2 (ships with Windows 11). macOS: Xcode Command Line Tools
