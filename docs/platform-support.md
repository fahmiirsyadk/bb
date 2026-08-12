<!-- Diátaxis: reference -->

# Platform Support

## Supported host environments

- macOS persistent host
- Linux persistent host, including non-systemd distributions such as Void Linux
- Windows native persistent host (PowerShell installer)
- Windows via Ubuntu on WSL2

Minimum runtime: Node.js 22.19. The floor comes from Pi, whose packages declare
`engines.node: ">=22.19.0"`.

Tested npm package runtimes:

- Node.js 22.19 or newer in the Node.js 22 release line
- Node.js 24 LTS
- Node.js 26 Current

Newer release lines are not blocked. `install-machine.sh` gates on the 22.19
floor only, so a release line we have not tested yet still installs rather than
failing hard on the day it ships. The `bb-app` npm `engines` field lists the
tested lines, which npm surfaces as a warning rather than an install failure.

WSL2 remains a supported Linux host path:

- all `bb` processes run inside the same Ubuntu WSL2 distro
- Node.js, Git, provider CLIs, and pnpm for source-development flows are
  installed inside WSL2
- local project paths use Linux-style absolute paths from inside WSL2

## Desktop client support

The supported Linux and WSL2 product path is the cross-platform `bb-app`
runtime: it starts the server and host daemon and serves the UI in a browser.
The Electron desktop shell in [`apps/desktop/`](../apps/desktop/) has source and
packaging paths for macOS and Linux, with a deliberately limited artifact
matrix:

| Platform | Configured architecture | Artifacts           | Channel metadata                         |
| -------- | ----------------------- | ------------------- | ---------------------------------------- |
| macOS    | arm64 only              | `.dmg`, `.zip`      | `latest-mac.yml` / `nightly-mac.yml`     |
| Linux    | x64 only                | `.AppImage`, `.deb` | `latest-linux.yml` / `nightly-linux.yml` |
| Windows  | none                    | —                   | —                                        |

There is no `.rpm` target. The native-module preparation code recognizes both
Linux arm64 and Linux x64, but the electron-builder target is x64 only; Linux
arm64 is not a published or configured installer architecture. Likewise,
macOS x64 is not a configured installer target even though some native
prebuilds may exist for it.

All local desktop output is written to `apps/desktop/release/`. Stable Linux
x64 names are `bb-<version>-x86_64.AppImage` and
`bb-<version>-amd64.deb`; nightly names add the `bb-nightly-` prefix. The
architecture spelling comes from electron-builder (`x86_64` for AppImage and
`amd64` for Debian), not from a broader support claim.

The platform-aware `desktop-version.json` feed is generated from the matching
macOS or Linux metadata and reports `platform: "macos"` or `platform: "linux"`.
Packaged Linux AppImages may use the native Electron updater when the AppImage
runtime is present. `.deb` installations do not enable that updater and must
be updated by installing a newer package.

The manually dispatched Build Desktop workflow runs macOS arm64 and Ubuntu
Linux x64 jobs. The Linux job packages and smoke-tests the desktop shell, then
uploads the AppImage, `.deb`, matching metadata, and `desktop-version.json` as
the `bb-desktop-linux-x64` workflow artifact. Stable public desktop releases
currently publish macOS assets only, so Linux installer downloads are not yet
attached to the public release feed. Linux users who need the supported product
path should run `npx bb-app@latest` and open `http://localhost:38886`, or use
`pnpm dev` for a source checkout.

### Native Windows expectations

- native Windows PowerShell uses the per-user host-daemon installer exposed as
  `/install.ps1`; it does not require Tailscale or an administrator account
- native Windows drive-letter and UNC project paths are accepted by the server
  and are executed by the paired Windows host
- the native Windows host currently does not provide an embedded terminal; use
  a provider session or WSL for terminal-heavy workflows

## Support Boundaries

### Supported product flows

- `npx bb-app`
- `npx --package bb-app bb ...`
- source checkout package startup with `pnpm start`
- source checkout validation with `pnpm install`, `pnpm build`,
  `pnpm exec turbo run typecheck`, and `pnpm exec turbo run test`
- app + server + host-daemon startup on supported persistent-host OSes
- local-path project creation and update in the app
- unmanaged environments
- managed worktree environments
- provider runtime startup where the provider itself supports the host
  environment
- `npx bb-app` package startup on supported npm package runtimes
- `npx --package bb-app bb ...` CLI execution through the published package

### Command ownership and mode selection

- `@bb/config` is the only source of dev/prod defaults.
- Repo-root source-development commands such as `pnpm start`, `pnpm bb`,
  `pnpm bb:dev`, and `pnpm reset` are thin wrappers around local packages and
  scripts.
- Those wrappers set `NODE_ENV` explicitly so ambient shell state does not
  change which bb instance they target.
- Explicit `BB_*` values override the `NODE_ENV`-selected defaults.
- Process-to-process handoff, such as daemon-injected CLI environment, must use
  explicit `BB_*` values for the exact target instance instead of relying on
  mode defaults.

### WSL2-specific expectations

