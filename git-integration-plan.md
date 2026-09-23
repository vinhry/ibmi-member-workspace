# Git Integration Plan for IBM i Member Workspace

## Top-Level Overview

**Goal:** Add opt-in git integration to the checkout folder so that each checkout, local edit session,
and merge-back operation is automatically tracked in a git repository. Developers create or switch to a
free-form named branch (e.g., `TICKET-123`, `payroll-fix`, `sprint-42`) before checking out members,
giving a complete history of every file's changes tied to a project or ticket.

**Confirmed Decisions:**
- One git repo per checkout root; each project or ticket gets its own branch (free-form name, no enforced prefix)
- Auto-commits fire at lifecycle events: after checkout, after upload, after merge-back, after re-checkout
- A manual "Commit Now" command is also provided so users can snapshot local edits at any time
- `ibmi-member-workspace.gitIntegration` defaults to `false` (opt-in)
- If git is not installed and the setting is `true`, show a warning notification (not silent)

**Scope:**
- New `src/gitService.ts` — thin wrapper around the `git` CLI using `child_process.execFile`
- New `ibmi-member-workspace.gitIntegration` VS Code setting (boolean, default `false`)
- New commands: `Select Git Branch` and `Commit Now`
- Auto-commit hooks in `CheckoutService` at: checkout, upload, re-checkout
- Auto-commit hook in `extension.ts` after merge-back completes
- Status bar item showing the active branch when git integration is enabled
- No changes to the existing three-way hash sync, tree view icons, or index persistence logic

