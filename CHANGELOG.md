# Change Log

## 1.8.0 - 2026-10-02

- **The change-management checkout command can name the project and the developer.** `ibmi-member-workspace.changeManagement.checkoutCommand` now accepts `&PROJECT`, the project (task) you name each time, with the last one filled in, and `&USER`, the user profile Code for IBM i is connected with. For example, Rocket LMI's `ACMSLIB/ACMSCHKOUT OBJ((&OPENSPF (&OPENMBR))) PROJECT(&PROJECT) DVP(&USER) REL(...)` now runs without editing the setting for each change. Only valid IBM i names are filled in. The README also explains why to call the change-management command directly rather than through a wrapper program.
- **Find a program and check it out through change management, without a 5250 session.** The new **Find Member** panel below Checked Out Members finds source members by name or pattern in your search scope, or in other libraries from its title bar. It also finds the member a program was compiled from, and offers to search member text when nothing has that name. The results stay in the panel, and **Recent Searches** runs a search again. Right-click results for **Check Out Through Change Management…**, which runs your checkout command (for example Rocket LMI's `ACMSCHKOUT`) and then checks out the development library's copy here, ready to change, or for **Bring for Reference** or **Check Out for Change Here**. **Check Out Through Change Management…** is also on the right-click menu of Object Browser members and of Checked Out Members.
- **Claude Code and Codex in IBM Bob.** In Bob, the **AI Research Tools** section and **Investigate with AI** now offer Claude Code and Codex too, next to Bob's own agent, which works as before. Each keeps its own server and token, so disconnecting one never disconnects Bob. GitHub Copilot stays VS Code only.
- In Settings, the change-management checkout command now has a full-width box that wraps, so you can review the whole command. Line breaks you add are joined with spaces when it runs.
- Fix: when the change-management checkout command failed, only its last three messages were shown, which for Rocket LMI are just "ACMSCHKOUT ended ABNORMALLY" (CMS9913) and SQL0443. The message that says why is now shown first, including messages the command left in the job log.

## 1.7.13 - 2026-10-02

- **Claude Code, Codex and GitHub Copilot can research your IBM i programs**, as IBM Bob's agent does in Bob. In VS Code, a new **AI Research Tools** section above Checked Out Members connects an agent to the same read-only research tools: what a program uses, what uses it, file layouts, and the source behind them. Claude Code gets the server in the workspace's `.mcp.json`, Codex in `.codex/config.toml`, and Copilot through VS Code's chat (VS Code 1.101 or later), with no file. Connect lets Claude Code and Codex use the tools without asking, and can add the same rules Bob gets. The token is kept out of Git, a committed `.mcp.json` is never given it, and Disconnect replaces it. Nothing runs until you connect an agent. See **Using with Claude Code, Codex and GitHub Copilot** in the README.
- **Investigate with AI.** Right-click members for **Analyze Relationships**, **Explain Program** or **Deep Dive**, the same prompts as **Bob, Investigate**. The prompt opens in Claude Code, Copilot Chat or Codex, ready for you to review and send.
- In IBM Bob, everything works as before.

## 1.7.12 - 2026-10-02

- **Status in the Explorer.** Checked-out files now show their sync status in VS Code's Explorer, on editor tabs and in Checked Out Members: **↑** for local changes not yet uploaded, **↓** for a member changed on the IBM i, **!** for a conflict, and **RO** for a read-only reference copy. Members in sync show nothing. Hover over a file for details.

## 1.7.11 - 2026-10-02

- **Quicker refresh.** **Refresh All Remote Status** and refreshing a source file group now ask the IBM i, with one query per source file, which members changed since they were last compared, and download only those. The others only have their local copy read, so refreshing hundreds of unchanged members takes seconds. Refreshing one member, or a selection, still downloads and compares each one, and an upload still always checks the member on the IBM i first.
- **Background refresh, if you want it.** Two new user settings refresh your checkouts' status quietly: `ibmi-member-workspace.backgroundRefresh.onConnect` when Code for IBM i connects, and `ibmi-member-workspace.backgroundRefresh.intervalMinutes` every so many minutes (at least 5). Both are off by default. When a member you changed locally turns out to have changed on the IBM i too, a notification offers **Merge Back**.
- A badge on the Member Workspace icon shows how many members changed on the IBM i, with or without local changes.

## 1.7.10 - 2026-10-02

- **Checks before uploading.** Upload to IBM i and upload on save now check the local copy for lines longer than the source file holds, and for characters the member's CCSID can't store, such as the typographic quotes, dashes and ellipses that word processors and AI tools add. Until now the IBM i cut these lines off or replaced these characters, and you found out only afterwards. You're now asked to **Upload Anyway** or **Show Problems** first, even when upload on save is `silent`. A multi-member upload skips those members and lists them in the output panel.
- The same problems are underlined in the editor as you type and listed in the Problems view. A quick fix replaces typographic characters with plain text, one at a time or all at once. The line length and CCSID are read when you check out a member and kept with the checkout, so the checks also work offline. For members checked out with an earlier version, they're read at the next refresh or upload.

## 1.7.9 - 2026-09-30

- Fix: **Re-checkout** from a Refresh notification could overwrite local edits. The notification that says your local copy has no changes (or that the local file no longer exists) can stay open while you keep working, so edits saved in the meantime were replaced without a warning. Re-checkout now checks the local copy again first, and if it has changes that aren't on the IBM i, asks before discarding them and suggests Merge Back instead.

## 1.7.8 - 2026-09-30

- In Settings, **Dependencies: Search Scope** now shows **Automatic** as its default instead of an empty choice, and names each scope: **Automatic** (Search Libraries when `dependencies.searchLibraries` lists some, otherwise Library List), **Library List**, **Search Libraries** and **All User Libraries**. Nothing changes in how dependencies are searched.

## 1.7.7 - 2026-09-30

- **Choose where Find Dependencies looks.** The new `ibmi-member-workspace.dependencies.searchScope` setting searches your **library list** (as shown in Code for IBM i), only your **specific** search libraries (`dependencies.searchLibraries`), or **everywhere**: every library except IBM's, with your library list first. Everywhere reads the whole system catalog, so it can take a while on a large system. When the setting isn't set, nothing changes: your search libraries if you listed some, otherwise your library list. To search somewhere else once, click the library button in the dependency list's title bar. When sources aren't found, the warning offers **Search All User Libraries**.
- Fix: Find Dependencies searched libraries outside your library list or search libraries whenever a dependency named one, for example the library DSPPGMREF says a program was compiled from, a cross-reference row, or `/COPY OTHERLIB/QCPYSRC,X`. With the library list or specific libraries, it now looks for that member by name inside them instead, and the output panel lists the libraries it skipped.

## 1.7.6 - 2026-09-30

- **Run your change-management checkout from Find Dependencies.** Set `ibmi-member-workspace.changeManagement.checkoutCommand` (user settings only) to the CL command that checks a member out in your change-management system, such as Rocket LMI. **I Need to Change Some…** then asks for the development library, shows the exact command for each member, runs them on the IBM i when you choose **Run**, and offers **Check Out from DEVLIB** to check out the development copies here. The command can use `&OPENLIB`, `&OPENSPF`, `&OPENMBR`, `&EXT` and `&DEVLIB`. A failed member is reported with the IBM i's message and doesn't stop the others, and nothing runs while a different IBM i is connected. Without the setting, the steps are explained as before. See **Running Your Change-Management Checkout** in the README.

## 1.7.5 - 2026-09-30

- **Find Dependencies reads COBOL.** For CBLLE, SQLCBLLE, CBL and SQLCBL members, the source scan finds copybooks from `COPY` (with or without `OF`/`IN` a source file and library), `EXEC SQL INCLUDE`, the files whose record formats `COPY DDS-…` copies, and the tables, views and procedures of embedded SQL. Comment lines and columns 73–80 are ignored. A copybook named without a source file is looked for in `QCBLLESRC` first. Find All Dependencies reads a COBOL member's copybooks as COBOL, whatever their source type, so nested `COPY` statements are found too.

## 1.7.4 - 2026-09-30

- **Upload on save for one member.** When a checked-out member is open, the status bar shows its upload-on-save mode, even while `autoUploadOnSave` is `off`. Click it, or run **Change Upload on Save for This Member**, to choose **Off**, **Ask** or **On** for that member alone, or **Use Setting** to follow the setting again. For example, keep the setting `off` and turn it on only for the member you're testing. The choice is kept with the checkout, survives a re-download, and is never read from workspace files. In `ask` mode, **Always Upload** switches only that member when it has its own choice. Reference copies never upload, and a change made on the IBM i still always asks.

## 1.7.3 - 2026-09-30

- Internal: the checkout index is loaded and saved by its own module, now covered by unit tests. Checkouts are stored exactly as before, and nothing changes in how the extension works.

## 1.7.2 - 2026-09-29

- **Find All Dependencies.** A new right-click command in Checked Out Members, just below **Find Dependencies…**, finds what a member uses, what those members use, and so on: nested copybooks, a called program's own programs and files, and a file's field-reference file. Each member's source is read from the IBM i as it goes, and nothing is written until you choose. Each member in the list says how it was reached (*via ORD200 → ORDHDR*). The search looks into each member once, and it stops to ask **Keep going?** after `dependencies.transitive.maxDepth` levels (3 by default) or `dependencies.transitive.maxMembers` members (50 by default). You can cancel it and still choose from what was found. Find Dependencies is unchanged and still finds direct dependencies only.
- Fix: if you switched Code for IBM i to another system while an upload, refresh, checkout or Bob's reference copies were running, the rest of the work went to the system you had just connected. An upload could overwrite a member there that matched your checkout, and a batch checkout with **Discard Local Changes** could overwrite that system's unsent local edits. Those members are now refused (*Connected to X, not Y*) and counted as errors.
- Fix: a checkout that finished just as the connection dropped wrote its file but was left out of Checked Out Members.
- Fix: **Disconnect Bob from IBM i Research Tools** could keep the old token if the research tools restarted at the same moment.

## 1.7.1 - 2026-09-29

- In Checked Out Members, **Find Dependencies…** is now at the top of the right-click menu, just below **Bob, Investigate** in IBM Bob.

## 1.7.0 - 2026-09-29

- **Bob Research Tools section.** In IBM Bob, the Member Workspace side bar has a **Bob Research Tools** section above Checked Out Members. Until a folder is connected it shows a **Connect Bob to IBM i Research Tools** button, so you don't need the Command Palette. Once connected, it shows which workspace folders are connected (or turned off in Bob's MCP settings), whether the research tools are running, and which IBM i they read. Click a folder that isn't connected to connect it, and right-click a connected one to disconnect it. With `ibmi-member-workspace.bob.researchTools` off, the section says so and links to the setting. The section opens small, and its header shows the status in one line (for example *Connected · PUB400* or *Not connected*), so you can collapse it to just the header and still see the status; the side bar doesn't let an open section get shorter than about five rows. VS Code is unchanged.

