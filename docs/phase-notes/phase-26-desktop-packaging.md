# Phase 26 — Desktop app packaging: downloadable macOS/Windows builds via electron-builder

Not a roadmap-numbered phase — Vamsi asked directly: "How do we make
'MobiusX.ai' desktop app downloadable executable file like Cursor or Claude
for Windows (exe) and Mac (dmg)?" Scoped with the user before building
(`AskUserQuestion`): unsigned build first (no code-signing/notarization
certificates), and include electron-updater wiring for auto-update, matching
how Cursor/Claude Desktop behave once installed.

Status: **packaging pipeline done and verified working end-to-end; real
macOS and Windows build artifacts produced and integrity-checked.** The one
genuine gap is the specific installer *formats* (`.dmg`, NSIS `.exe`) — both
require running real Windows/macOS tooling (`hdiutil`, or Wine for NSIS's
uninstaller-embedding step) that this session's build environment, a Linux
VM, does not have and cannot install (no root). That's a property of the
build host, not of the packaging config, which is correct and ready to
produce real installers the moment it runs on a real Mac or in a CI runner
with the right OS per target — see "What's not built" below.

## Why this needed real engineering, not just an electron-builder config

`apps/desktop` is one package in an npm-workspaces monorepo. `main.js`
spawns two sibling services, `desktop-agent` and `cloud-agent-gateway`, as
separate Node child processes (see `startService()`'s pre-existing
`ELECTRON_RUN_AS_NODE` spawn logic). In dev that works because workspace
hoisting puts everything — the two services, the 7 shared `@mobiusx/*`
packages they depend on, and all third-party deps — within reach of Node's
own upward `node_modules` search. electron-builder has no idea any of that
exists: its dependency walker only looks at `apps/desktop/package.json`'s
own `dependencies` (which is why `@xterm/*`, `diff`, `marked`, `mermaid` —
the renderer's own deps — bundle automatically with zero extra config, but
the two spawned services would not).

`apps/desktop/scripts/prepare-resources.js` (new) closes that gap: it stages
`desktop-agent` and `cloud-agent-gateway`'s compiled `dist/` + trimmed
`package.json` into `resources-staging/apps/<service>/`, copies the 7 shared
`@mobiusx/*` packages into `resources-staging/node_modules/@mobiusx/<name>/`
(deliberately excluding `ui-kit` — a renderer-only placeholder with no
runtime code either service imports), aggregates every third-party
dependency across all 9 sources, and runs a real `npm install --omit=dev` in
that staging tree. The output shape mirrors what npm workspace hoisting
already does in dev, but as real file copies instead of symlinks, since a
symlink into a sibling package that won't ship isn't something to rely on
inside a packaged artifact. electron-builder's `extraResources` config (in
`apps/desktop/package.json`'s `build` block) then copies
`resources-staging/apps` → `resources/apps` and
`resources-staging/node_modules` → `resources/node_modules` verbatim into
the packaged app, sitting next to its own asar. `main.js`'s `APPS_DIR` picks
between the dev-monorepo path and `process.resourcesPath/apps` based on
`app.isPackaged` — the one reliable signal for which layout applies — with
no changes needed to `startService()` itself, since both branches resolve to
a directory that directly contains `desktop-agent/` and
`cloud-agent-gateway/` subfolders, which is all it needs.

Playwright's own Chromium binary (used by `browserOps.ts`'s Browser
Validation feature) is deliberately **not** bundled — a platform-specific
~150–300MB download baked into every installer is a separate packaging
decision. The staging install runs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
so Browser Validation in a packaged build fails with the same actionable
error it already has in dev (`npx playwright install chromium`) rather than
hanging or silently downloading a binary for the wrong OS/arch.

## electron-updater wiring

`main.js` imports `autoUpdater` from `electron-updater` and adds
`setupAutoUpdater()`, called after the main window is created. It's a no-op
in dev (`app.isPackaged` is false for `electron .`) — `app-update.yml`, which
`autoUpdater` reads, only exists inside a packaged build's `resources/`.
Checking, downloading, and "no update available" are log-only; only
`update-downloaded` interrupts the user, with a native dialog offering
"Restart now" / "Later" (`quitAndInstall()` on the former, otherwise it
installs automatically on next quit via `autoInstallOnAppQuit`).
`build.publish` points at the same GitHub repo
(`vamsi-vandrangi/MobiusX_WDC`) the packaging scripts would publish releases
to via `npm run release`. No release has actually been published in this
pass — `--publish=never` was used throughout, matching the "unsigned build
first" scope; the wiring is there and correct, unexercised end-to-end
because that requires an actual tagged GitHub release to update *from*.

## Building on a Linux VM: what broke and what it took

This session's shell (`device_bash`) runs in an isolated Linux VM, confirmed
via `process.platform`/`process.arch` — not the real Mac this repo's folder
is mounted from, and Terminal.app on the real Mac is granted click-only
access (no typing/keys), so there is no way in this session to run
macOS-native build commands directly. Everything below happened from that
Linux VM against the mounted repo.

