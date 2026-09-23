# Change Log

## Unreleased

- Fix: whenever local and remote match (for example after a Merge Back or an identical edit on the IBM i), that content becomes the new baseline, so later local edits show as **local changes** instead of a false **conflict**, and **Upload** is no longer blocked.
- Fix: **Upload** and **Refresh** offer to save unsaved edits to checked-out files first, instead of using the stale copy on disk.
- Fix: re-downloading a member with local changes that were not sent to the IBM i now asks before discarding them. Multi-member re-downloads can keep those members instead.
- Fix: checkout ids no longer collide for names containing underscores (e.g. `MY_LIB/SRC` vs `MY/LIB_SRC`). Existing checkout indexes are converted automatically.
- **Discard Checkout** warns when members have local changes that were not sent to the IBM i.
- Saving a checked-out file updates its status to **local changes** right away, without contacting the IBM i.
- Refreshing a member whose local file was deleted offers **Re-checkout** or **Remove from Checkouts**.
- The Checked Out Members view explains how to check out a member when it is empty.
- A failed index save at the end of a batch is reported instead of hiding the batch summary.

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