## 1.6.0 - 2026-09-28

- **IBM i research tools for IBM Bob.** In IBM Bob, Bob's agent can find what a member uses, what uses a program or file (`find_where_used`), file and table layouts, service program exports, and member source. Run **Connect Bob to IBM i Research Tools** to add them to a folder's `.bob/mcp.json`. The tools run in a local server that only accepts requests from this computer with a token. None of them changes the IBM i: every member Bob looks at is brought as a **read-only reference copy**, and a member you checked out for change is never overwritten. VS Code is unchanged: no server, no commands, no files. See **Using with IBM Bob** in the README. Turn the tools off with `ibmi-member-workspace.bob.researchTools`. `ibmi-member-workspace.bob.whereUsedMaxLibraries` sets how many search libraries `find_where_used` reads when Bob names none (10 by default, up to 25). A call reads at most 25 libraries, and the result lists any that were left out. Each library's DSPPGMREF snapshot is indexed and reused for 15 minutes (at most 10 are kept), so repeated searches are fast, and IBM system libraries are never read. **Bob, Investigate** on the right-click menu (Checked Out Members, the Object Browser, and checked-out files in the Explorer) puts a ready-made **Analyze Relationships** or **Explain Program** prompt for the selected members into Bob's chat. You review it and press Enter.
- Fix: two DSPPGMREF or DSPDBR lookups running at the same time (for example Find Dependencies while Bob researches) could read each other's QTEMP results. They now run one at a time.
- **Find Dependencies finds SQL tables and procedures.** The source scan now also reads the tables and views embedded SQL uses (`FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `MERGE INTO`, skipping CTE names and `SESSION`/`QTEMP` tables), programs called through `EXTPGM` prototypes, and bound procedures from prototypes, SQL `CALL`, and CL `CALLPRC`. Tables are offered in a new **SQL tables and views** group. Procedures are counted, but not offered, since they have no member of their own.
- Faster batches: checking out, refreshing or bringing many members at once asked Git for the work item twice per member, starting thousands of Git processes for a large source file. The views and the work-item status bar now update at most four times a second during a batch, and the status bar asks Git once at a time.
- Faster dependency lookups: the source of the files and programs DSPPGMREF finds is looked up 25 objects per SQL statement instead of one statement each. If a statement fails, its objects are looked up one at a time as before.
- Fix: when a `find_where_used` refresh failed partway, later searches could reuse the half-written snapshot and miss callers. A snapshot being taken again is no longer reused. Failed snapshots also no longer leave extra files in QTEMP: at most 10 are ever made.
- Fix: the research tools read a checkout through a link. A link put in a checkout's place could hand Bob any file on the computer without Bob asking. Find Dependencies (which `find_member_dependencies` uses) read it the same way. Reading through a link below the checkout folder is now refused, as checkouts already do.
- Fix: **Connect Bob to IBM i Research Tools** kept every field of an existing `ibmi-member-workspace` entry in `.bob/mcp.json`, so a cloned project's `command` or `type` survived next to your token. Only your own `disabled`, `timeout` and `disabledTools` are kept now.
- In folders you connected, `.bob/mcp.json` now also gets the tools a new version adds (a tool you took out of `alwaysAllow` stays out), and `.bob/rules/ibmi-member-workspace.md` is updated when the extension starts. A rules file you edited is left alone: delete its first line to keep your own. Before, the rules file was never updated, and `.bob/mcp.json` only when the port or token changed.
- **Bob, Investigate → Deep Dive**: one walkthrough of a program or file for a developer new to it (callers, inputs and outputs, main logic with line numbers, business rules, error handling, non-obvious parts, change risks; for a file its layout, keys and the programs that use it). Bob writes it to `docs/DEEP_DIVE_<MEMBER>.md`, or for several members to a name it picks from their purpose, and never overwrites an existing document. Each member in a Bob, Investigate prompt now shows its source type.
- Fix: **Bob, Investigate** sometimes pasted the prompt into the open editor (then undid it) instead of Bob's chat, and could close and reopen a chat that was already open. It now opens Bob's chat view the way VS Code does, which never closes it, gives a hidden chat time to load, and tries a missed paste once more. A missed paste always lands in an editor, where it is undone, and never in the terminal. When Bob's chat was already open but another part of the window had the focus, the prompt didn't reach the chat box; it now does.
- Fix: `.bob/mcp.json` was kept out of Git only when the folder was the top of its repository. It is now also excluded in a folder further down. In a worktree or submodule, Connect warns you to add it to `.gitignore`.
- A research tool call names at most 250 libraries, and the log shortens long tool names.
- Cross-reference queries may return `KIND` values `table`, `view`, `procedure`, and `function`. **Changed:** `TABLE` and `VIEW` rows are now SQL tables rather than files. They are still matched to file source members.

## 1.5.3 - 2026-09-27

- Fix: on Windows, the generated `.gitignore` of a new system repository could still be written through a link to a missing file (1.5.2 fixed this on macOS and Linux only).

## 1.5.2 - 2026-09-27

Security fixes from a review of the extension. The ones you may notice are marked **Changed**.

- Fix: Git run by Local Change History could run programs from the checkout folder: a folder laid out as a bare repository (for example inside a cloned project) was used as the system repository and its `core.fsmonitor` command ran, and repository hooks such as `post-commit` ran despite checkpoints skipping hooks. The extension's Git commands now never run hooks or fsmonitor and never use a bare repository found there. **Changed:** hooks you installed in a checkout repository no longer run for the extension's commits.
- **Changed:** before its first Git write to a repository in a system folder that it didn't create, Local Change History asks whether to use it. Repositories you already use are kept without asking.
- **Changed:** a workspace's `.vscode/settings.json` turns Local Change History on only after you agree once for that workspace. **Set Up Local Change History** and user settings work as before, and workspaces already using it are not asked.
- **Changed:** `autoUploadOnSave` is read from user settings only, so a workspace can't turn on uploads. A value in workspace settings is ignored; set it in your user settings instead.
- Fix: a checkout could write outside the checkout folder when a library, file, member or source type held "..", "/" or "\". **Changed:** checking out a member whose names aren't valid IBM i system names now fails with a message instead.
- Fix: commands acted on the checkout details passed to them, so a `command:` link could upload or delete an arbitrary local file. They now act only on stored checkouts.
- Fix: checkouts, uploads, Merge Back, moves and discards followed symbolic links inside the checkout folder, so a planted link could redirect them to a file outside it. **Changed:** a member path through a link or junction below the checkout folder is refused; the checkout folder itself may still be a link.
- Fix: the dependency scan could freeze the extension host for minutes on a DDS line of repeated `REF(` or on a long run of CL continuation lines.
- The message for a checkout folder that Git says another account owns recommends a folder you own, and warns before suggesting `safe.directory`.
- Internal handoff notes (`HANDOFF.md`), included by mistake in the 1.4.0 to 1.5.1 packages, are no longer packaged.
- The generated `.gitignore` is never written through a link, and work-item names and start points can't be read as Git options.
- The extension declares that it doesn't run in untrusted workspaces (unchanged behavior). CI uses a read-only token and actions pinned to commits.

## 1.5.1 - 2026-09-27

- README: a ready-made `dependencies.crossReferences` entry for **Abstract R11** (`ABSTRACT` library). It finds copybooks from `CPYXRF` (with their exact source location), files and programs from `PGMREF`, and calls from `OBJREF`, and is skipped on systems without Abstract.

## 1.5.0 - 2026-09-25

- **Find Dependencies asks more sources, and only those the connected IBM i has.** Each source is checked on the system once per connection and left out when it isn't available. The list says which sources found each dependency and which weren't available.
  - **Source scan** now also finds the files an RPG program declares (F-specs and `dcl-f`, honoring `EXTDESC`) and `EXTNAME` data structures.
  - **DSPPGMREF** runs on the member's compiled program in the search libraries and finds the files, programs, and service programs it uses, pointing at the source each was created from.
  - **Cross-reference tools** such as Abstract, Pathfinder, or MDXREF plug in through `dependencies.crossReferences`: a SQL query per tool, optionally limited to systems where its library exists.
- `dependencies.sources` turns a kind of source off. `dependencies.searchLibraries` is now also where compiled programs are looked for.

## 1.4.0 - 2026-09-25

- **Find Dependencies.** Right-click a checkout, or follow the prompt after a single checkout, to see the copybooks (`/COPY`, `/INCLUDE`, `EXEC SQL INCLUDE`), called programs (CL `CALL`, `TFRCTL`), and referenced files (DDS `REF`, `REFFLD`, `PFILE`, `JFILE`) a member uses. Their source is looked up in the libraries set in `dependencies.searchLibraries`, or the library list.
- **Read-only reference copies.** Chosen dependencies are downloaded as reference copies: read-only on disk, shown with a lock icon, and never uploaded or merged back. Refresh offers **Update Reference Copy**. To change one, the extension points you to your change-management system (for example, Rocket LMI) and can copy the member paths.
- Dependencies whose source can't be found are listed with the line that refers to them.

## 1.3.0 - 2026-09-25

- **Upload on Save.** The new `ibmi-member-workspace.autoUploadOnSave` setting (`off`, `ask`, or `silent`) uploads a checked-out member when you save it in the editor. Saves without local changes are skipped. A member changed on the IBM i since checkout always asks before it is overwritten, and files changed by other tools are never uploaded automatically.
- A status-bar item shows the upload-on-save mode while it is on. Click it, or run **Change Upload on Save**, to switch modes.
- **Upload to IBM i** and upload on save share one code path, so they handle remote changes and truncated lines the same way.

## 1.2.4 - 2026-09-25

- Fix: Local Change History could fail with "write EPIPE" when a Git command finished before the extension had finished sending it input (seen on Linux, introduced in 1.2.3).

## 1.2.3 - 2026-09-25

- Fix: checking out or uploading many members at once (for example, **Check Out All Members** on a source file with about 1,000 members) no longer fails to save its checkpoint on Windows because the Git command line was too long.
- Fix: automatic checkpoints no longer hang or fail when your global Git config signs commits (`commit.gpgsign`) or runs hooks.
- Fix: switching to a work item whose name matches a folder in the checkout folder can no longer discard local edits in that folder.
- Fix: the repair of a misplaced checkout repository refuses to run when Git could not list the repository's contents, instead of treating it as empty and safe.
- A checked-out file deleted outside VS Code shows as **local file missing** in Checked Out Members right away. Refresh offers **Re-checkout** or **Remove from Checkouts**.
- Local Change History now requires Git 2.25 or later, and says so if an older Git is found.

## 1.2.2 - 2026-09-25

- Fix: a local file saved with a byte-order mark (BOM), for example by Windows PowerShell 5.1 or some AI tools, no longer shows as **Modified**, and no longer triggers the "IBM i copy differs" warning after upload.
- Fix: changing VS Code's `files.trimTrailingWhitespace` setting no longer turns members into **Modified** or **Conflict**. Trailing blanks on a line are never significant in source members.
- Existing checkouts are upgraded automatically the next time they are saved, refreshed, or uploaded. A member that was changed on both sides before the upgrade still shows as **Conflict** until you Merge Back.

## 1.2.1 - 2026-09-24

- Fix: **Upload to IBM i** no longer resets every source date (SRCDAT) to `000000`. When source dates are enabled in Code for IBM i, uploads save through Code for IBM i like an edit in its editor: unchanged lines keep their dates and changed lines are dated today. CRLF line endings in the local file no longer affect the dates.
- Fix: blank lines at the end of the local file are no longer uploaded as empty records, which broke compiles. Re-uploading a member removes an empty last record left by an earlier upload.

## 1.2.0 - 2026-09-23

- **Every checkout belongs to a work item.** While no work item is selected, checking out asks you to start or choose one; the first checkout of each session confirms the active work item. Members from different tickets no longer end up in the same work item by accident.
- **New work items start empty** instead of inheriting the current work item's files and members. You can still copy the current members, or move members that were checked out without a work item into the new one.
- **Move to Work Item…** moves checked-out members (including unsent local edits and sync status) to another work item. Members are saved in the target before they are removed from the source.
- The status bar and the Checked Out Members header show the active work item, and highlight **No Work Item**.
- Multi-member checkouts and uploads save one checkpoint for the batch, and prepare the repository once instead of once per member.
- Work items cannot be changed while a checkout, upload, or Merge Back is running, so a batch never lands in two work items.
- New work-item names are checked before anything changes, including names that differ only by case.
- Fix: a history repository that Git fails to open is no longer re-initialized. Re-initializing moved the current work item's files onto the default work item.
- Fix: checkpoints are no longer saved on a detached commit, where they would be lost.
- Fix: the status bar no longer shows the branch of an enclosing project repository before Local Change History is set up.
- Upgrading: members checked out on the default work item (`workspace`) stay there. The next checkout asks for a work item; choose **Start New Work Item**, then **Move current members** to turn them into a ticket. See **Local Change History → Work Items** in the README for diagrams of the new flow.

## 1.1.2 - 2026-09-23

- Fix: on Windows, **Switch Work Item** and Local Change History setup no longer fail with "Could not create an isolated history repository in the checkout folder".
- When Git rejects a checkout folder owned by another account (common on network drives), the error explains how to trust it with `safe.directory`.

## 1.1.1 - 2026-09-22

- Fix: whenever local and remote match (for example after a Merge Back or an identical edit on the IBM i), that content becomes the new baseline, so later local edits show as **local changes** instead of a false **conflict**, and **Upload** is no longer blocked.
- Fix: **Upload** and **Refresh** offer to save unsaved edits to checked-out files first, instead of using the stale copy on disk.
- Fix: re-downloading a member with local changes that were not sent to the IBM i now asks before discarding them. Multi-member re-downloads can keep those members instead.
- Fix: checkout ids no longer collide for names containing underscores (e.g. `MY_LIB/SRC` vs `MY/LIB_SRC`). Existing checkout indexes are converted automatically.
- **Discard Checkout** warns when members have local changes that were not sent to the IBM i.
- Saving a checked-out file updates its status to **local changes** right away, without contacting the IBM i.
- Refreshing a member whose local file was deleted offers **Re-checkout** or **Remove from Checkouts**.
- The Checked Out Members view explains how to check out a member when it is empty.
- A failed index save at the end of a batch is reported instead of hiding the batch summary.
- Edits made outside VS Code (AI tools, scripts, git) update a checkout's status to **local changes** automatically.
- Saving a checked-out member on the IBM i from VS Code outside **Merge Back** (e.g. from **Show Diff** or **Open Remote File**) refreshes its status right away, without a manual Refresh.
- **Re-download** and **Discard Checkout** now also warn about unsaved edits in an open editor, not just changes saved to disk.
- Fix: after **Upload**, the member is re-read from the IBM i and used as the new baseline. If the IBM i stored something different (e.g. lines longer than the record length were truncated), you're warned and the member shows **local changes**, instead of a later Refresh falsely reporting **remote changed**.
- Development: split command handlers out of `extension.ts` into `src/commands/`.

## 1.1.0 - 2026-09-22

- **Local Change History** — opt-in Git history stored at each system working directory (`checkout/<system>`), with guided author setup and actionable errors. This corrects the initial 1.1.0 layout, which could place `.git` at the checkout container.
- **Work items** — create or switch ticket-specific work items safely; checkout state and remote baselines are stored separately for each work item.
- **Automatic checkpoints** after checkout, upload, re-checkout, merge-back, and discard operations.
- **Save Checkpoint** and **View Local History** commands for manual recovery points and history access.
- Work-item switching protects unsaved and uncheckpointed changes instead of discarding them.
- Existing system repositories are adopted without changing their history or remotes. A recoverable migration restores legacy work-item branches and can archive, never delete, misplaced parent metadata after confirmation.

## 1.0.1 - 2026-09-21

- Require a visible, user-selected checkout folder before downloading any member.
- Store the selected folder and checkout index per VS Code workspace without changing project settings.
- Add first-run guidance and a **Configure Checkout Folder** command.
- Require an open folder or workspace for checkout operations.

# 1.0.0 - IBM i Member Workspace

- First release under the independent **IBM i Member Workspace** product identity.
- Uses separate Marketplace, command, settings, view, context-key, and storage identities so it can coexist with the original extension.
- Starts a new repository history while retaining GPL-3.0 licensing and attribution for the project from which it was derived.

- New **Remote changed** status: a member edited only on the IBM i is no longer reported as a conflict, and can be re-checked out safely. **Conflict** now means changed on both sides.
- **Upload to IBM i** now checks for changes made on the IBM i since checkout and asks before overwriting them. Multi-member uploads skip those members and list them in the output panel.
- Refresh All / source file / multi-select refreshes show per-member progress and can be cancelled. Refresh errors are logged to the output panel.
- The checkout index is written once per batch operation and saved atomically. An unreadable index is backed up and reported instead of being silently reset.
- Uses the current Code for IBM i API (`IBMi.getContent()` and `instance.subscribe()`) instead of deprecated calls.
- Requires VS Code 1.90 or later (the minimum for Code for IBM i 3.x).
- Development: upgraded to ESLint 10 (flat config), typescript-eslint 8 and TypeScript 6, which removes all deprecated packages and audit warnings. Added unit tests (`npm test`).
