# Kanopa

A calm, exact LDAP client for Windows and macOS.

## Stack

| Layer          | Choice                                                    |
| -------------- | --------------------------------------------------------- |
| Shell          | Wails 3 (Go)                                              |
| Framework      | Vue 3 + TypeScript + Vite                                 |
| Components     | shadcn-vue (Reka UI) in `frontend/src/components/ui`      |
| Style          | Tailwind CSS 4                                            |
| Icons          | `@lucide/vue` (successor of the deprecated `lucide-vue-next`) |
| Animations     | Motion for Vue (`motion-v`), Web Animations API, `canvas-confetti` |
| Global state   | Pinia (`frontend/src/stores`)                             |
| Routing        | Vue Router (hash history)                                 |
| Backend calls  | TanStack Query (`@tanstack/vue-query`) → generated Wails bindings |
| Forms          | VeeValidate + Zod 4 (adapter in `frontend/src/lib/zod-schema.ts`) |
| Utilities      | VueUse (dark mode, keyboard shortcuts, storage)           |

## Layout

```
main.go            app and window setup
partyservice.go    Go service exposed to the frontend
build/             per-platform packaging (icons, Info.plist, NSIS, MSIX…) and config.yml
frontend/          the Vue app; frontend/bindings is generated from the Go services
bin/               build output
```

## Develop

```bash
wails3 dev
```

This starts Vite on port 9245 and opens the app window with hot reload; Go changes rebuild automatically.
Opening http://127.0.0.1:9245 in a plain browser works too, but Go calls fall back to a browser stub there.

After changing a Go service's methods, the bindings in `frontend/bindings` are regenerated on the next `wails3 dev` or `wails3 build` (or run `wails3 generate bindings`).

## Build

```bash
wails3 build
```

Produces `bin/kanopa.exe` on Windows. Packaging:

| Target               | Command                              | Run on        |
| -------------------- | ------------------------------------ | ------------- |
| Windows installer    | `wails3 package` (NSIS; `FORMAT=msix` for MSIX) | Windows |
| Windows from a Mac   | `wails3 build GOOS=windows`          | macOS / Linux |
| macOS `.dmg`         | `wails3 task darwin:package:dmg`     | macOS         |
| Sign + notarize Mac  | `wails3 task darwin:sign:notarize`   | macOS         |

App name, identifier and version live in `build/config.yml`; after editing it, run `wails3 task common:update:build-assets` to regenerate the platform files.

## Prerequisites

- Go (latest), Node.js LTS
- `wails3` CLI: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`
- Windows: WebView2 (ships with Windows 11). No C compiler needed.
- macOS: Xcode Command Line Tools

Run `wails3 doctor` to check the setup.

## Adding shadcn-vue components

Run from `frontend/`:

```bash
npx shadcn-vue@latest add <component>
```

The CLI currently rewrites the `cn` import as `from "cn"` and installs an unrelated `cn` npm package. After adding a component, change the import to `from "@/lib/utils"` and run `npm uninstall cn`.
