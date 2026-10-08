# Stack

## Overview

| | |
|---|---|
| Kind | VS Code extension, published as `vinhry.ibmi-member-workspace` (GPL-3.0) |
| Language | TypeScript `~6.0.3`, `strict`, ES2022, `module: Node16` (CommonJS output to `out/`) |
| Host | VS Code `^1.90.0` (`@types/vscode ~1.90.0`), also IBM Bob |
| Required extension | `halcyontechltd.code-for-ibmi` (types from `@halcyontech/vscode-ibmi-types`) |
| Runtime npm dependencies | None |
| Dev tools | ESLint 10 + `typescript-eslint`, `@vscode/vsce` 4.0.0 |
| Node | CI uses Node 24. The README asks for Node 22+ to build. |
| External tools | `git` 2.25+ for Local Change History (optional) |

## Commands

```sh
npm ci                  # install locked dependencies
npm run compile         # tsc -p ./ -> out/
npm run watch           # recompile on change; press F5 "VS Code Extension Development" to run
npm run lint            # eslint src
npm test                # compile, then node --test "out/test/**/*.test.js"
npm run package         # build ibmi-member-workspace-<version>.vsix
npm run package:list    # list files that would go into the VSIX
```

Run one test file or one test (tests run from compiled output):

```sh
npm run compile && node --test out/test/sync.test.js
npm run compile && node --test --test-name-pattern="ignores a leading BOM" out/test/sync.test.js
```

## Layout

- `src/extension.ts`: `activate` builds the services and passes a shared `CommandContext` (`src/commands/context.ts`) to each `register*Commands` in `src/commands/`.
- `src/codeForIBMi.ts`: the only bridge to Code for IBM i (connection, member download/upload, SQL, DSPPGMREF, where-used snapshots, file descriptions).
- `src/checkoutService.ts`: checkout logic and IBM i I/O; it delegates Local Change History (repository preparation, work items, moves, checkpoints) to the vscode-free `src/workItemHistory.ts`. `src/checkoutIndexStore.ts` loads and saves the index, `checkout-index.json` in the workspace's extension storage (`context.storageUri`).
- `src/sync.ts`: three-way hash comparison (`in-sync | modified | remote-changed | conflict`).
- `src/uploadFlow.ts`, `src/autoUpload.ts`, `src/commands/uploadMember.ts`: manual upload and upload on save share one flow.
- `src/dependencyScan.ts` → `src/dependencyResolve.ts` (providers in `src/dependencySources.ts`) → `src/dependencyWalk.ts`: Find Dependencies and Find All Dependencies.
- `src/changeManagement.ts`: the change-management (LMI) checkout command behind **I Need to Change Some…**.
- `src/gitService.ts`, `src/repositoryTrust.ts`: Local Change History over the `git` CLI.
- `src/bobIde.ts`, `src/bobMcpServer.ts`, `src/bobMcpTools.ts`, `src/bobPrompts.ts`: IBM Bob support.
- `src/test/*.test.ts`: unit tests, one file per vscode-free module, plus `manifest.test.ts`.
- `readme.md` is the user manual, and `CHANGELOG.md` holds user-facing release notes. `docs/specs.md` holds the per-feature specs, the Rocket LMI shop constraints and the release history.

## Conventions

- **Testability:** tests use `node:test` and `node:assert/strict` in plain Node, without the `vscode` module. Keep logic in vscode-free modules with IBM i and UI calls injected, and keep `vscode`-importing files thin. `import type` from a vscode module is fine.
- **Lint:** `@eslint/js` + `typescript-eslint` recommended, plus `curly: "error"` and `eqeqeq: ["error", "smart"]` (`eslint.config.mjs`).
- **Manifest invariants** (`src/test/manifest.test.ts`):
  - every `registerCommand` matches `contributes.commands` exactly, and vice versa;
  - commands and settings are namespaced `ibmi-member-workspace.`;
  - settings that send code to the IBM i or run queries have `"scope": "application"`;
  - `version` is asserted literally;
  - the VSIX contains only `package.json`, `readme.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `images/icon.png`, `resources/*.svg` and `out/**/*.js` (not `out/test`). Any new root file or folder goes in `.vscodeignore`, which is why `docs/**` is listed there.
- **Security:** never read or write through symlinks in checkout or `.bob` paths. Use `execFile`, not a shell. End Git options with `--` before user-supplied names. Git runs without hooks, signing or fsmonitor, with `GIT_TERMINAL_PROMPT=0`. Keep tokens out of cloned projects. `untrustedWorkspaces.supported: false`.
- **Cross-platform:** code must work on Windows (paths, command-line length, Git behavior). CI checks this.
- **Commits:** plain-English subjects that describe the user-visible effect.

## CI

`.github/workflows/ci.yml` runs on every push, pull request and manual dispatch, on `ubuntu-latest`, `windows-latest` and `macos-latest` with Node 24: `npm ci`, `npm run lint`, `npm test`. Actions are pinned to commits, and the token is read-only.

## Releases

- A `Release x.y.z` commit bumps `version` in `package.json`, `package-lock.json` and `src/test/manifest.test.ts`, and adds a dated `## x.y.z - YYYY-MM-DD` section at the top of `CHANGELOG.md`.
- Tags are `vX.Y.Z`. The VSIX is attached to GitHub Releases and published to the Marketplace.
- Releases are patch bumps (`x.y.z+1`) unless a minor bump is explicitly chosen.
