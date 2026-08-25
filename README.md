# S3 Browser

A cross-platform desktop client for Amazon S3 and S3-compatible object storage —
an open alternative to the Windows-only S3 Browser / CS Browser.

Runs on **macOS, Windows and Linux**. Built with Electron, React and the AWS SDK v3.

## Supported providers

Ready-made presets for:

| Provider | Endpoint | Addressing |
| --- | --- | --- |
| Amazon S3 | official AWS endpoints | virtual-hosted |
| MinIO / self-hosted | `http://localhost:9000` (editable) | path-style |
| Hetzner Object Storage | `https://{region}.your-objectstorage.com` | path-style |
| Backblaze B2 | `https://s3.{region}.backblazeb2.com` | virtual-hosted |
| Wasabi | `https://s3.{region}.wasabisys.com` | virtual-hosted |
| DigitalOcean Spaces | `https://{region}.digitaloceanspaces.com` | virtual-hosted |
| Cloudflare R2 | `https://{accountId}.r2.cloudflarestorage.com` | path-style |
| Scaleway | `https://s3.{region}.scw.cloud` | virtual-hosted |
| IONOS | `https://s3-{region}.ionoscloud.com` | path-style |
| Storj | `https://gateway.storjshare.io` | path-style |
| Other S3-compatible | free-form endpoint | your choice |

Every setting (endpoint, region, path-style, self-signed TLS) can be overridden
per connection, so anything speaking the S3 API works.

## Features

- **Multi-account** — several connections side by side, each with its own endpoint and region
- **Secure credentials** — secret keys are encrypted with Electron `safeStorage`, which uses the
  macOS Keychain, Windows DPAPI or libsecret/kwallet on Linux. Nothing leaves your machine.
- **Browsing** — bucket list, folder navigation with breadcrumbs, sorting, live filter,
  paging for buckets with more than 1000 objects
- **Uploads** — file picker, folder picker (recursive) and drag & drop, with automatic
  multipart upload for large files (8 MB parts, 4 parallel)
- **Downloads** — single objects or whole prefixes, preserving the folder structure
- **Transfers panel** — live progress per item, cancel while running, clear finished
- **Object management** — create folders, rename (copy + delete), recursive delete,
  create and delete buckets
- **Object details** — size, content type, ETag, storage class, custom `x-amz-meta-*` headers
- **Presigned share links** — 15 min to 7 days, copied straight to the clipboard
- **Light and dark theme** — follows the OS setting

## Getting started

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
portable target; for signed NSIS installers build on Windows (or in CI).

> Add `build/icon.png` (1024×1024) before shipping — without it electron-builder
> falls back to the default Electron icon.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | development app with HMR |
| `npm run typecheck` | TypeScript check for main/preload and renderer |
| `npm run build` | typecheck + production bundle into `out/` |
| `npm run preview` | run the production bundle |
| `npm run dist` | build installers for the current platform |

## Project layout

```
src/
├── main/           Electron main process
│   ├── index.ts        window creation, app lifecycle
│   ├── ipc.ts          typed IPC handlers (every call returns { ok, data | error })
│   ├── store.ts        account persistence + safeStorage encryption
│   ├── s3.ts           S3 client factory and all bucket/object operations
│   └── transfers.ts    upload/download queue with progress events
├── preload/        contextBridge API exposed as window.api
├── shared/         types, provider presets, formatting helpers
└── renderer/       React UI
    └── src/
        ├── App.tsx
        └── components/  Sidebar, ObjectTable, TransferPanel, dialogs, icons
```

## Security notes

- `contextIsolation: true`, `nodeIntegration: false` — the renderer never touches Node
  or the AWS SDK directly; everything goes through the typed IPC bridge.
- A Content-Security-Policy in `index.html` blocks remote script and style loading.
- Secret keys live in `accounts.json` inside Electron's `userData` directory
  (`~/Library/Application Support/S3 Browser` on macOS,
  `%APPDATA%\S3 Browser` on Windows, `~/.config/S3 Browser` on Linux),
  encrypted with the OS keychain. If no keychain is available (some headless Linux
  setups) they are stored in plain text with `0600` permissions — the app does not
  pretend otherwise.
- "Allow self-signed TLS certificates" is per connection and off by default. Only
  enable it for local MinIO instances.

## Known limitations

Not implemented yet: object versioning, lifecycle rules, bucket policy and CORS editors,
server-side encryption settings, storage-class changes, and cross-bucket copy/move.
The IPC layer is set up so these slot in as additional handlers in `src/main/s3.ts`.

## License

MIT
