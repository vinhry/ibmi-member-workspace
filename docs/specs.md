# Specs

## Purpose

IBM i Member Workspace (`vinhry.ibmi-member-workspace`) is a VS Code extension that checks IBM i source members out to a local folder, tracks whether each one is in sync with the IBM i, and uploads or merges changes back. It connects through Code for IBM i. In IBM Bob it also offers read-only IBM i research tools over a local MCP server. The user manual is `readme.md`.

## Definition of done (applies to every requirement)

- New logic lives in a vscode-free module and has `node:test` unit tests. The `vscode`-importing code stays thin.
- `npm run lint` and `npm test` pass in CI on Ubuntu, Windows and macOS.
- Any new command or setting is in `contributes` in `package.json` and namespaced `ibmi-member-workspace.`, and `src/test/manifest.test.ts` passes.
- `CHANGELOG.md` has a user-facing entry, and `readme.md` is updated wherever behavior changes.
- No manual check against a real IBM i is required.

## Shop constraints (Rocket LMI)

Environment reality:
- Production objects reference production objects.
- Rocket LMI checkout brings ONLY the one object the developer named into the dev
  library. It does NOT pull referenced/related objects. (This is the gap the
  dependency feature fills — LMI won't do it.)
- Therefore discovered dependencies (B, C, D…) usually exist ONLY in production;
  the dev library has just the checked-out object.

### Two modes per discovered dependency (REQUIRED — do not collapse into one)
1. **Bring for reference** (expected to be the common case):
   - Read-only local pull, straight from production. No LMI involvement.
   - Clearly marked read-only so it is NEVER merged/uploaded back.
   - Use for copybooks and called programs you only need to READ to understand A.
2. **Check out for change**:
   - Must hand off to LMI's real checkout process, NOT write to the dev library
     directly. Otherwise the change-management record would not reflect what
     actually changed (an edited B outside LMI = change tracking lying).

### DSPPGMREF in this context
- Run it against the PRODUCTION object to discover the graph (dev lib has only the
  one object). References may resolve against production libs / compile-time *LIBL,
  so treat resolved libraries as discovery hints, then decide per node:
  reference-only pull vs LMI checkout.
- Still complementary with source parsing: DSPPGMREF misses `/COPY` copybooks
  (expanded at compile, no object ref); source parsing misses dynamic calls.
  Keep both; keep a permanent "source not found" unresolved list.

### Net design principle
LMI stays the source of truth for what is being CHANGED. The extension adds the
local dependency picture LMI doesn't provide — defaulting to read-only reference
copies, and delegating any actual change-checkout back to LMI.

These constraints are why reference copies are read-only and never uploaded (`assertEditable`), and why changes go through the change-management checkout and check-in commands (sections 2, 10 and 12).

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
- Since 1.8.0: `&RELEASE` is asked after the project, only when used, pre-filled from `changeManagement.release` (application scope, read from user settings), validated by `releaseProblem` (one to three IBM i names joined by `/`). A release that differs from the setting is offered as the new default (**Make Default** writes the user setting).
- Since 1.7.14: `&PROJECT` is asked after the development library, only when the template uses it, pre-filled from `workspaceState` (`changeManagement.lastProject`, saved on Run). `&USER` is the connection's `currentUser`. Both must be IBM i names (`nameValueProblem`); a template using `&USER` with no known user is refused. The shop's command is Rocket LMI's `ACMSLIB/ACMSCHKOUT OBJ((&OPENSPF (&OPENMBR))) PROJECT(&PROJECT) DVP(&USER) REL(group/app/release)`, called directly rather than through a wrapper program, whose `MONMSG CMS9913` would hide a failure.

**Validation**
- `src/test/changeManagement.test.ts`: the ACMSCHKOUT example expands exactly; &PROJECT asked only when used and cancelling runs nothing; invalid project or user refused; every placeholder, case and repeats, names with `$#@`, invalid names, unknown placeholders, a declined confirmation or a missing library runs nothing, one failure among three, a system refusal before and during the run.
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
- HANDOFF.md (since removed) no longer listed this as open.

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

### 9. Research tools and Investigate for Claude Code, Codex and GitHub Copilot (shipped in 1.7.13)

In VS Code, the agents of Claude Code (`anthropic.claude-code`), Codex (`openai.chatgpt`) and GitHub Copilot (`github.copilot-chat`, with VS Code's MCP API) get what Bob's agent gets in Bob. Bob's behavior doesn't change.

- Shared pieces: `src/agentFiles.ts` (moved from `bobIde.ts`: link-safe reads and writes, `.git/info/exclude`, rules-file updates, now also after YAML frontmatter, and the generic `mcpServers` JSON merge), `src/commands/researchServer.ts` (token, port, start and stop, tools; key prefix `bob` or `agents`), `src/commands/chatPaste.ts` (Bob's clipboard paste, for any webview chat), `src/commands/investigate.ts` (selections and the Explorer context key), and `buildInvestigatePrompt` with a mention style.
- `src/agentConfig.ts` (vscode-free): agent detection; Claude's `.mcp.json` entry (`type: "http"`), `.claude/settings.local.json` (`permissions.allow` gets `mcp__ibmi-member-workspace`, `enabledMcpjsonServers` gets the server; both checked against Claude Code's settings schema) and `claude mcp add --scope local` command; Codex's `[mcp_servers.ibmi-member-workspace]` table (`http_headers`, `default_tools_approval_mode = "approve"`), merged by headers outside multi-line strings, keeping the user's `enabled`/timeouts/tool lists and refusing inline or dotted definitions; mention styles (`@path`, `#file:path`, plain path); the prompt link's query (Claude Code reads it with `URLSearchParams`).
- `src/commands/agents.ts`: connections per agent and folder in `workspaceState`; the server starts only once one exists. Connect refuses to put the token in a committed `.mcp.json` or `.codex/config.toml` (`GitService.isTracked`, run with the safe Git options). Copilot's server is offered by `vscode.lm.registerMcpServerDefinitionProvider` (found at run time; `engines` stays `^1.90.0`) under `contributes.mcpServerDefinitionProviders` id `ibmi-member-workspace.researchTools`, only while connected. VS Code's MCP client (checked in 1.139) sends no `Origin` header and accepts the 405 for its GET stream.
- Investigate with AI: Claude Code through `<scheme>://anthropic.claude-code/open?prompt=`, Copilot through `workbench.action.chat.open` with `isPartialQuery`, Codex by pasting into `chatgpt.sidebarSecondaryView` or `chatgpt.sidebarView`.
- Settings `agents.researchTools` (application scope) and `agents.whereUsedMaxLibraries`; the tools name the host's setting (`ResearchIo.whereUsedSetting`).
- Since 1.8.0 also in IBM Bob: `registerAgentCommands(ctx, { inBob: true })` runs after `registerBobCommands`, without Copilot (no MCP provider) and without a second `trackCheckoutPaths`. Agent views and menus are gated by `ibmi-member-workspace:agentAvailable` only. Bob's server (key prefix `bob`) and the agents' (`agents`) stay separate.

**Validation**
- `src/test/agentConfig.test.ts`: detection, rules texts, the Claude files and command, the prompt query round trip, every Codex merge case, status summaries.
- `src/test/agentFiles.test.ts`: the moved helpers, the frontmatter marker, the JSON merge.
- `src/test/bobPrompts.test.ts`, `src/test/bobMcpTools.test.ts`, `src/test/manifest.test.ts`: mention styles, the setting the tools name, the view, welcome content, provider id and application scope. Bob's tests pass unchanged.
- README "Using with Claude Code, Codex and GitHub Copilot".

### 10. Find Member and Check Out Through Change Management (shipped in 1.8.0)

Users found a program on the IBM i, checked it out with LMI, then found the development copy in the Object Browser. Now it all starts in VS Code or Bob.

- The **Find Member** panel (`findMemberView`, below Checked Out Members; `src/findMemberView.ts`, `src/commands/findMember.ts`) keeps the last search's results (actions on a multi-selection: `checkoutThroughChangeManagement`, `findMember.bringForReference`, `findMember.checkoutForChange`) and the last 20 searches in `workspaceState` (`findMember.history`, `addToHistory`). Clicking a result opens it read-only (`member:` URI, `readonly=true`); with no results it offers member-text and all-user-libraries searches.
- `ibmi-member-workspace.findMember` (panel title bar, Command Palette): a name or pattern (`memberPatternProblem`, `src/memberSearch.ts`), searched with `searchSourceMembers` in `searchScope(ctx)`'s libraries (all user libraries when the scope is everywhere). A name without wildcards also finds its program (`findCompiledObject`) and the member it was compiled from (`objectSources`). Nothing found offers member-text search and All User Libraries. Results are ordered by `orderFound` (exact name, scope order, name) and shown in the panel; **Search in Other Libraries…** reruns the search through `pickSearchScope`.
- `ibmi-member-workspace.checkoutThroughChangeManagement` on Object Browser members (any `member*` item, protected filters too) and Checked Out Members items.

**Validation**
- `src/test/memberSearch.test.ts`: pattern checks, normalizing, ordering and dedupe.
- `manifest.test.ts`: commands match their registrations.
- README "Running Your Change-Management Checkout".

### 11. Checkouts can't hang (shipped in 1.8.0)

A checkout could wait forever on an IBM i request that never answered; Code for IBM i rejects pending requests only when the connection closes, and Cancel was only checked between members.

- `withDeadline` (`src/deadline.ts`, vscode-free): settles like the promise, or rejects with `TimedOutError` after `ms`, or with the caller's error when the signal aborts; reports a slow wait once; clears its timers.
- `CheckoutService.download`: every download (checkout, refresh, re-checkout, the upload's remote check and read-back) gives up after 2 minutes; a wait over 10 seconds is logged. The source layout lookup gives up after 15 seconds (checks skipped, not fatal). The upload write itself has no limit.
- `CheckoutOptions.signal`: the batch checkout aborts it from Cancel, so the member being waited for stops too and nothing is written. A single checkout of a member not yet checked out runs in a cancellable progress.
- `runClCommand` stops waiting after 5 minutes, with a hint about jobs in MSGW.

**Validation**
- `src/test/deadline.test.ts`: in time, rejected, timed out, cancelled before and during, slow reported once, no timer left.

### 12. Check In Through Change Management (shipped in 1.8.3)

The checkout command (section 2) started a change in VS Code; finishing it still needed a 5250 session for the check-in.

- `ibmi-member-workspace.changeManagement.checkinCommand` (user settings only, `scope: application`, in `manifest.test.ts`'s list) is the check-in CL command. It takes the same eight placeholders, read for a checkout: `&DEVLIB` = `entry.library`, `&OPENSPF`/`&OPENMBR`/`&EXT` = the checkout's names, `&OPENLIB` = the library it was checked out from, `&PROJECT`/`&RELEASE` suggested from the checkout, `&USER` = the connection's user.
- `CheckedOutMember.changeManagement` (`ChangeManagementOrigin`: `openLibrary`, `project?`, `release?`, `checkedOutAt`) is set by **Check Out from DEVLIB** after a change-management checkout (`CheckoutOptions.changeManagement`, passed through `checkoutMembersBatch`), kept across a re-download, never set on reference copies. Optional, so no index migration.
- `src/changeManagement.ts` (vscode-free): `commandTemplateProblem(template, verb)` names the command in its messages; `expandCheckinCommand`, `checkinMemberOf`, `checkinRefusal` (reference copies, `modified`/`conflict`), `runChangeManagementCheckin` (asks `&OPENLIB` once only when used and unknown, suggests project and release from the first member that recorded them, one answer for all; shared `runCommands` loop with the checkout).
- `src/commands/changeManagement.ts` (vscode; the checkout flow moved here from `dependencies.ts`): `checkInThroughChangeManagement` also refuses members `service.hasLocalChanges` finds changed (unsaved edits included), lists refused members with an **Upload to IBM i** button, runs the commands after a modal listing them, offers **Make Default** for another release, then **Discard Checkout** (`service.discardEntries`, no second modal) or **Keep**. `checkinCommandConfigured()` gates the **Check In…** button `offerCheckin` (`commands/uploadMember.ts`) adds to the single and all-succeeded multi-upload messages.
- Command `ibmi-member-workspace.checkinThroughChangeManagement` on Checked Out Members items only (`viewItem =~ /^checkout/`, group `0_bob@5`); not in the Command Palette.

**Validation**
- `src/test/changeManagement.test.ts`: `expandCheckinCommand` (LMI's `ACMSCHKIN` exactly, `&DEVLIB`/`&OPENLIB` meanings, refusals, check-in wording), `checkinMemberOf`, `checkinRefusal`, `runChangeManagementCheckin` (suggestions, open library asked only when needed, cancels, bad template, failed member, system changes), the checkout result's `project`.
- `src/test/checkoutIndexStore.test.ts`: the origin survives save and load.
- `manifest.test.ts`: the new setting is application-scoped; the command is contributed.
- README "Running Your Change-Management Check-In"; the Settings table lists the change-management settings.

### 13. Members deleted on the IBM i (shipped in 1.8.4)

A checked-out member deleted, renamed or moved on the IBM i failed every refresh with a raw error and kept its stale status.

- `CheckoutStatus` and `RemoteStatus` gain `"remote-missing"`; `RefreshTally.remoteMissing`. The local file and baseline are never touched. No index migration (an older version reading the status hits its `default` branches).
- Detection by the catalog, never by the download's error text: quick refresh's `planRefresh` (`remoteStamps.ts`) returns `missing` for members the catalog no longer lists while it answered (an unreadable catalog still downloads everything). Every single-member download (`refreshRemoteStatus`, the upload's remote check, `recheckoutNow`) goes through `CheckoutService.downloadForEntry`: on a failure that is neither a timeout nor a cancel, `memberChangeStamps` for that one member decides; gone → `markRemoteMissing` (status, `lastCheckedAt`, `remoteSeen` dropped so a member that comes back is compared in full) and `RemoteMemberMissingError` (`errors.ts`); otherwise the original error, so a dropped connection stays an error.
- UI: tree description "deleted on IBM i", `circle-slash` icon, tooltip line; Explorer badge `✕` (`statusDecorations.ts`, `gitDecoration.deletedResourceForeground`); the view badge and `newlyChanged` count it. `commands/remoteMissing.ts` `reportRemoteMissing` (one or several members, **Remove from Checkouts** = `forgetEntries`, or **Keep**) is used by single Refresh, upload (`notifyFailed`), background refresh and the multi-upload summary counts them. Upload on save skips them with a log line. Upload, Merge Back, Run Action, Commit Now and Check In are hidden by `viewItem =~ /^checkout-(?!remote-missing)/`.

**Validation**
- `src/test/remoteStamps.test.ts`: the plan's `missing` list vs. an unreadable catalog, `newlyChanged`, the badge.
- `src/test/sync.test.ts`, `statusDecorations.test.ts`, `autoUpload.test.ts`: the status survives local saves, has a one-character badge, and is never uploaded on save.
- README "Refresh Remote Status" and the badge table.

### 14. Several downloads at once (shipped in 1.8.5)

Check Out All Members downloaded one member after another; a source file of a few hundred members took minutes.

- `src/concurrency.ts` (vscode-free): `mapWithLimit(items, limit, fn, { signal, cancelled, onSettled })`, `Promise.allSettled` with a limit: results in the items' order, one failure never stops the others, nothing starts after the signal aborts (those items are rejected with `cancelled()`). `DOWNLOAD_CONCURRENCY = 4`: Code for IBM i opens a channel per download on the one SSH connection, and four stays well under the usual `MaxSessions 10`.
- `checkoutMembersBatch` (`commands/checkout.ts`) runs the checkouts through it, with `onSettled` driving the progress (done/total) and the tally of succeeded, cancelled and failed members read from the settled results afterwards. The already-checked-out lookup is one `Map` by checkout id instead of a scan per member. The checkpoint and the messages are unchanged.
- `CheckoutService.checkoutMemberNow` always looks the entry up again by id before recording it, so two checkouts of one member can't record it twice. `ensureGitReady` already shares one preparation (`gitPreparations`), `lookupSourceLayout` one promise per source file, and `persist()` is deferred in a batch.
- `bringReferenceCopies` (`referenceCopies.ts`) takes `{ limit }` (default `DOWNLOAD_CONCURRENCY`); members not started when the signal aborts are reported as cancelled. The dependency walk still reads members one at a time: each level depends on the previous.

**Validation**
- `src/test/concurrency.test.ts`: at most `limit` in flight, results in order, one rejection, abort, limit 1, empty list.
- `src/test/bobMcpTools.test.ts`: the abort case with `limit: 1`; several at once keep the members' order.
- To verify on a real system: Check Out All on a 200+ member file, no duplicate entries in `checkout-index.json`, Cancel mid-way leaves one checkpoint; if the SSH server refuses channels, lower `DOWNLOAD_CONCURRENCY`.

### 15. Four more research tools (shipped in 1.8.6)

Agents could see relationships and source, but not a program's attributes, why a command failed, what a file's data looks like, or what the user changed in a checkout.

- `compare_checkout` (read-only): for a member in the checkout folder, `classifyStatus` of local/IBM i/baseline hashes and a unified diff from `src/lineDiff.ts` (vscode-free, no dependency: Myers O(ND) after trimming the common ends; past `maxEdits` differing lines the middle is one replacement and `truncated` says so; texts go through `canonicalMemberText`). Needs `ResearchIo.downloadMember`, wired with `withDeadline` (2 minutes) and a system check.
- `describe_object`: `describeObject` (`codeForIBMi.ts`) reads `OBJECT_STATISTICS` for the first match, then `PROGRAM_INFO`, `BOUND_MODULE_INFO` and `BOUND_SRVPGM_INFO` with `SELECT *` and tolerant column lookup (`pickColumns`), each failure a note, so older releases still answer.
- `read_job_log`: `jobLogMessages`, `JOBLOG_INFO('*')` (the SQL job, which CL commands also run in) or a job validated as number/user/name and inlined; newest N by `ORDINAL_POSITION DESC`, returned oldest first. `jobLogSince` (the 1.8.0 LMI fix) is unchanged.
- `sample_file_data`: `sampleFileRows` resolves the file through the `findTable` helper now shared with `describeFile`; `SELECT * … FETCH FIRST n ROWS ONLY` on `"LIB"."FILE"`, or through `CREATE OR REPLACE ALIAS QTEMP.IMWSAMPLE` inside `exclusive()` for a named member; values as text cut at 200 characters. Gated by `ibmi-member-workspace.researchTools.allowDataSamples` (boolean, default false, application scope, in `manifest.test.ts`'s list): the tool stays listed (Bob's cached tool list is stable) and names the setting when refused.
- `RULES_BODY` names the four tools; the previous text is frozen as `RULES_1_7_13` in `commands/bob.ts` so connected folders are upgraded. The deep-dive prompt mentions `describe_object` and `compare_checkout`.

**Validation**
- `src/test/lineDiff.test.ts`: identical as the IBM i stores it, insert, delete, replace, both ends, merged hunks, short edit scripts, the `maxEdits` fallback in under 2 seconds, empty text.
- `src/test/bobMcpTools.test.ts`: the tool list, each tool's happy path and refusals, the data-sample gate naming the setting.
- `src/test/bobPrompts.test.ts`, `manifest.test.ts`.
- On a real system: `describe_object` on an ILE program with bound service programs and on an OPM program; `read_job_log` default and with a WRKACTJOB job name; `sample_file_data` off, on, with a member, on an empty file; `compare_checkout` on in-sync and modified members.

### 16. Work items in their own module (shipped in 1.8.7)

`checkoutService.ts` mixed Local Change History with checkout logic and IBM i I/O, so none of the work-item logic could be tested. Same approach as the 1.7.3 index store: no behavior change.

- `src/workItemHistory.ts` (vscode-free): `WorkItemHistory` holds what was in the service: `ensureGitReady` (one preparation shared by concurrent calls, reused through a batch until `endBatch`), repository preparation with the author prompt and the consent for a repository the extension didn't create (remembered per session, trusted through `RepositoryTrust`), `synchronizeWorkItem`, `activateWorkItem`, `startWorkItem`, `moveEntries` (commit on the target before removing from the source, roll back on failure), `saveCheckpoint`/`saveBatchCheckpoint`, `logGitFailure` (warns once), `assertEntryInActiveWorkItem`, legacy-layout migration and archive, `needsWorkItemChoice`/`confirmWorkItem`, and `pathIsInside`.
- Its ports: `HistoryGit` (a `Pick` of `GitService`), `HistoryFiles` (exists/read/write/remove/setReadOnly), `HistoryUi` (author prompt, repository consent, warning), the trust list, and callbacks into the index (`ensureSystemState`, `activeEntries`, `persist`…). Paths are file-system strings; the service converts from `vscode.Uri`.
- `CheckoutService` keeps its public API as one-line delegates, so `commands/git.ts`, `extension.ts`, `commands/checkout.ts` and `commands/sync.ts` are untouched. It still owns `getGitRoot` (a `Uri`), the setting and workspaceState reads (`gitIntegrationState`, `confirmGitIntegration`, `trustRepositoriesInUse`) and the checkpoint `checkoutMemberNow` saves.

**Validation**
- `src/test/workItemHistory.test.ts`: first preparation trusts the new repository and adopts its branch; author asked once, a cancel remembered; foreign repository only with consent, asked once per session, again after a reset; one preparation per batch; Git off or missing warns once; checkpoint paths stay in the system's repository; batch checkpoints; activate/start; the once-per-session work-item choice; moves in order, rolled back, refused; legacy migration.
- Every existing test passes unchanged.

### 17. More CL and fixed-form RPG, testable views, grouped settings (shipped in 1.8.8)

- `scanCl` (`dependencyScan.ts`): `DCLF` (positional or `FILE()`) gives a `file`; `RUNSQLSTM SRCFILE() SRCMBR()` gives a `copybook` with its library and source file (the resolver's `typeMatches` accepts any source type for a copybook, so no new kind); a command quoted in `CMD('…')` or `RQSDTA('…')` is unquoted (`''` → `'`) and scanned for `CALL`/`TFRCTL` before quoted text is blanked (`scanClCalls`). Variables, `*SAME`-style values and `SRCSTMF` are skipped.
- `scanRpg`: fixed-form C-specs with `CALL` or `CALLB` (extenders dropped) and a quoted factor 2, in RPG IV columns (operation 26-35, factor 2 36-49) or RPG III columns (28-32, 33-42) (`fixedFormCall`). A target in a field or named constant is skipped.
- `checkoutTreeModel.ts` and `findMemberModel.ts` (vscode-free) hold what Checked Out Members and Find Member show; the providers only build tree items. Dates are formatted by the caller. `findMemberView.ts` re-exports the moved types and `foundMembersOf`.
- README Settings: one table per group (checkout and sync, uploads, dependencies, change management, AI agents and IBM Bob, Local Change History).
- HANDOFF.md and git-integration-plan.md were removed; their lasting content is in this file (Shop constraints, History).

**Validation**
- `src/test/dependencyScan.test.ts`: DCLF, RUNSQLSTM, quoted SBMJOB/ADDJOBSCDE/RQSDTA (not messages), fixed-form CALL/CALLB in both layouts, skipped cases. `dependencyResolve.test.ts`: a RUNSQLSTM script resolves by its source file.
- `src/test/checkoutTreeModel.test.ts`, `findMemberModel.test.ts`.

### 18. Member commands from the editor, the Explorer, the palette and the keyboard (shipped in 1.8.9)

- `resolveMember` / `resolveMemberSelections` (`prompts.ts`) accept a Checked Out Members item, a `vscode.Uri` (editor title, editor or Explorer menu, multi-selection of files) or nothing (Command Palette, keybinding: the active editor's file, via `activeCheckout`). The handlers are unchanged.
- Context keys: `ibmi-member-workspace:checkoutPaths` (existing) and the new `ibmi-member-workspace:editableCheckoutPaths` (not a reference copy, not `remote-missing`), both arrays of local fsPaths kept by `trackCheckoutPaths` (`commands/investigate.ts`), tested by menus with `resourcePath in`; `ibmi-member-workspace:checkoutActive` and the existing `editableCheckoutActive` (the active editor's file) kept by the upload-on-save status bar (`commands/autoUpload.ts`), used by the palette and the keybindings.
- Manifest: `editor/title` (Upload, Merge Back: editable; Refresh: any), the `ibmi-member-workspace.member` submenu ("IBM i Member") in `editor/context` and `explorer/context`, with `ibmi-member-workspace.editorCompareWith` (Compare With minus "Compare with Active File"); the Investigate submenus in `editor/context`; palette `when` clauses on the two active-editor keys; keybindings Ctrl/Cmd+Alt+U/M/R/K. Ctrl+Alt+I was avoided (Copilot Chat); Ctrl+Alt+U/M/R/K are not AltGr characters in the common European layouts.
- Writers (Upload, Merge Back, Run Action, Check In) always use the editable key; Discard Checkout, Open Local File and Compare with Active File stay out of the palette.

**Validation**
- `src/test/manifest.test.ts`: "offers the member commands from the editor, the Explorer, the Command Palette and the keyboard" (title buttons and order, submenu placement and gating per command, compare submenu, palette gating, keybindings with Mac variants and unique keys, every named command exists); Investigate placements include `editor/context`.
- Manual (Extension Development Host): title buttons and menu on a checkout and on a reference copy; palette entries appear and disappear with the active editor; the four shortcuts; Upload from the Explorer on a multi-selection.

### 19. Three-way Merge Back, Compare with IBM i, Show Changes Since Checkout (shipped in 1.8.10)

- `baselineStore.ts` (vscode-free): the text behind `remoteHashAtCheckout`, content-addressed as `baselines/<sha256>` under `context.storageUri`, written through a temporary file renamed over the name, never thrown (a checkout or upload must not fail over its baseline). `ensure(hash, candidates)` keeps whichever live text (remote or local) hashes to a baseline recorded before 1.8.10; `prune(keep)` drops files no checkout in the index refers to (`referencedBaselineHashes`), at `initialize` and after `forgetEntries` (which Discard goes through). `CheckoutService.setBaseline` takes the text; checkout, re-checkout, upload read-back (or the local text when the read-back failed), `adoptNextBaseline` and `upgradeBaseline` pass it; refresh and the upload pre-check call `ensure`.
- `mergePreparation.ts` (vscode-free): `planMerge` (in-sync, remote-unchanged → Upload, local-unchanged → Re-checkout, three-way, two-way when the baseline text is missing or damaged), `baselineAfterMergeSave` (the IBM i's text becomes the baseline once the saved result differs from the local snapshot), `mergeSnapshotPaths` (`merge/<system>/<LIB>/<FILE>/<MEMBER>/{base,ibmi,local}.<EXT>`), `mergeEditorArguments` (the argument of VS Code's `_open.mergeEditor`: `{ base, input1: { uri, title, description }, input2, output }`, verified against VS Code 1.90), `selectMergeCandidates`.
- `mergeHandler.ts`: `openMergeEditor` reads the IBM i (with Cancel), the local copy and the baseline, writes the three snapshots under the extension storage (`assertNoLinkBelow`), opens the merge editor with the local file as the output and runs `mergeEditor.resetResultToBaseAndAutoMerge` (the result otherwise starts as the output file's text). Inputs are snapshots, never the live file or the `member:` URI, which would share the output's text model. `onDidSaveLocal` (from the save listener, before upload on save) calls `CheckoutService.adoptMergeBaseline` once per merge; `hasOpenMerge`/`openMergeCount` count merges not yet saved (upload on save skips them, work items can't change). A merge ends when its tab closes (`TabInputTextMerge` is a proposed API in 1.90, so the input is recognised by its `base`/`result` fields) or its result document closes; its snapshots are deleted, and `merge/` is swept at start unless a restored merge editor still shows it. `compareWithRemote` and `showChangesSinceCheckout` are `vscode.diff` with the snapshot on the left and the local file on the right.
- Removed: `pendingMergeBacks`, `mergeDocumentKey`, `CheckoutService.recordMergeBack` and the `member:` save branch that wrote the diff's remote side to the IBM i past the source checks. `refreshAfterRemoteSave` stays for Open Remote File. `uploadFlow` gained `openCompare` for the altered-upload warning.
- Manifest: `compareWithRemote` and `showChangesSinceCheckout` in the tree (`3_compare`), the editor submenu, the palette (`checkoutActive`); Merge Back no longer needs `!listMultiSelection`.

**Validation**
- `src/test/baselineStore.test.ts` (file names, write once through a temporary file, refusals logged not thrown, damaged reads, ensure from the matching candidate, prune leaves temporary files), `src/test/mergePreparation.test.ts` (every plan branch incl. line endings and a damaged baseline, baseline after save, snapshot paths, editor arguments, candidates), `uploadFlow.test.ts` (`openCompare`), `manifest.test.ts`.
- Manual (Extension Development Host, PUB400): conflict with non-overlapping and overlapping changes, a pre-1.8.10 checkout (two-way, healed by Refresh), a multi-selection with a reference copy, closing the merge without saving, upload on save after a merge save.

### 20. Research on IBM i for people, sql_query and read_spool_file (shipped in 1.8.11)

- `commands/research.ts`: commands `research.findWhereUsed`, `describeFile`, `describeObject`, `serviceProgramExports`, `jobLog`, on a Checked Out Members item, a file (editor, Explorer), a Find Member result (`foundMembersOf`) or an Object Browser member (`memberInfoOf`), or with no argument an input box suggesting the active checkout's member. The member name is the object name; libraries are `searchLibraries()`; where-used caps at `MAX_WHERE_USED_LIBRARIES`, skips `SYSTEM_LIBRARIES`, runs under a cancellable progress, and offers the programs found in a quick pick whose source (`findCompiledObject` → `objectSources` → `searchSourceMembers`) is brought with `bringReferenceCopiesFor`. Results are documents of the `ibmi-research:` scheme (a `TextDocumentContentProvider`, one text per opened document, dropped when it closes).
- `researchReport.ts` (vscode-free): `textTable` (aligned columns, 60 characters at most) and the reports for where-used (usage bits in words), file descriptions, object descriptions, service program exports and job logs; `objectTypeForSourceType` narrows a where-used search to `*FILE` for DDS and SQL object members.
- `sqlGuard.ts` (vscode-free): `blankSql` (comments and literals blanked, upper-cased, an unclosed comment kept as a marker), `guardReadOnlyQuery` (one statement; first word SELECT, WITH or VALUES; forbidden words incl. INSERT UPDATE DELETE MERGE CREATE ALTER DROP CALL SET INTO QCMDEXC and any HTTP*; 10,000 characters at most; wrapped as `SELECT * FROM (…) AS IMW_QUERY FETCH FIRST n ROWS ONLY`). A user-defined function is out of reach of the check, which is why the tool shares the data-samples setting.
- `bobMcpTools.ts`: `sql_query` (gated by `allowDataSamples`, 50 rows by default and 500 at most, values cut at 200 characters, notes when the limit was hit) and `read_spool_file` (`listSpooledFiles` over `QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC`, newest first, the connected user's unless a user or job is given; `readSpooledFile` over `SYSTOOLS.SPOOLED_FILE_DATA` with validated job, name and number written into the statement; 2000 lines by default with startLine/endLine; `listOnly` lists at most 20). `ResearchIo` gained `runQuery`, `listSpooledFiles`, `readSpooledFile`; `SERVER_INSTRUCTIONS` and `RULES_BODY` name both tools. The tool name avoids "run" because the tool-name test forbids verbs that sound like they change something.
- Manifest: the `ibmi-member-workspace.research` submenu ("Research on IBM i") in Checked Out Members (`0_bob@4`), Find Member results, Object Browser members and the editor's member submenu; the five commands in the palette while `code-for-ibmi:connected`.

**Validation**
- `src/test/sqlGuard.test.ts` (blanking, accepted shapes, each refusal, limit clamping), `src/test/researchReport.test.ts` (table alignment and truncation, each report, usage bits), `src/test/bobMcpTools.test.ts` (`sql_query` gating, refusals as input errors, wrapping and truncation; `read_spool_file` newest-by-name, by job and number, `listOnly`, errors), `manifest.test.ts`.
- The SQL behind `listSpooledFiles` and `readSpooledFile` (`OUTPUT_QUEUE_ENTRIES_BASIC` columns, `SPOOLED_FILE_DATA` named arguments) was written from IBM's documentation and not run against an IBM i before release; the first call on a real system validates it. Manual: Find Where Used from the three views and the editor, Bring for Reference from its quick pick; Describe File on a PF; Show Job Log after a failed command.

### 21. Bundled build, concurrent refresh, batched object probes, upload time limit, type-aware lint (shipped in 1.8.12)

- Build: `npm run bundle` (esbuild, `src/extension.ts` → `dist/extension.js`, platform node, target node20, CJS, `vscode` external, minified, external source map left out of the VSIX). `main` is `./dist/extension.js`; `out/` stays the compiled tree the tests run against and is excluded from the VSIX (`.vscodeignore`: `out/**`, `dist/**/*.map`); `manifest.test.ts` allows only `dist/extension.js` of the code and checks `main`. `npm test` bundles before running, so that test sees the file. CI packages the VSIX on Linux and uploads it (`actions/upload-artifact` v7.0.2, pinned by commit). The bundle was smoke-loaded under Node with a stubbed `vscode` module (exports `activate`/`deactivate`).
- `refreshRun.ts` (vscode-free): `runRefreshSteps(steps, { concurrency, signal, onProgress, onError })` over `mapWithLimit`; `CheckoutService.refreshEntries` runs its steps through it with `DOWNLOAD_CONCURRENCY` (4) and an `AbortController` tied to the cancellation token (steps under way finish and are counted; the rest are not).
- `localPath.ts` `checkoutFilePath(root, parts)` builds `<root>/<system>/<LIB>/<SRCFILE>/<MEMBER>.<EXT>` (pure; the service keeps the inside-the-root check, the link check and the directory creation).
- `codeForIBMi.ts` `firstObjectRow`: one `UNION ALL` of `OBJECT_STATISTICS` per group of 25 libraries, in their order, falling back to one library at a time when the statement fails (an unknown or unauthorized library fails the whole statement); used by `findCompiledObject` and `describeObject`.
- Upload write: `uploadMemberContentWithDates` / `uploadMemberContent` run under `withDeadline` with the download's 2 minutes and slow-wait log line.
- ESLint: `projectService` type information for `src/**`; `no-floating-promises`, `no-misused-promises` (void-returning arguments allowed), `await-thenable`, `no-unnecessary-type-assertion`; tests exempt from `no-floating-promises` (`describe`/`it` return promises). The only finding in extension code was an unnecessary assertion in `getConnection`.
- Cleanups: `errorMessage()` everywhere (no inline `err instanceof Error ? …` left); `agentFiles.ts` `CLAUDE_MCP_FILE`, `CODEX_CONFIG_FILE`, `fileBelow` replace the paths repeated in `commands/agents.ts`.

**Validation**
- `src/test/refreshRun.test.ts` (tally of every status and errors, at most N at once, cancel starts nothing more), `src/test/localPath.test.ts` (`checkoutFilePath`), `manifest.test.ts` (VSIX holds `dist/extension.js` only, `main`).
- Manual: F5 from the bundled build (activation, a checkout, an upload, the research server, a checkpoint); Refresh All on a few hundred members.

## History

Shipped before the requirements above were written down here (from the former HANDOFF.md):

| Shipped in | What |
|---|---|
| 1.2.2 | Hash fixes: a leading BOM and trailing blanks no longer make an untouched member look changed; baselines carry `hashVersion: 2` and older ones are upgraded on the next save, refresh or upload. |
| 1.2.3, 1.2.4 | Git hardening: paths through stdin (Git 2.25+), no signing or hooks, `git switch`, inspection fails safe; 1.2.4 fixed an EPIPE crash on Linux. A deleted local file shows as "local file missing". |
| 1.3.0 | Upload on save (`autoUploadOnSave`), sharing `uploadFlow.ts` with the Upload command. |
| 1.4.0 | Find Dependencies v1: direct dependencies, read-only reference copies, a guide for the LMI hand-off. |
| 1.5.0, 1.5.1 | Pluggable dependency sources (source scan, DSPPGMREF with OBJECT_STATISTICS, user-defined cross-reference queries such as Abstract). |
| 1.7.2, 1.7.3 | Find All Dependencies (`dependencyWalk.ts`); the checkout index store extracted from `checkoutService.ts`. |

Local Change History was planned in the former `git-integration-plan.md`; all of its sub-tasks shipped, and `src/gitService.ts` and `src/workItemHistory.ts` are the source of truth now.

