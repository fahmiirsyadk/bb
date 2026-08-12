# @bb/desktop

Cross-platform Electron shell for bb. The desktop app loads the existing bb web
UI and uses the packaged `bb-app` launcher for server and host-daemon lifecycle.

The checked-in desktop target matrix is intentionally narrow:

- macOS: arm64 `.dmg` and `.zip` installers
- Linux: x64 AppImage and Debian `.deb` packages
- Windows: no Electron target
- Linux `.rpm`: not configured

The source bridge, contracts, native-module preparation, and update-feed
generation support both `macos` and `linux`. The configured Linux installer
target is x64 only; native-module preparation also recognizes Linux arm64 for
source or explicitly selected packaging work, but there is no arm64 Linux
artifact target. The manually dispatched Build Desktop workflow runs both the
macOS arm64 and Ubuntu Linux x64 jobs. Linux packages, metadata, and packaged
smoke output are uploaded as the `bb-desktop-linux-x64` workflow artifact;
stable public desktop releases currently publish only macOS assets.

## Linux and WSL2 launch path

On Linux or WSL2, launch the supported runtime and open its browser UI:

```bash
npx bb-app@latest
```

Then open `http://localhost:38886`. For source development, use `pnpm dev` and
open the URL printed by the launcher. These paths start the server and local
host daemon without requiring Electron.

To develop the Linux Electron shell itself, use the normal source loop from a
Linux checkout:

```bash
pnpm dev:desktop
```

or run the package task directly:

```bash
pnpm exec turbo run dev --filter=@bb/desktop
```

The source loop can run on Linux arm64 or x64 when the host has the matching
Electron/native-module dependencies. Packaged Linux output remains x64 only.

## Build on Void Linux

Void Linux can build the configured Linux x64 desktop artifacts. Install the
Electron runtime libraries, native-build toolchain, and optional headless
display with `xbps`:

```bash
sudo xbps-install -S \
  base-devel git curl python3 pkgconf \
  gtk+3-devel libnotify-devel nss-devel \
  libXScrnSaver-devel libXtst-devel libsecret-devel \
  libayatana-appindicator-devel xdg-utils fuse xorg-server-xvfb
```

Use Node.js 22.19 or newer and pnpm 9.15.0, then install and build from the
repository root:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck --filter=@bb/desktop --filter=bb-app --output-logs=new-only
pnpm exec turbo run build --filter=@bb/desktop --force --output-logs=new-only
```

Create the unpacked directory for a launch/smoke check, then create the
AppImage and Debian package. `--publish never` keeps a local build offline
from release publication:

```bash
node apps/desktop/scripts/run-electron-builder.mjs \
  --linux --x64 --dir --publish never
pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force

node apps/desktop/scripts/run-electron-builder.mjs \
  --linux AppImage deb --x64 --publish never