- Run `npx bb-app`, source checkout commands such as `pnpm install`,
  `pnpm dev`, `pnpm bb:dev`, and host-daemon commands from a WSL2 shell, not
  from native Windows terminals.
- Repositories inside the WSL filesystem are recommended for best behavior.
- `/mnt/c/...` mounted paths are deliberately supported so WSL2 users can keep
  working with existing Windows checkouts instead of relocating every repo into
  the WSL filesystem, but they are a tradeoff:
  slower filesystem I/O and weaker file-watching behavior than the WSL
  filesystem.
- Native Windows drive-letter and UNC paths should be used from the Windows
  installer path instead of being converted to `/mnt/c` paths.

### Maintainer-only or best-effort surfaces

- workspace-owned QA helpers under [`tests/qa/`](../tests/qa/)
- dev restart internals that are not part of the shipped product path
- native Windows terminal and shell-hook flows (the host daemon itself is
  supported; these surfaces remain best-effort)

The `@bb/desktop` packaged smoke test is platform-specific: it launches the
packaged executable for the current host and must run on that host:

```bash
pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force
```

On Linux CI the same command runs under `xvfb-run` against the unpacked Linux
desktop executable. The corresponding supported Linux/WSL2 runtime smoke is the
`bb-app` tarball check:

```bash
pnpm exec turbo run smoke:tarball --filter=bb-app --force
```

For a local Linux check, build on Linux x64 and run
`pnpm exec turbo run start --filter=@bb/desktop` (which launches the unpacked
executable or AppImage), or launch the generated AppImage directly. `.deb`
validation is an install-and-launch check on a Debian-family system. On Void
Linux, use the AppImage for the native launch because `xbps` does not install
Debian packages; the `.deb` can be inspected with `ar`/`tar` or tested on a
Debian-family machine.

## Dependency Policy

We are standardizing on a small set of cross-platform packages:

- `cross-env`
  - portable environment injection in package scripts
- `rimraf`
  - portable recursive cleanup in package scripts
- `cross-spawn`
  - shared subprocess launch for portability-sensitive runtime paths
- `open`
  - OS-specific file/URL opening behind a repo-local helper

We are explicitly not adopting:

- `shx`
  - we prefer small Node scripts for copy/create-directory logic
- generic path helper libraries
  - `node:path` is sufficient
- generic filesystem helper libraries
  - `fs/promises` is sufficient

### Native npm dependencies

The npm package keeps native add-ons as runtime dependencies instead of bundling
one platform-specific `.node` binary into bb's JavaScript artifacts. This lets
npm install the correct native artifacts on the target machine for packages such
as `better-sqlite3` and `@parcel/watcher`.

Known failure modes remain the normal native-addon ones:

- changing Node versions after install without reinstalling or rebuilding
- copying `node_modules` across operating systems, CPU architectures, or libc
  variants
- disabling package lifecycle scripts
- running on a platform where no prebuild exists and no local build toolchain is
  available

The recovery path after a Node/runtime change is to reinstall the package or
rebuild the native dependency, for example `npm rebuild better-sqlite3`.

## Setup Hook Policy

- The supported setup hook is POSIX `.bb-env-setup.sh`.
- The same shell-based hook contract is used across macOS, Linux, and WSL2.
- No parallel `.bb-env-setup.ts` product-path mechanism is supported.
- The `.worktreeinclude` copy step runs no shell. It works on every platform,
  including native Windows.

## Line Ending Policy

- The repository enforces LF checkout for supported text files via
  [.gitattributes](../.gitattributes).
- Supported Linux and WSL2 flows must work with those repository rules applied.
- Native Windows checkouts are outside the support contract unless we later
  choose to support a native Windows product path.

## CI And Validation

- GitHub Actions uses Ubuntu as the required support gate for build, typecheck,
  lint, test, and Linux `bb-app` package smoke coverage; this is not a Linux
  Electron desktop build.
- Full build, typecheck, lint, and test checks run on Ubuntu with Node.js 22
  only.
- Pull requests run the `bb-app` tarball smoke on Ubuntu and macOS with Node.js
  22, validating the packed npm artifact through `npx --package`.
- Pushes to `main` and manually dispatched CI runs also run the `bb-app` tarball
  smoke on Ubuntu and macOS with Node.js 24 and 26.
- Branch protection should require `Checks (ubuntu-latest, Node 22.x)`,
  `Package Smoke (ubuntu-latest, Node 22.x)`, and
  `Package Smoke (macos-latest, Node 22.x)`. The Node.js 24 and 26 compatibility
  smoke jobs do not run on pull requests and should not be configured as
  required PR checks.
- Native Windows CI is intentionally not required yet; the installer and
  platform contract are covered by Linux-side contract and route tests.
- The separate `Build Desktop` workflow runs a macOS arm64 job and an Ubuntu
  Linux x64 job. The macOS job verifies an arm64 runner and publishes the
  signed public desktop release when enabled; the Linux job packages and
  packaged-smoke-tests the x64 desktop artifacts as a workflow artifact. The
  nightly desktop job currently has the macOS arm64 limitation.