**Non-Goals:**
- Push/pull to remote git remotes (user manages that via VS Code's built-in SCM)
- Replacing the three-way hash sync with git diff
- Git status decorations on tree view items
- Any custom git history UI (VS Code's Source Control panel handles this)

---

## Sub-Tasks

---

### Sub-Task 1 — Add `GitService` class

**Intent:**
Create a thin service that wraps git CLI commands using Node.js `child_process.execFile`. All git
operations in the extension go through this class. It gracefully handles the case where git is not
installed by returning a typed result rather than throwing, and logs everything to the output channel.

**Expected Outcomes:**
- `src/gitService.ts` exists with a `GitService` class
- Public API: `checkGitAvailable()`, `isGitRepo(folder)`, `ensureRepo(folder)`, `currentBranch(folder)`,
  `listBranches(folder)`, `createAndSwitchBranch(folder, name)`, `switchBranch(folder, name)`,
  `stageFile(folder, filePath)`, `commit(folder, message)`
- `checkGitAvailable()` returns `true`/`false` and is used by the setting-check guard
- All methods catch errors internally, log them, and return a safe default (`false`, `""`, `[]`) rather
  than propagating — lifecycle callers must not crash if git fails
- `commit()` treats a non-zero exit due to "nothing to commit" as a no-op (logged, not an error)
- Uses `execFile` (not `exec`) to avoid shell injection

**Todo List:**
1. Create `src/gitService.ts`
2. Import `execFile` from `node:child_process` and `promisify` from `node:util`; create a `pExecFile`
   promisified wrapper
3. Add constructor accepting `vscode.OutputChannel`
4. Implement private `run(cwd: string, args: string[]): Promise<string>` — calls
   `pExecFile('git', args, { cwd })`, returns trimmed stdout, logs stderr on failure and rethrows
5. Implement `checkGitAvailable(): Promise<boolean>` — runs `git --version`, returns `true` on success,
   `false` on any error (including ENOENT = not installed)
6. Implement `isGitRepo(folder: string): Promise<boolean>` — runs
   `git -C <folder> rev-parse --is-inside-work-tree`, returns `true`/`false`
7. Implement `ensureRepo(folder: string): Promise<void>` — checks `isGitRepo`, and if false:
   - writes `.gitignore` to `<folder>/.gitignore` (see Sub-Task 5 for content)
   - runs `git -C <folder> init`
   - runs `git -C <folder> add .gitignore`
   - runs `git -C <folder> commit -m "Init IBM i checkout repo"`
8. Implement `currentBranch(folder: string): Promise<string>` — runs
   `git -C <folder> branch --show-current`, returns branch name or `""` on error
9. Implement `listBranches(folder: string): Promise<string[]>` — runs
   `git -C <folder> branch --format=%(refname:short)`, returns array of names (empty array on error)
10. Implement `createAndSwitchBranch(folder: string, name: string): Promise<boolean>` — runs
    `git -C <folder> checkout -b <name>`, returns `true` on success, `false` on error
11. Implement `switchBranch(folder: string, name: string): Promise<boolean>` — runs
    `git -C <folder> checkout <name>`, returns `true` on success, `false` on error
12. Implement `stageFile(folder: string, filePath: string): Promise<void>` — runs
    `git -C <folder> add <filePath>`, logs error but does not rethrow
13. Implement `commit(folder: string, message: string): Promise<void>` — runs
    `git -C <folder> commit -m <message>` (no `--allow-empty`); if exit code is non-zero AND stderr
    contains "nothing to commit", log as info and return; otherwise log error and return (never throw)

**Relevant Context:**
- Node.js built-in `child_process` and `util` — no new npm dependencies
- The output channel instance is already created in [`src/extension.ts`](src/extension.ts:34) and passed
  to `CheckoutService`; the same instance will be passed to `GitService`
- All git commands use `-C <folder>` flag so the VS Code process CWD is irrelevant

**Status:** `[x] done`

---

### Sub-Task 2 — Add `gitIntegration` setting and wire `GitService` into `CheckoutService`

**Intent:**
Add the VS Code setting that gates all git behaviour. Wire `GitService` into `CheckoutService` via
constructor injection so lifecycle hooks can call it. Add a guard that checks both the setting AND
git availability — and warns the user if git is missing when they try to enable the feature.

**Expected Outcomes:**
- `ibmi-member-workspace.gitIntegration` setting appears in VS Code Settings UI, default `false`
- `CheckoutService` accepts an optional `GitService` in its constructor and stores it privately
- `isGitEnabled(): Promise<boolean>` in `CheckoutService` checks the config AND calls
  `gitService.checkGitAvailable()`; if setting is `true` but git is not found, it shows a one-time
  warning notification and returns `false`
- `extension.ts` constructs `GitService` before `CheckoutService` and passes it in

**Todo List:**
1. Add `"ibmi-member-workspace.gitIntegration"` to `package.json` `contributes.configuration.properties`:
   - `type: "boolean"`, `default: false`
   - `description: "Automatically commit checked-out members and changes to a git repository in the checkout folder. Requires git to be installed."`
2. Update `CheckoutService` constructor to accept `gitService?: GitService` as a third parameter; store
   as `private readonly gitService: GitService | undefined`
3. Add `private async isGitEnabled(): Promise<boolean>` to `CheckoutService`:
   - Read `vscode.workspace.getConfiguration("ibmi-member-workspace").get<boolean>("gitIntegration", false)`
   - If `false`, return `false` immediately
   - Call `this.gitService?.checkGitAvailable()` — if `false`, show
     `vscode.window.showWarningMessage("IBM i Member Workspace: git integration is enabled but git was not found on PATH. Install git and reload VS Code.")`, return `false`
   - Return `true`
4. In `extension.ts` `activate()`, construct `GitService` before `CheckoutService`:
   ```
   const gitService = new GitService(outputChannel);
   const service = new CheckoutService(context, outputChannel, gitService);
   ```

**Relevant Context:**
- [`src/checkoutService.ts`](src/checkoutService.ts:39) — constructor, currently takes `context` and `log`
- [`src/extension.ts`](src/extension.ts:34-38) — `activate()`, where `outputChannel` and `service` are
  constructed
- [`package.json`](package.json) — `contributes.configuration.properties` block to extend

**Status:** `[x] done`

---

### Sub-Task 3 — Branch selection command, status bar, and auto-commit on checkout

**Intent:**
Add the `Select Git Branch` command so developers declare their project/ticket context before or during
work. When git is enabled, every `checkoutMember()` call auto-commits the downloaded file on the active
branch. A status bar item shows the current branch at a glance.

**Expected Outcomes:**
- Command `IBM i Member Workspace: Select Git Branch` is available in the Command Palette and in the
  checkout panel toolbar
- Quick Pick shows: all existing branches (current branch marked with `$(check)`) + a
  `$(add)  Create new branch…` option at the top
- "Create new branch" prompts for a free-form name; creates and switches to it
- Selecting an existing branch switches to it; selecting the already-active branch is a no-op
- Status bar item (right side) shows `$(git-branch) <branchname>` when git is enabled and a repo exists;
  hidden otherwise
- `CheckoutService.checkoutMember()` — after writing the file — calls `ensureRepo()` → `stageFile()` →
  `commit("checkout: LIBRARY/SOURCEFILE(MEMBER) from SYSTEM")` when git is enabled
- If the checkout folder has no git repo yet, `ensureRepo()` initializes it transparently

**Todo List:**
1. Add command `"ibmi-member-workspace.selectGitBranch"` to `package.json` `contributes.commands` with
   title `"IBM i Member Workspace: Select Git Branch"` and icon `"$(git-branch)"`
2. Add the command to `package.json` `contributes.menus` under `"view/title"` for view
   `"ibmi-member-workspace.checkoutView"` (toolbar icon), gated on
   `"ibmi-member-workspace:checkoutFolderConfigured"` context
3. Register the command handler in `extension.ts` `registerCommands()`:
   - Get `checkoutRoot` from `service.getCheckoutRoot()`; if none, prompt to configure first
   - Call `gitService.ensureRepo(root)` to make sure a repo exists
   - Call `gitService.listBranches(root)` and `gitService.currentBranch(root)`
   - Build Quick Pick items: `$(add)  Create new branch…` first, then each branch name (current gets
     `$(check)` prefix and `description: "current"`)
   - On "Create new branch": show `vscode.window.showInputBox({ prompt: "Branch name" })`; validate
     non-empty; call `gitService.createAndSwitchBranch(root, name)`
   - On existing branch: if already current, show info message "Already on branch X"; else call
     `gitService.switchBranch(root, name)`
   - Refresh status bar item after any change
4. Create a status bar item in `extension.ts` `activate()`:
   - `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)`
   - Text: `$(git-branch) <branch>` when git enabled and repo exists, else hide
   - Tooltip: `"IBM i Member Workspace — active git branch"`
   - `command: "ibmi-member-workspace.selectGitBranch"`
   - Refresh it on: `service.onDidChange`, connection change, and after branch command runs
   - Add to `context.subscriptions`
5. Add helper `refreshGitStatusBar(item, service, gitService)` in `extension.ts` that reads
   `getCheckoutRoot()`, calls `currentBranch()`, and updates the status bar item text and visibility
6. In `CheckoutService.checkoutMember()`, after the `vscode.workspace.fs.writeFile()` call (line 211),
   add:
   ```
   if (await this.isGitEnabled()) {
     const root = this.getCheckoutRoot();
     if (root) {
       await this.gitService!.ensureRepo(root.fsPath);
       await this.gitService!.stageFile(root.fsPath, localPath);
       await this.gitService!.commit(root.fsPath,
         `checkout: ${formatMemberPath(entry)} from ${entry.system}`);
     }
   }
   ```

**Relevant Context:**
- [`src/checkoutService.ts`](src/checkoutService.ts:211) — `writeFile` call; git commit block goes
  immediately after
- [`src/extension.ts`](src/extension.ts:71) — `registerCommands()` function
- [`src/types.ts`](src/types.ts:71) — `formatMemberPath()` for commit message content
- [`src/extension.ts`](src/extension.ts:29) — `checkoutFolderContext` already used for menu visibility;
  reuse the same pattern for the branch command menu gating

**Status:** `[x] done`

---

### Sub-Task 4 — Auto-commit on upload, merge-back, and re-checkout; add manual "Commit Now" command

**Intent:**
Complete the auto-commit lifecycle by hooking upload, merge-back, and re-checkout events. Add a
`Commit Now` command for manual snapshots so developers can checkpoint local edits without waiting
for an upload.

**Expected Outcomes:**
- After successful `uploadToRemote()`: commits with message
  `upload: LIBRARY/SOURCEFILE(MEMBER) to SYSTEM`
- After successful `recheckout()`: commits with message
  `recheckout: LIBRARY/SOURCEFILE(MEMBER) from SYSTEM`
- After merge-back completes (remote side saved via `MergeHandler`): commits with message
  `merge-back: LIBRARY/SOURCEFILE(MEMBER) to SYSTEM`
- `IBM i Member Workspace: Commit Now` command appears in the context menu for a checked-out member
  in the tree view; prompts for an optional message (defaults to
  `snapshot: LIBRARY/SOURCEFILE(MEMBER)`); stages the local file and commits
- None of these fail or surface an error to the user if there is nothing to commit

**Todo List:**
1. In `CheckoutService.uploadToRemote()`, after `entry.status = "merged"` (line ~334), before
   `return "uploaded"`, add git stage+commit block:
   ```
   if (await this.isGitEnabled()) {
     const root = this.getCheckoutRoot();
     if (root) {
       await this.gitService!.stageFile(root.fsPath, entry.localPath);
       await this.gitService!.commit(root.fsPath,
         `upload: ${formatMemberPath(entry)} to ${entry.system}`);
     }
   }
   ```
2. In `CheckoutService.recheckout()`, after `vscode.workspace.fs.writeFile()` (line ~278), add
   git stage+commit block with message `recheckout: ${formatMemberPath(entry)} from ${entry.system}`
3. In `extension.ts`, locate the merge-back command handler where the remote-side document save is
   detected and the upload result is confirmed — add the same git stage+commit pattern there, using the
   entry's `localPath` and message `merge-back: ${formatMemberPath(entry)} to ${entry.system}`
4. Add command `"ibmi-member-workspace.commitNow"` to `package.json` `contributes.commands` with title
   `"IBM i Member Workspace: Commit Now"`
5. Add `"ibmi-member-workspace.commitNow"` to `package.json` `contributes.menus` under
   `"view/item/context"` for the member tree item (`viewItem == member`), visible when
   `ibmi-member-workspace:checkoutFolderConfigured`
6. Register `commitNow` command handler in `extension.ts`:
   - Accept a `TreeItemType` (member kind)
   - Show `vscode.window.showInputBox({ prompt: "Commit message (leave blank for default)", placeHolder: "snapshot: MYLIB/QRPGLESRC(PAYROLL)" })`
   - Use default message if input is blank
   - Get `checkoutRoot`, call `gitService.stageFile()` + `gitService.commit()`
   - Show info message on success: `"Committed snapshot of LIBRARY/SOURCEFILE(MEMBER)"`
   - Guard with `isGitEnabled()` — if not enabled, inform user to enable `gitIntegration` setting

**Relevant Context:**
- [`src/checkoutService.ts`](src/checkoutService.ts:321) — `uploadToRemote()` success path
- [`src/checkoutService.ts`](src/checkoutService.ts:270) — `recheckout()` method
- [`src/mergeHandler.ts`](src/mergeHandler.ts) — merge-back handler; read this file to locate where
  upload completion is signalled back to the command handler in `extension.ts`
- [`src/extension.ts`](src/extension.ts) — `mergeBack` command registration; the merge completion
  callback is where the git commit belongs
- `view/item/context` menu pattern is already used throughout `package.json` for other member commands;
  follow the same `when` clause pattern

**Status:** `[x] done`

---

### Sub-Task 5 — `.gitignore` content and README documentation

**Intent:**
When the git repo is initialized in the checkout root, write a sensible `.gitignore`. Update the README
with a full "Git Integration" section so users understand the feature, how to enable it, and what the
workflow looks like.

**Expected Outcomes:**
- `.gitignore` written to the checkout root on `ensureRepo()` contains OS/editor noise patterns but does
  NOT ignore any IBM i member file extensions — those are the tracked content
- `README.md` has a new "Git Integration" section after the "Settings" section covering:
  - How to enable (`gitIntegration` setting)
  - The `Select Git Branch` command and how it maps to projects/tickets
  - The `Commit Now` command
  - What is committed automatically and what the commit messages look like
  - A step-by-step workflow example

**`.gitignore` content (to be written by `ensureRepo()`):**
```
# OS / editor noise
.DS_Store
Thumbs.db
desktop.ini
*.log

# IBM i member files are intentionally tracked — do not add patterns for them
```

**Todo List:**
1. In `GitService.ensureRepo()` (Sub-Task 1, step 7), write the `.gitignore` file with the content above
   using `vscode.workspace.fs.writeFile` (or `fs.writeFileSync`) before running `git init`
2. In `README.md`, add a "## Git Integration" section immediately after the "## Settings" section
   (after line 84) with:
   - Prerequisites note: git must be installed and on PATH
   - How to enable: set `ibmi-member-workspace.gitIntegration` to `true` in VS Code settings
   - "The extension creates one git repository in your checkout folder. Each project or ticket gets its
     own branch."
   - "Use **IBM i Member Workspace: Select Git Branch** from the Command Palette or panel toolbar to
     create or switch branches at any time."
   - Automatic commit events table: checkout / upload / merge-back / re-checkout
   - "Use **Commit Now** (right-click a checkout) to manually snapshot local edits."
   - Workflow example (5 steps: enable setting → select branch → check out member → edit → upload →
     inspect history in VS Code Source Control)
3. Add `ibmi-member-workspace.gitIntegration` row to the settings table in `README.md`

**Relevant Context:**
- [`README.md`](README.md:80) — settings table; "## Settings" section ends around line 84
- [`src/gitService.ts`](src/gitService.ts) — `ensureRepo()` from Sub-Task 1; `.gitignore` is written
  here before `git init` so the first commit captures it
- No new source files needed for this sub-task — it is documentation + content strings

**Status:** `[x] done`

---

## Implementation Order

```
Sub-Task 1 → Sub-Task 2 → Sub-Task 3 → Sub-Task 4 → Sub-Task 5
```

Sub-Tasks 1 and 2 are pure infrastructure with no user-visible changes.
Sub-Tasks 3 and 4 add the visible behaviour and depend on 1 and 2.
Sub-Task 5 (docs + `.gitignore` content) finalizes the feature and can be done last.