pnpm --dir apps/desktop run desktop:version-feed
```

If the Void session has no graphical display, run the packaged smoke under the
headless X server installed above:

```bash
xvfb-run -a pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force
```

The outputs are in `apps/desktop/release/`: `bb-<version>-x86_64.AppImage`,
`bb-<version>-amd64.deb`, `latest-linux.yml`, and `desktop-version.json`. Void's
`xbps` does not install Debian packages, so use the AppImage for a native Void
launch. Validate the `.deb` archive with `ar`/`tar`, or install it on a Debian
family system for an installation smoke test.

## Development

From the repo root, the full source dev loop is:

```bash
pnpm dev:desktop
```

That starts the source dev server and the Electron shell through
`scripts/bb-dev-app`. To run only the desktop package task directly:

```bash
pnpm exec turbo run dev --filter=@bb/desktop
```

The dev script builds `bb-app`, compiles the Electron main/preload files, and
opens Electron directly. By default it uses the same checkout-scoped
`~/.bb-dev/<checkout-instance>` data directory and deterministic high ports as
the main repo dev launcher; it prints the resolved data dir, server URL, and
Electron user-data dir at startup. It intentionally overwrites inherited
`BB_DATA_DIR`, `BB_SERVER_PORT`, `BB_SERVER_URL`, and `BB_HOST_DAEMON_PORT` so a
desktop dev run launched from an existing bb session still targets the current
checkout. Set `BB_DESKTOP_USER_DATA_DIR` to override only Electron's user-data
directory.

The launcher probes the checkout's Vite app port at startup and adapts:

- **`pnpm dev` is already running** (Vite reachable): the shell loads the Vite
  dev URL, so you get live source and HMR for `@bb/app` changes — no rebuild
  needed. It still attaches to the same running server/daemon for all API/WS
  traffic. The launcher prints `app <url> (Vite dev server — live reload)`. This
  is the fast loop for iterating on the desktop UI.
- **`pnpm dev` is not running**: the shell starts its own `bb-app` runtime and
  loads the built UI it serves, so you must rebuild (re-run this task) to pick up
  source changes. The launcher prints `app (own bb-app runtime — …)`.

The override is plumbed via `BB_DESKTOP_APP_URL`, which the launcher only sets
when Vite is confirmed reachable; it is never set in packaged builds, so
production always loads the server's own built UI.

To run the slower unpacked Electron Builder app, which more closely matches the
packaged runtime and keeps native dependencies rebuilt for Electron's bundled
Node runtime:

```bash
pnpm exec turbo run start --filter=@bb/desktop
```

The `start` helper supports both macOS and Linux. On Linux it launches the
`linux-unpacked` executable when present, or a generated AppImage.

Electron is pinned to `41.7.0`, the highest stable line verified to rebuild the
packaged native modules with the current dependency set. Electron 42.2.0 was
tested, but `better-sqlite3@12.10.0` does not compile against Electron ABI 146.
Revisit the pin when `better-sqlite3` ships support or prebuilds for that ABI.

## Validation

```bash
pnpm exec turbo run typecheck --filter=@bb/desktop --filter=bb-app
pnpm exec turbo run build --filter=@bb/desktop
pnpm exec turbo run test --filter=@bb/desktop --filter=bb-app --force
pnpm exec turbo run dev --filter=@bb/desktop
```

For the supported Linux/WSL2 runtime smoke, use the npm tarball path:

```bash
pnpm exec turbo run smoke:tarball --filter=bb-app --force
```

`smoke:packaged` launches the packaged desktop executable for the host platform
and must run on that platform. macOS uses the `.app` bundle; Linux uses the
unpacked executable or AppImage. The Ubuntu workflow runs the Linux smoke under
`xvfb-run` before producing the AppImage and `.deb` artifacts.

## Packaging

```bash
pnpm exec turbo run desktop:build --filter=@bb/desktop
```

Run the build on the target OS. The configured macOS target is arm64; the
configured Linux targets are x64. Artifacts are written under
`apps/desktop/release/`. For a stable version `<version>`, the installer
artifacts are named:

- `bb-<version>-arm64.dmg`
- `bb-<version>-arm64.zip`
- the corresponding `.blockmap` files used for differential updates

On Linux x64, the corresponding local artifacts are:

- `bb-<version>-x86_64.AppImage`
- `bb-<version>-amd64.deb`

There is no `.rpm` target. The Linux artifact names use electron-builder's
platform-specific architecture names (`x86_64` for AppImage and `amd64` for
Debian), while the target policy remains x64.

The native update metadata is platform-specific: `latest-mac.yml` on macOS and
`latest-linux.yml` on Linux. After packaging, generate the renderer-facing feed
with:

```bash
pnpm --dir apps/desktop run desktop:version-feed
```

That writes `apps/desktop/release/desktop-version.json`; its `platform` is
`macos` or `linux` according to the build host, and its file information is
derived from the matching platform metadata. Nightly builds use the same
directory and target matrix, with:

- macOS: `bb-nightly-<version>-arm64.dmg`,
  `bb-nightly-<version>-arm64.zip`, and `nightly-mac.yml`
- Linux x64: `bb-nightly-<version>-x86_64.AppImage`,
  `bb-nightly-<version>-amd64.deb`, and `nightly-linux.yml`

The manually dispatched workflow uploads both platform outputs as workflow
artifacts. Stable public releases currently attach only the macOS metadata and
installers; Linux metadata and installers are not public release assets yet.

For a manual Linux x64 launch check after packaging:

```bash
chmod +x apps/desktop/release/bb-<version>-x86_64.AppImage
./apps/desktop/release/bb-<version>-x86_64.AppImage
```

On a Debian-family system, the `.deb` can be installed with `apt`; Void users
should run the AppImage because `xbps` does not consume Debian packages.

The repository's packaged-app helper supports macOS and Linux. The Linux CI
smoke launches the unpacked executable under a virtual display; installing a
`.deb` remains a manual Debian-family install check. The unpacked Linux launch
can also be exercised locally with
`pnpm exec turbo run start --filter=@bb/desktop`.

Without signing secrets, local builds sign with a code-signing identity
auto-discovered from the keychain and skip notarization. A valid signature
matters even for local builds: macOS
provenance-tracks unsigned apps, forcing syspolicyd to evaluate every exec in
the app's process tree, which can stall process launches system-wide. On
machines with no keychain identity (or with `CSC_IDENTITY_AUTO_DISCOVERY=false`,
as CI sets for workflow-artifact-only builds), artifacts remain unsigned and
macOS shows the normal Gatekeeper warning on first launch.

## Releasing

`bb-app` and `@bb/desktop` versions are LOCKED in lockstep. The desktop package
depends on `bb-app: workspace:*`, and the displayed release version string must
match `packages/bb-app/package.json`.

To bump for a release:

```bash
node scripts/bump-version.mjs <new-version>
```

Then commit and ship through the normal `sawyer-next` → `main` flow. You can also
use `--patch`, `--minor`, or `--major` instead of an explicit version.

CI enforces this lockstep. Direct edits that leave
`packages/bb-app/package.json` and `apps/desktop/package.json` with different
versions fail the build. Never edit either package version directly for a
release; use `scripts/bump-version.mjs` so both files move together.

The desktop release tag uses the locked version: `desktop-v<version>` for
immutable releases and `desktop-latest` for the moving pointer.

Stable signed macOS artifacts are uploaded to both the immutable
`desktop-v<version>` release and the moving `desktop-latest` release. The
moving release is the stable download and update location; public release
publication currently puts macOS assets there only. The manually dispatched
workflow also uploads Linux packages and metadata as `bb-desktop-linux-x64`,
but those files are not attached to the public releases yet. If the
signing/notarization gate is closed, the workflow
publishes macOS `desktop-version.json` metadata without the unsigned installer
artifacts.

## Nightly channel

The scheduled `publish-bb-app.yml` workflow runs from `main` every day at
3:00 AM Pacific (`America/Los_Angeles`, including daylight-saving changes). It
derives a unique version such as `0.34.1-nightly.<run-id>.<attempt>` without
committing that version, publishes `bb-app` with the npm `nightly` dist-tag,
and builds the desktop app from that same lockstep version.

To publish or dry-run the channel manually from `main`, dispatch the same
workflow with `npm_tag=nightly`. A non-dry run publishes both npm and desktop;
a dry run validates only the npm package path.

The nightly desktop is a separate installation:

- product name: `bb Nightly`
- bundle identifier: `dev.bb.desktop.nightly`
- app/update release: `desktop-nightly`
- macOS update metadata: `nightly-mac.yml`
- Linux update metadata: `nightly-linux.yml`
- icon: `assets/icon-nightly.icns` and `assets/icon-nightly.png`

Its macOS installer names are `bb-nightly-<version>-arm64.dmg` and
`bb-nightly-<version>-arm64.zip`. Local Linux x64 packaging uses
`bb-nightly-<version>-x86_64.AppImage` and
`bb-nightly-<version>-amd64.deb`. The nightly release workflow currently
publishes macOS arm64 only.

Download it from
[`desktop-nightly`](https://github.com/get-bb/bb/releases/tag/desktop-nightly)
or run the CLI build with:

```bash
npx bb-app@nightly
```

Stable and nightly desktop bundles can coexist. Electron-owned preferences,
window state, and process supervision use separate application data
directories; the embedded bb runtime still uses the normal `~/.bb` data and
default server port unless the corresponding environment variables are
overridden.

Nightly builds set `BB_DESKTOP_RELEASE_CHANNEL=nightly` at build time. The value
is baked into the Electron main/preload bundles and selects the nightly product
identity, yellow icon, and update URLs. Omit the variable (or set it to
`latest`) for stable and local builds.

## macOS signing + notarization

The desktop package is ready for Developer ID signing and Apple notarization.
Local builds with no secrets sign via keychain auto-discovery and skip
notarization. To activate signed and notarized release artifacts, add these
GitHub Actions secrets:

| Secret                       | Value                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64-encoded `.p12` exported from Keychain Access for a `Developer ID Application` certificate and its private key. On macOS: `base64 -i DeveloperID.p12 -o certificate.base64.txt`. |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`.                                                                                                                                               |
| `MACOS_CERTIFICATE_NAME`     | Optional certificate common name, without the `Developer ID Application:` prefix. Leave unset when the `.p12` contains a single usable identity and electron-builder can derive it.    |
| `APPLE_ID`                   | Apple ID email for the Developer Program account.                                                                                                                                      |
| `APPLE_APP_PASSWORD`         | App-specific password from `appleid.apple.com` under Sign-In and Security.                                                                                                             |
| `APPLE_TEAM_ID`              | Developer Team ID from `developer.apple.com/account` membership details.                                                                                                               |

