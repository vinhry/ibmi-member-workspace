# Specs

## Purpose

IBM i Member Workspace (`vinhry.ibmi-member-workspace`) is a VS Code extension that checks IBM i source members out to a local folder, tracks whether each one is in sync with the IBM i, and uploads or merges changes back. It connects through Code for IBM i. In IBM Bob it also offers read-only IBM i research tools over a local MCP server. The user manual is `readme.md`.

## Definition of done (applies to every requirement)

- New logic lives in a vscode-free module and has `node:test` unit tests. The `vscode`-importing code stays thin.
- `npm run lint` and `npm test` pass in CI on Ubuntu, Windows and macOS.
- Any new command or setting is in `contributes` in `package.json` and namespaced `ibmi-member-workspace.`, and `src/test/manifest.test.ts` passes.
- `CHANGELOG.md` has a user-facing entry, and `readme.md` is updated wherever behavior changes.
- No manual check against a real IBM i is required.

## Requirements

### 1. COBOL `COPY` in the dependency scan (shipped in 1.7.5)

Find Dependencies and Find All Dependencies read COBOL members (`cblle`, `sqlcblle`, `cbl`, `sqlcbl`) with `scanCobol` in `src/dependencyScan.ts`.

- Only the code area (columns 8–72) is read. Comment lines (`*` or `/` in column 7), floating `*>` comments, literals, and data names containing `COPY` (`WS-COPY-COUNT`) are ignored.
- `COPY name`, `COPY name OF|IN file`, `COPY name OF|IN lib/file`, and `COPY name OF|IN file OF|IN library` are copybooks. A statement may span lines up to its period. A quoted name with a `/` is an IFS path (unresolvable).
- A copybook without a source file carries `defaultSourceFile: "QCBLLESRC"`, which the resolver prefers, as it prefers `QRPGLESRC` for RPG. Other files are still searched.
- `COPY DDS-…`, `DDSR-…`, `DD-…`, `DDR-…` `OF file`, `lib/file` or `lib-file` (IBM i names can't contain `-`) is a **file** reference.
- `EXEC SQL … END-EXEC`: `INCLUDE` is a copybook (not `SQLCA`/`SQLDA`). Tables, views and `CALL` go through the same SQL scan as RPG.
- Find All Dependencies scans a copybook reached from a COBOL member as COBOL, whatever its own source type (`scanTypeOf` in `src/dependencyWalk.ts`).
- The ILE COBOL syntax wasn't checked against IBM's reference (their pages don't render through the fetch tool), so the parser accepts every qualification form above.

**Validation**
- `src/test/dependencyScan.test.ts` "scanReferences: COBOL": every `COPY` form, a split statement with `REPLACING`, comments, literals, data names, columns 73–80, `COPY DDS` forms, an IFS path, and embedded SQL.
- `src/test/dependencyResolve.test.ts`: a COBOL copybook prefers `QCBLLESRC`.
- `src/test/dependencyWalk.test.ts`: a `CPY` copybook of a COBOL member is scanned as COBOL.
- README source-scan table and Find All Dependencies.

### 2. Configurable LMI checkout command (shipped in 1.7.6)

**I Need to Change Some…** (in Find Dependencies' bring dialog, `src/commands/dependencies.ts`) runs the shop's change-management checkout command for each selected member, then offers to check out the development library's copies. Without a command, the guide is shown as before, with a pointer to the setting.

- Setting `ibmi-member-workspace.changeManagement.checkoutCommand`: a string, empty by default, `"scope": "application"`. It is read from user settings only.
- Placeholders are `&OPENLIB`, `&OPENSPF`, `&OPENMBR`, `&EXT` and `&DEVLIB`, filled uppercase and unquoted. Names must pass `memberNameProblem` (`src/types.ts`), and an unknown `&NAME` refuses the template (`src/changeManagement.ts`).
- The development library is asked each time, pre-filled from `workspaceState` (`changeManagement.lastDevLibrary`).
- The expanded commands are shown in a modal and run only on **Run**. They run through `runClCommand` (`src/codeForIBMi.ts`, `runCommand` with the ILE environment), and a failure carries the last job messages.
- A different connected system refuses the run before confirming, and each remaining member after it.
- **Check Out from DEVLIB** checks out `DEVLIB/<same file>(<same member>)` through `checkoutMembersBatch` as editable checkouts.
- TODO: your shop's actual Rocket LMI command and parameters. The README example uses a placeholder command.

**Validation**
- `src/test/changeManagement.test.ts`: every placeholder, case and repeats, names with `$#@`, invalid names, unknown placeholders, a declined confirmation or a missing library runs nothing, one failure among three, a system refusal before and during the run.
- `manifest.test.ts` asserts the setting is application-scoped.
- README "Running Your Change-Management Checkout".

### 3. Per-member upload on save, from the status bar (shipped in 1.7.4)

The existing **Auto-upload** status bar item shows the open member's mode whenever the active editor is an editable checked-out member, even while the `autoUploadOnSave` setting is `off`. Clicking it runs **Change Upload on Save for This Member** (`ibmi-member-workspace.changeMemberAutoUpload`), a quick pick with **Use Setting**, **Off**, **Ask**, **On**, and **Change the Setting for All Members…**. Elsewhere the item behaves as before (hidden while the setting is `off`).

- The choice is `uploadOnSave` on the checkout in the index (`src/types.ts`). It survives a re-download, is changed only through `CheckoutService.setUploadOnSave` on the stored checkout, and is never read from workspace files.
- `effectiveUploadMode` (`src/autoUpload.ts`) picks the member's choice over the setting. The scheduler resolves it per file when scheduling and again when uploading.
- In `ask` mode, **Always Upload** switches the member to **On** when it has its own choice, and the setting otherwise.
- Reference copies never upload. A remote change always prompts, even when the member uploads silently.

**Validation**
- `src/test/autoUpload.test.ts`: the member's choice wins both ways, a choice changed after the save applies, reference copies never upload, and **Always** updates the member or the setting.
- `src/test/checkoutIndexStore.test.ts`: the choice survives a save and load.
- README "Upload on Save → For One Member".

### 4. Extract the checkout index store from `checkoutService.ts` (shipped in 1.7.3)

Move checkout-index persistence out of `src/checkoutService.ts` (1,698 lines) into a vscode-free module with file access injected, so it can be unit-tested. User-visible behavior doesn't change.

The moved code keeps all of today's behavior (`loadIndex`, `saveIndex`, `persist`):
- `checkout-index.json` in the workspace's extension storage, written atomically (temp file, then rename) and one write at a time;
- migration of older index versions to version 3, with a `checkout-index.v<N>-backup.json` backup;
- an unreadable index is backed up to `checkout-index.corrupt-<timestamp>.json`, reset, and reported with a warning;
- during a batch, saves wait for the batch to end and change notifications are throttled (`BATCH_CHANGE_INTERVAL_MS`).

**Validation**
- New unit tests cover: missing index, valid v3 load, migration from an older version (backup written), corrupt index (backup written, empty index, warning raised), writes serialized in order, a failed write marks the index dirty, and batch deferral.
- All existing tests pass unchanged.
- `checkoutService.ts` no longer reads or writes the index file directly.
- `CLAUDE.md`'s list of vscode-free modules includes the new module.
- The HANDOFF.md status line no longer lists this as open.

### 5. Dependency search scope (shipped in 1.7.7)

Users reported that Find Dependencies, with no search libraries set, searched beyond their library list. `librariesToSearch` added every library a reference named: DSPPGMREF source locations, cross-reference rows, and qualified names in the source.

- Setting `ibmi-member-workspace.dependencies.searchScope`: `auto` (the default), `libraryList`, `specific` or `everywhere`, shown as **Automatic**, **Library List**, **Search Libraries** and **All User Libraries** (`enumItemLabels`). `auto` uses `specific` if `dependencies.searchLibraries` lists libraries, otherwise `libraryList`, as before (`searchScopeFrom` in `src/dependencyResolve.ts`).
- `libraryList` and `specific` never leave their libraries. `scopeReferences` drops an outside library from a reference (keeping its source file) so it is looked up by name inside the scope. Each skipped library is logged.
- `everywhere` searches every library except IBM's (`isIbmLibrary`: `Q…` and `#…` except `QGPL` and `QUSR…`), with the library list ranked first and the rest alphabetically. DSPPGMREF also looks in `*ALLUSR` for the compiled program.
- The Find Dependencies list has a title-bar button to rerun with another scope. The unresolved warning offers **Search All User Libraries**. Neither changes the setting.
- Bob's tools default to `searchScope().libraries`, which is the library list in `everywhere` mode. `find_member_dependencies` reports `searchScope`.

**Validation**
- `src/test/dependencyResolve.test.ts`: `searchScopeFrom`, `scopeReferences` (including resolving to the in-scope copy), `librariesToSearch`, outside ranking, `isIbmLibrary`.
- `src/test/dependencySources.test.ts`: DSPPGMREF tries `*ALLUSR` only for `everywhere`.

### 6. Checks before upload (shipped in 1.7.10)

Lines longer than the source file holds, and characters the member's CCSID can't store, used to be found only after an upload, through the read-back "IBM i copy differs" warning.

- `src/sourceCheck.ts` (vscode-free): `sourceProblems(content, layout)` reads the text as upload sends it (no BOM, CRLF or trailing blanks). A line is too long when its characters (code points, without trailing blanks) exceed `dataLength`. A character is flagged only for the Latin-1 EBCDIC CCSIDs (37, 273, 277, 278, 280, 284, 285, 297, 500, 871, 1047) above U+00FF, and for 1140–1149 the same with € allowed and ¤ not. Other CCSIDs check length only. `asciiReplacement` spells typographic characters in plain text.
- The layout (`SRCDTA` length and CCSID from `QSYS2.SYSCOLUMNS`, `sourceFileLayout` in `src/codeForIBMi.ts`) is stored on the checkout as `sourceLayout`: read at checkout, re-read at refresh, and read at upload when missing. Reads are cached per source file per connection; a failed read skips the checks.
- `CheckoutService.uploadToRemote` returns `"source-problems"` before its remote check, unless `ignoreSourceProblems`. `runUploadFlow` asks through `resolveSourceProblems` (a modal; for quiet automatic uploads a notification that isn't waited for) and uploads again with `ignoreSourceProblems` on **Upload Anyway**. Batch upload skips and counts those members; the service logs up to 10 problems each.
- `src/sourceDiagnostics.ts` shows the problems as warnings on editable checkouts and offers quick fixes that replace typographic characters.

**Validation**
- `src/test/sourceCheck.test.ts`: the length boundary, BOM/CRLF/trailing blanks, astral characters, CCSID 37 vs 1140 vs Unicode and unknown CCSIDs, replacements, messages, `layoutFromColumn`.
- `src/test/uploadFlow.test.ts`: problems ask first (also when quiet), Upload Anyway carries through a remote-change prompt, an upload already chosen anyway skips the check.
- `src/test/checkoutIndexStore.test.ts`: `sourceLayout` survives a save and load.
- README "Checks Before Uploading".

### 7. Quick refresh, background refresh and the view badge (shipped in 1.7.11)

Refresh downloaded every member's full source, one at a time, and changes made on the IBM i were only found by a refresh the user ran.

- `memberChangeStamps` (`src/codeForIBMi.ts`) reads `LAST_CHANGE_TIMESTAMP`, `LAST_SOURCE_UPDATE_TIMESTAMP`, `NUMBER_ROWS` and `DATA_SIZE` from `QSYS2.SYSPARTITIONSTAT`, 100 members per statement; `changeStamp` (`src/remoteStamps.ts`) joins them.
- A checkout's `remoteSeen` (`{ stamp, hash }`) is recorded by a full comparison that had a stamp, read before the download. Upload, Merge Back and Re-checkout clear it; a new checkout starts without it.
- `planRefresh` skips a member only when its current stamp equals `remoteSeen.stamp` and its baseline has `hashVersion: 2`; its status is then `classifyStatus(local, remoteSeen.hash, baseline)`. A member missing from the catalog, or a source file whose query fails, is compared in full.
- `CheckoutService.refreshEntries(..., { quick })`: Refresh All and the source-file Refresh are quick; single-member and selection refreshes, and the upload's own remote check, stay full.
- Settings `backgroundRefresh.onConnect` (boolean) and `backgroundRefresh.intervalMinutes` (0 = off, clamped to 5–240), both `"scope": "application"`. `src/commands/backgroundRefresh.ts` runs a quick refresh with window progress, skips while `isBusy()` or a run is going, and notifies about members that newly became conflicts.
- `treeView.badge` counts remote-changed and conflict members of the connected system (`remoteChangeBadge`).

**Validation**
- `src/test/remoteStamps.test.ts`: `changeStamp`, grouping, every `planRefresh` case, the interval clamp, `newlyChanged`, the badge.
- `src/test/checkoutIndexStore.test.ts`: `remoteSeen` survives a save and load.
- `manifest.test.ts`: both settings are application-scoped.
- README "Refresh Remote Status" and "Background Refresh".

### 8. Status badges in the Explorer (shipped in 1.7.12)

- `decorationFor(entry)` (`src/statusDecorations.ts`, vscode-free): `↑` modified, `↓` remote changed, `!` conflict, `RO` for any reference copy, nothing otherwise. Arrows, because Git decorates the same files with letters when Local Change History is on. Badges stay within VS Code's two-character limit.
- `CheckoutDecorations` (`src/checkoutDecorations.ts`) is a `FileDecorationProvider` for `file` URIs of checkouts, refired on every `service.onDidChange`.

**Validation**
- `src/test/statusDecorations.test.ts`: each status, reference copies, badge length.
- README "Status in the Explorer".