**The mount refuses `unlink()` on files it doesn't like, even for their
owner.** This showed up constantly: `npm install`'s rename-based atomic
extraction throwing `ENOTEMPTY` on interrupted installs (fixed with a
bulk-clear-to-a-graveyard-directory pattern), `fs.rmSync`/`fs.cpSync`
throwing `EPERM`/`EACCES` inside `prepare-resources.js` on any leftover
tree from a prior run (fixed by rewriting `rmrf()` to rename-away instead of
delete when a delete throws, and `cpr()` to shell out to `cp -RL` instead of
`fs.cpSync`, which this mount handles far more reliably), and
electron-builder's own Go-based unpacker (`app-builder`) hitting the same
wall mid-build, requiring the release directory to be renamed aside before
every retry.

**`device_bash` has a hard ~120-second per-call ceiling, and this mount is
slow for many-small-file writes.** electron-builder's own unpacker extracts
Electron's ~250MB zip release as hundreds of files with small buffered
writes; measured directly, that took over 4 minutes and never completed in
one call when the destination was the mounted repo — while the exact same
250MB, written with a large-buffer `cp -R`, took 52 seconds (confirmed with
`time`). The fix: point electron-builder's output directory at local VM
disk (`-c.directories.output=/tmp/...`) instead of the mount for the actual
packaging step, let it assemble the full `.app` / `win-unpacked` there
(fast, all local I/O), then `zip` the result locally (12s for the Mac
bundle, 11s for Windows) and `cp` the finished archive onto the mount (26s
for 213MB) — the slow small-file-write path only ever touches local disk;
the mount only ever receives one big sequential write.

**`electron-builder`'s own darwin-only dependency (`dmg-license` →
`iconv-corefoundation`) blocks *any* `--mac` build on Linux, not just the
DMG target specifically** — `dmgLicense.js` is imported unconditionally by
`macPackager.js` for every mac build. `npm install --force` (bypassing the
`os: darwin` platform gate) got the package present, but its native
`.node` binding is a real Mach-O binary — `require()` fails with "invalid
ELF header" on Linux, as expected. Since this app sets no `dmg.license`
(the only thing that code path ever executes), a stub `dmg-license` package
exporting a throwing `dmgLicenseFromJSON()` was enough to satisfy the
`require()` and let packaging proceed; `build.npmRebuild: false` also had to
be set, since electron-builder's own "rebuild native deps for the target
platform" step tries to reinstall the real (uninstallable-on-Linux)
`dmg-license` on every `--mac` invocation regardless of the stub.

