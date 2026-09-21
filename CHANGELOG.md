# Change Log

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
