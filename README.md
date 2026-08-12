<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# bb

Fork version of bb, expanded.
- web first
- (wip) windows & linux desktop support version
- some patches on multi remote host plugin (github)
- modified composer based from beam ui component
- (wip) expand browser ability on web and desktop version

<p align="center">
  <img width="987" height="1096" alt="image" src="https://github.com/user-attachments/assets/4de165fa-fea2-479a-a0d0-5382622f8ce4" />
</p>

## Troubleshooting

### `Could not locate the bindings file`

bb uses native add-ons, for example `better-sqlite3` and `@parcel/watcher`. npm
downloads or builds those binaries in a package install script. If npm does not
run install scripts, the binaries are absent. bb then stops at startup with this
error:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

The usual cause is `ignore-scripts=true` in your `~/.npmrc`. Set the
`npm_config_ignore_scripts` environment variable to let this one command run its
install scripts:

```bash
npm_config_ignore_scripts=false npx bb-app@latest
```

For a permanent install with the same setting, use:

```bash
npm_config_ignore_scripts=false npm install -g bb-app
bb-app
```

The environment variable applies to that one command only. Keep
`ignore-scripts=true` in your `~/.npmrc` if you want it for security.

The same error has other causes. A Node.js major-version change after the
install causes it. A copy of `node_modules` from a different operating system,
CPU architecture, or libc variant also causes it. To recover, install the
package again, or run `npm rebuild better-sqlite3`.