Once those secrets are present, the next `Build Desktop` workflow run with
`publish=true` and `release_channel=stable` signs the `.app`, notarizes it, and
publishes the signed `.dmg` / `.zip` assets to `desktop-latest`. If no required
signing secrets are configured, the workflow still builds unsigned artifacts, but
the release job publishes only `desktop-version.json` and withholds unsigned
binaries from `desktop-latest`. If only some required signing secrets are set,
the workflow fails before packaging so a misconfigured release cannot silently
produce unsigned or signed-but-not-notarized artifacts.

## Auto-update

The desktop app has two update surfaces:

- The renderer update indicator reads `desktop-version.json` from
  `https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version.json`
  for stable, or the equivalent `desktop-nightly` URL for nightly. This is the
  lightweight version/info feed generated from the channel's platform-specific
  metadata and includes `platform: "macos"` or `platform: "linux"`.
- `electron-updater` uses the generic GitHub release directory and reads
  `latest-mac.yml`/`nightly-mac.yml` on macOS or
  `latest-linux.yml`/`nightly-linux.yml` on Linux before downloading and
  installing an update.

Packaged builds check these surfaces on launch, hourly, and when the app becomes
active. The JSON feed can show "update available" even when CI has published
metadata only, while the Electron updater only reports an installable update
after a signed update has downloaded. In source development, the lightweight
feed is opt-in with `BB_DESKTOP_VERSION_CHECK=1`. Native auto-update is
opt-in with `BB_DESKTOP_AUTO_UPDATE=1` on macOS; Linux requires the AppImage
runtime as described below. `BB_DESKTOP_VERSION_FEED_URL` can point the
lightweight check at a local test feed; it does not create a Linux update
channel.

