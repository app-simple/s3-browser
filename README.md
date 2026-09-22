<div align="center">

<img src="build/icon.png" alt="S3 Browser" width="128" height="128">

# S3 Browser

**A fast, native desktop client for Amazon S3 and every S3-compatible storage provider.**

An open, cross-platform alternative to the Windows-only S3 Browser / CS Browser.

[![Build](https://github.com/app-simple/s3-browser/actions/workflows/release.yml/badge.svg)](https://github.com/app-simple/s3-browser/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/app-simple/s3-browser?color=4f8cff)](https://github.com/app-simple/s3-browser/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-4f8cff.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-informational)](https://github.com/app-simple/s3-browser/releases/latest)

Made by **[app-simple.de](https://app-simple.de)**

</div>

---

## Install

Grab the installer for your platform from the [latest release](https://github.com/app-simple/s3-browser/releases/latest):

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon & Intel) | `.dmg` or `.zip` |
| Windows | NSIS installer `.exe` or portable `.exe` |
| Linux | `.AppImage` or `.deb` |

Your credentials never leave your machine — the app talks to your storage provider directly, with no backend in between.

## Supported providers

Pick a provider and the endpoint, region list and addressing mode are filled in for you:

| Provider | Endpoint | Addressing |
| --- | --- | --- |
| Amazon S3 | official AWS endpoints | virtual-hosted |
| MinIO / self-hosted | `http://localhost:9000` (editable) | path-style |
| Hetzner Object Storage | `https://{region}.your-objectstorage.com` | path-style |
| Backblaze B2 | `https://s3.{region}.backblazeb2.com` | virtual-hosted |
| Wasabi | `https://s3.{region}.wasabisys.com` | virtual-hosted |
| DigitalOcean Spaces | `https://{region}.digitaloceanspaces.com` | virtual-hosted |
| Cloudflare R2 | `https://{accountId}.r2.cloudflarestorage.com` | path-style |
| Scaleway Object Storage | `https://s3.{region}.scw.cloud` | virtual-hosted |
| STACKIT Object Storage | `https://object.storage.{region}.onstackit.cloud` | path-style |
| IONOS Object Storage | `https://s3-{region}.ionoscloud.com` | path-style |
| Storj | `https://gateway.storjshare.io` | path-style |
| Other S3-compatible | free-form endpoint | your choice |

Every setting — endpoint, region, path-style addressing, TLS behaviour — can be overridden per
connection, so anything speaking the S3 API works.

## Features

**Connections**
- Several accounts side by side, each with its own endpoint, region and credentials
- Test a connection before saving it, with targeted help when signing fails
- Secret keys encrypted through the OS keychain; the app tells you when that is unavailable
  instead of quietly storing them in the clear

**Browsing**
- Bucket list, folder navigation with breadcrumbs, sorting and a live filter
- Paging for prefixes with more than 1000 objects
- Object details: size, content type, ETag, storage class and custom `x-amz-meta-*` headers

**Transfers**
- Uploads via file picker, recursive folder picker or drag & drop, with automatic
  multipart upload for large files (8 MB parts, 4 in parallel)
- Downloads of single objects or whole prefixes, preserving the folder structure
- Copy and move between buckets — and between accounts, streaming directly from one
  provider to the other without touching the disk
- Bucket sync with resumable re-runs that skip objects already present at the destination
- Live progress per item, cancel while running, clear finished

**Managing**
- Create folders, rename, recursive delete, create and delete buckets
- Presigned share links from 15 minutes to 7 days, copied straight to the clipboard
- Light and dark theme, following the OS setting

## Development

```bash
npm install
npm run dev      # hot-reloading development app
```

### Building installers

```bash
npm run dist:mac     # .dmg + .zip (arm64 + x64)
npm run dist:win     # NSIS installer + portable .exe
npm run dist:linux   # AppImage + .deb
```

Output lands in `release/`. Cross-compiling from macOS to Windows works for the
portable target; for signed NSIS installers, build on Windows or in CI.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | development app with HMR |
| `npm run typecheck` | TypeScript check for main/preload and renderer |
| `npm run build` | typecheck + production bundle into `out/` |
| `npm run preview` | run the production bundle |
| `npm run dist` | build installers for the current platform |

### Project layout

```
src/
├── main/           Electron main process
│   ├── index.ts        window creation, navigation and permission policy
│   ├── origin.ts       the single source of truth for "is this our own page?"
│   ├── ipc.ts          typed IPC handlers (every call returns { ok, data | error })
│   ├── store.ts        account persistence + safeStorage encryption
│   ├── s3.ts           S3 client factory and all bucket/object operations
│   └── transfers.ts    upload/download/copy queue with progress events
├── preload/        contextBridge API exposed as window.api
├── shared/         types, provider presets, formatting helpers
└── renderer/       React UI
    └── src/
        ├── App.tsx
        └── components/  Sidebar, ObjectTable, TransferPanel, dialogs, icons
```

### Icon

`build/icon.svg` is the master artwork. The `icon.png`, `icon.icns` and `icon.ico`
next to it are generated from it and are what electron-builder ships.

## Security

The app holds credentials to your entire object storage, so it is built to keep the
blast radius small:

- **Isolated renderer.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` —
  the UI never touches Node or the AWS SDK directly; everything goes through the typed IPC
  bridge. Navigation away from the app, popups and `<webview>` are blocked, and every
  browser permission request is denied.
- **Authenticated IPC.** Handlers only accept calls from the main frame of the app's own
  window, and validate their arguments rather than trusting the caller.
- **Confined downloads.** Object keys on a shared bucket are attacker-controlled, so keys
  are never used as file paths directly: anything resolving outside the folder you picked
  is refused instead of written.
- **Uploads stay inside the selection.** Recursive uploads skip symlinks, so a link inside
  a folder cannot pull in files from elsewhere on your disk.
- **Credentials at rest.** Secret keys live in `accounts.json` in Electron's `userData`
  directory (`~/Library/Application Support/S3 Browser` on macOS, `%APPDATA%\S3 Browser`
  on Windows, `~/.config/S3 Browser` on Linux), encrypted through the OS keychain. Where no
  real keychain is available — including Linux systems that fall back to `basic_text`, whose
  key is hard-coded — the app says so in the connection dialog rather than implying
  protection it does not have.
- **Transport.** Plain-HTTP endpoints and the per-connection "allow self-signed TLS"
  option both carry a visible warning; the latter disables certificate checking entirely
  and is meant for local MinIO instances only.

Found something? Please open an issue.

## Known limitations

Not implemented yet: object versioning, lifecycle rules, bucket policy and CORS editors,
server-side encryption settings, and storage-class changes. The IPC layer is set up so these
slot in as additional handlers in `src/main/s3.ts`.

## Credits

Built and maintained by **[app-simple.de](https://app-simple.de)** — software from Germany.

If S3 Browser saves you time, a link back to [app-simple.de](https://app-simple.de) or a
star on this repository is appreciated.

## License

[MIT](LICENSE) © [app-simple.de](https://app-simple.de)