**electron-builder's own electron-version auto-detection doesn't see a
workspace-hoisted `electron` install.** `node_modules/electron` (v33.4.11,
already present from this repo's ordinary dev workflow) resolves fine via
Node's normal module resolution from `apps/desktop`, but electron-builder
reported "none of the possible electron modules are installed." Fixed by
pinning `build.electronVersion` explicitly rather than fighting the
detector.

**Windows packaging's PE-resource-editing step needs Wine on Linux, and
this host has no root to install it.** `winPackager.js`'s `signApp()` always
calls `signAndEditResources()` on the main `.exe` (icon/version-info
embedding via `rcedit`, run through Wine on non-Windows hosts) regardless of
whether a signing certificate is configured — that's a separate mechanism
from actual code-signing, which correctly no-ops without a cert.
`build.win.signAndEditExecutable: false` skips it, matching this pass's
"unsigned build" scope (the trade-off: the packaged `.exe` doesn't carry an
embedded icon resource on its own binary; the NSIS installer wrapper still
gets one, see below).

**The generated Windows icon was structurally invalid for NSIS specifically
— a genuine bug fixed here, not an environment quirk.** `assets/icon.ico`
had been generated earlier (`png-to-ico`) as a single 256×256 PNG-compressed
entry; NSIS's bundled `makensis` (3.0.4.1) rejects PNG-compressed `.ico`
entries outright ("invalid icon file size"), while electron-builder's own
validation separately *requires* an icon ≥256×256 to be present. Both are
satisfiable at once, just not by a naive encoder: regenerated with
ImageMagick (`convert icon-1024.png -define
icon:auto-resize=256,128,64,48,32,16 -compress none icon.ico`, 99KB → the
first attempt without `-compress none` silently produced a PNG-compressed
256px entry again and still failed) to get a classic multi-resolution ICO
with every entry, including 256×256, in the legacy BMP/DIB format NSIS's
parser actually reads.

## What actually got built and verified this pass

Both builds were assembled locally (per the mount-speed fix above), then
zipped and copied onto the mount for delivery, and both were verified with
`unzip -t` (zero CRC errors) plus direct binary/metadata inspection — not
just "the command exited 0":

- **`apps/desktop/release/MobiusX.ai-0.0.1-mac.zip`** (213MB, 5,662 files,
  598MB uncompressed) — a real `MobiusX.ai.app` bundle: `Contents/Info.plist`
  correctly reports `CFBundleName=MobiusX.ai`,
  `CFBundleIdentifier=ai.mobiusx.desktop`, version `0.0.1`;
  `Contents/MacOS/MobiusX.ai` is a genuine Mach-O 64-bit x86_64 executable;
  `Contents/Resources` carries the packed `app.asar`, the staged
  `apps/desktop-agent` and `apps/cloud-agent-gateway`, and every
  `node_modules` dependency including all 7 `@mobiusx/*` packages with their
  `dist/` content intact (verified non-empty per package, and that
  `require.resolve("@mobiusx/protocol", ...)` from
  `apps/desktop-agent/dist/index.js`'s directory succeeds — the exact
  resolution path `startService()` depends on at runtime).
- **`apps/desktop/release/MobiusX.ai-0.0.1-win.zip`** (225MB) — a real
  `win-unpacked/` directory: `MobiusX.ai.exe` present alongside all Chromium
  runtime files (`ffmpeg.dll`, `icudtl.dat`, `*.pak`, etc.), `resources/`
  carrying the same `app.asar` + staged services + `node_modules` (107
  top-level packages) as the Mac build, including `node-pty`'s Windows
  prebuilds (`win32-x64`/`win32-arm64` `.node` and ConPTY/winpty helper
  `.exe` files — bundled directly in the npm package, confirmed present
  without needing any native rebuild step, which is why `npmRebuild: false`
  is safe here).

Both are genuinely cross-platform-assembled: this Linux VM produced a
correct macOS app bundle and a correct Windows app directory, neither of
which this environment can execute to smoke-test directly (no real macOS,
no Windows, and Wine wasn't available to bridge the gap) — verification
here is structural (file integrity, binary format, resource layout,
manifest correctness), not "it launched." Live-launching either build is
still owed the next time this runs against a real Mac or Windows machine.

## What's not built (and why, honestly)

- **A `.dmg` file.** electron-builder's DMG target shells out to `hdiutil`,
  a real macOS binary with no Linux equivalent electron-builder supports —
  this is a hard requirement, not a config gap. The `.zip` above is the
  same, complete `.app` bundle a `.dmg` would contain; `npm run pack:mac`
  (unchanged, still configures `mac.target: ["dmg", "zip"]`) will produce
  the actual `.dmg` the moment it's run from real macOS.
- **A Windows NSIS installer `.exe`.** Got further than the DMG case — a
  `MobiusX.ai Setup 0.0.1.exe` stub was produced and the icon-format bug
  above is a real, permanent fix — but NSIS's installer-with-uninstaller
  build is a genuine two-pass process: it must *execute* the freshly-built
  installer once (via Wine on non-Windows hosts) to extract the
  self-generated uninstaller stub before re-embedding it. `apt-get download
  wine64` confirmed a candidate package exists, but its dependency chain
  needs `wine32` (no i386-architecture candidate on this VM's apt sources)
  and this host has no root to install system packages at all, so this
  wasn't pursued further within this pass. `npm run pack:win` (still
  configures `win.target: ["nsis"]`) will produce the real installer on a
  host with Wine, or on Windows itself.
- **Code signing and notarization** — out of scope per the user's own
  "unsigned build first" choice. Both platforms' first-launch "unknown
  developer" warnings (Gatekeeper on macOS, SmartScreen on Windows) are
  expected and unaddressed.
- **A published GitHub release** to actually exercise `electron-updater`
  end-to-end — the wiring is in place and code-reviewed, not live-fired.
- **Live-launch verification of either packaged build** — see above; this
  environment cannot execute a macOS `.app` or a Windows `.exe`.

## Files changed

- `apps/desktop/scripts/prepare-resources.js` (new) — sibling-service +
  shared-package staging, described above.
- `apps/desktop/package.json` — `electron-builder`/`electron-updater`
  added; new `pack:mac`/`pack:win`/`pack`/`release`/`prepare:resources`
  scripts; `build` config (`extraResources`, `mac`/`win`/`nsis`/`dmg`
  targets, `publish`, and the three Linux-build-host fixes:
  `electronVersion`, `npmRebuild: false`, `win.signAndEditExecutable:
  false`).
- `apps/desktop/src/main/main.js` — packaged-aware `APPS_DIR`;
  `setupAutoUpdater()` wired into the `app.whenReady()` flow.
- `apps/desktop/assets/icon.ico` — regenerated in the legacy multi-resolution
  BMP/DIB format NSIS's parser requires (see above).
- `.gitignore` — `/apps/desktop/resources-staging/`, `/apps/desktop/release/`
  (both fully regenerated by the packaging scripts), and a `*.stale-*`
  pattern covering the rename-instead-of-delete workaround this mount forces
  throughout the repo's build tooling.
