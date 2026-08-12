# Repository Overview

This monorepo contains the packaged app plus the runtime services it bundles:

| Package or app                                                      | Role                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/bb-app`](../packages/bb-app)                             | Published npm package, `npx bb-app@latest` launcher, bundled `bb` CLI entry, and public SDK export.                                             |
| [`apps/desktop`](../apps/desktop)                                   | Cross-platform Electron shell that supervises the packaged runtime and loads the bb web UI; configured artifacts are macOS arm64 and Linux x64. |
| [`apps/app`](../apps/app)                                           | Web UI for inspecting projects, threads, environments, and running work.                                                                        |
| [`apps/server`](../apps/server)                                     | HTTP API, WebSocket notifications, state management, and server-owned product policy.                                                           |
| [`apps/host-daemon`](../apps/host-daemon)                           | Host-local runtime that provisions workspaces and runs provider processes.                                                                      |
| [`apps/cli`](../apps/cli)                                           | Scriptable `bb` CLI for users and agents.                                                                                                       |
| [`apps/web`](../apps/web)                                           | getbb.app site: marketing page + bb connect auth/dashboard (TanStack Start on Cloudflare Workers).                                              |
| [`packages/sdk`](../packages/sdk)                                   | TypeScript SDK used by the CLI, package SDK export, and programmatic clients.                                                                   |
| [`packages/agent-runtime`](../packages/agent-runtime)               | Provider runtime adapters and bridges for Codex, Claude Code, Pi, and ACP agents.                                                               |
| [`packages/config`](../packages/config)                             | Config parsing, defaults, managed package config schema, and environment variable definitions.                                                  |
| [`packages/db`](../packages/db)                                     | SQLite schema, migrations, and data access helpers.                                                                                             |
| [`packages/server-contract`](../packages/server-contract)           | HTTP and WebSocket contract between clients and the server.                                                                                     |
| [`packages/host-daemon-contract`](../packages/host-daemon-contract) | Command/event contract between the server and host daemons.                                                                                     |

`bb-app` also exposes a Node scripting SDK:
`import { BBSdk } from "bb-app"`. See
[`packages/bb-app`](../packages/bb-app/README.md#scripting-with-the-sdk).

## Runtime and desktop distribution

`bb-app` is the cross-platform runtime for supported macOS, Linux, and WSL2
flows. It starts the server and host daemon and serves the web UI, so Linux
users launch it with `npx bb-app@latest` and use a browser at
`http://localhost:38886` (or use `pnpm dev` from a source checkout).

`@bb/desktop` has two configured desktop targets: Apple Silicon arm64 macOS
`.dmg`/`.zip` installers and x64 Linux AppImage/`.deb` packages. There is no
`.rpm` target, and Linux arm64 is not an installer target. Local packaging
writes to `apps/desktop/release/` with these stable names:

- macOS: `bb-<version>-arm64.dmg` and `bb-<version>-arm64.zip`
- Linux: `bb-<version>-x86_64.AppImage` and `bb-<version>-amd64.deb`

Nightly builds use the `bb-nightly-<version>-` prefix with the same platform
suffixes. The native metadata names are `latest-mac.yml`/`nightly-mac.yml` on
macOS and `latest-linux.yml`/`nightly-linux.yml` on Linux. The generated
`desktop-version.json` feed reports the build platform and is derived from the
matching metadata.

Public stable desktop releases currently publish macOS arm64 assets only. The
manually dispatched Build Desktop workflow also packages and smoke-tests Linux
x64, uploading the AppImage, `.deb`, and matching feed as the
`bb-desktop-linux-x64` workflow artifact. Those Linux files are not yet public
release downloads, and the nightly desktop workflow remains macOS arm64 only.

See [platform support](platform-support.md) for the runtime/client boundary and
[the release process](bb-release-process.md) for artifact publication and feed
ownership.

## Pinned Dependencies

Some dependencies are pinned to an exact version for reasons that are not
visible from `package.json` alone.

| Dependency                     | Where                  | Why                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opentelemetry/api` (`1.9.1`) | `apps/server`          | Pi AI and Drizzle each pull in `@opentelemetry/api`. Without an exact direct pin, pnpm can resolve two copies and TypeScript sees two distinct type identities, which fails the server typecheck. Bump both consumers together, not this pin alone. |
| Pi packages (`0.84.0`)         | Pi bridge and `bb-app` | Pi extensions import the host's Pi modules. The packaged bridge keeps this exact package tree on disk so extensions share one compatible runtime. Bump the Pi packages together.                                                                    |