`bb Nightly` follows the equivalent isolated `desktop-nightly` release and
platform-specific nightly metadata; it never reads or moves the stable feed.
The scheduled workflow requires the complete signing/notarization secret set
before publishing nightly macOS desktop assets.

Native Electron auto-update is enabled for packaged Linux AppImages, but not
for `.deb` installs (the runtime checks for the AppImage environment before
enabling `electron-updater`). A `.deb` installation must be updated by
installing a newer package. The current public release feeds contain macOS
assets only; Linux feed metadata is generated and uploaded with the
`bb-desktop-linux-x64` workflow artifact, pending public Linux release
publication.

To verify a downloaded or unpacked build:

```bash
spctl --assess --verbose /path/to/bb.app
codesign --verify --deep --strict --verbose=2 /path/to/bb.app
```

## Debugging

On Linux or WSL2, debug either the Electron source loop with
`BB_DESKTOP_OPEN_DEVTOOLS=1 pnpm dev:desktop` or the supported browser runtime
with `npx bb-app@latest`/`pnpm dev`. Server and host-daemon logs are under
`~/.bb/logs/` or `$BB_DATA_DIR/logs/` when `BB_DATA_DIR` is set.

Use the View menu to toggle DevTools. To open them automatically on launch, set
`BB_DESKTOP_OPEN_DEVTOOLS=1`:

```bash
BB_DESKTOP_OPEN_DEVTOOLS=1 apps/desktop/release/mac-arm64/bb.app/Contents/MacOS/bb
```

For a locally built Linux x64 AppImage, use the same override when launching
the artifact directly:

```bash
BB_DESKTOP_OPEN_DEVTOOLS=1 ./apps/desktop/release/bb-<version>-x86_64.AppImage
```

When the desktop app spawns `bb-app`, server and daemon logs land under
`~/.bb/logs/` or `$BB_DATA_DIR/logs/` when `BB_DATA_DIR` is set.

To verify attach-if-found manually, start a compatible bb first, then launch the
desktop app:

```bash
npx bb-app@latest
pnpm exec turbo run dev --filter=@bb/desktop
```

The desktop supervisor handles normal quits plus `SIGINT` and `SIGTERM`, and it
writes a PID file so the next launch can reap a stale Electron-owned `bb-app`
launcher. Hard crashes such as process aborts, segfaults, or kernel-level kills
cannot run cleanup in the crashing process; the startup PID-file reap is the
recovery path for those cases.
