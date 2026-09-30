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

### 1. COBOL `COPY` in the dependency scan

Find Dependencies and Find All Dependencies read COBOL members and report their copybooks. Today `src/dependencyScan.ts` scans only RPG, CL and DDS (`SCANNED_SOURCE_TYPES`), so a COBOL member returns no references.

- Add COBOL source types to the scan: `cblle`, `sqlcblle`, `cbl`, `sqlcbl`, the same COBOL types `PROGRAM_SOURCE_TYPES` in `src/dependencyResolve.ts` already knows.
- Copybooks have no fixed source type (shops use `CBLLE`, `CPY`, blank and others). So Find All Dependencies scans a copybook reached from a COBOL member as COBOL, whatever its type, the same way it scans an RPG copybook as RPG.
- Recognize `COPY name`, `COPY name OF|IN file`, and `COPY name OF|IN file OF|IN library` as copybook references. Without a file, `QCBLLESRC` is preferred, as the ILE COBOL compiler does. This mirrors `DEFAULT_COPY_FILE` (`QRPGLESRC`) for RPG. The search libraries still decide the library.
- Ignore comment lines (`*` or `/` in column 7) and text in the sequence and identification areas (columns 1–6 and 73–80).
- Treat `COPY DDS-…` / `COPY DD-…` (a record format taken from an externally described file) as a **file** reference to the named file, not as a copybook.
- Embedded SQL in `sqlcblle`/`sqlcbl` reports tables, views and `EXEC SQL INCLUDE` the same way it does for SQL RPG.

**Validation**
- `src/test/dependencyScan.test.ts` has cases for each `COPY` form, `OF` and `IN`, a commented-out `COPY`, a `COPY` in columns 73–80 (ignored), `COPY DDS-ALL-FORMATS OF file` (file reference), and embedded SQL in `sqlcblle`.
- A COBOL member's copybooks are resolved and offered by Find Dependencies, which is covered by a `dependencyResolve` test with a fake IBM i.
- The README "Where dependencies come from" section lists COBOL.

### 2. Configurable LMI checkout command

When the user picks **I Need to Change Some…** for reference copies (`src/commands/dependencies.ts`), the extension runs the shop's change-management checkout command on the IBM i for each selected member, then offers to check out the development-library copy. Today it only shows a guide and copies member paths to the clipboard.

- A new setting, `ibmi-member-workspace.changeManagement.checkoutCommand`, holds a CL command template. It is empty by default. The setting sends commands to the IBM i, so it must have `"scope": "application"`, which also means a cloned project can't set it.
- Placeholders use Code for IBM i's action variable names, which users already know: `&OPENLIB` (the reference copy's library), `&OPENSPF` (source file), `&OPENMBR` (member), `&EXT` (source type), and `&DEVLIB` (the development library, see below). Values are IBM i system names, so they are inserted uppercase and unquoted. A name that fails the extension's existing system-name check is refused, and the command isn't run. An unknown `&NAME` placeholder is an error in the template, not literal text.
- Development library: before running, the extension asks for it once per run in an input box pre-filled with the last one used in this workspace (kept in `workspaceState`). It fills `&DEVLIB` and is the library checked out from afterward. Source file and member names stay the same.
- Before running, the extension shows the exact expanded command for each member and asks for confirmation. Nothing runs without that confirmation.
- Each member's command runs through `src/codeForIBMi.ts`, the same way DSPPGMREF runs today. A failure for one member is reported with the IBM i message and doesn't stop the others. The extension refuses to run while a different IBM i is connected, as uploads already do.
- After the commands, it offers to check out the members whose command succeeded from `&DEVLIB` as editable checkouts. The reference copies stay as they are.
- When the setting is empty, the current guide is shown unchanged, with a line saying the setting can automate it.
- The README shows a template example. TODO: replace its placeholder command with your shop's actual Rocket LMI checkout command and parameters.

**Validation**
- Unit tests for the vscode-free template expansion: every placeholder, names containing `$ # @`, invalid IBM i names rejected, and an unknown placeholder rejected.
- Unit tests for the flow with the IBM i injected: confirmation declined runs nothing; one failure among several members is reported and the rest run; a different connected system is refused; an empty setting falls back to the guide.
- `manifest.test.ts` asserts the new setting is `"scope": "application"`, and the application-scope list in `CLAUDE.md` is updated.

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
