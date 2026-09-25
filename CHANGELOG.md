# Change Log

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
