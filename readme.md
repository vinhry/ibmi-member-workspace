# IBM i Member Workspace

<p>
  <img src="images/icon.png" alt="IBM i Member Workspace logo" width="128">
</p>

Bring IBM i source members into a local workspace, edit them offline, and synchronize changes safely using VS Code's built-in diff editor. Works with [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi).

> **Project origin:** IBM i Member Workspace is an independently maintained project derived from [IBMi Source Member Checkout](https://github.com/thomprl/ibmi-source-member-checkout), originally created by Ricky Thompson. It is distributed under GPL-3.0; see [NOTICE](NOTICE) for attribution.

## Why?

Editing source members directly through Code for IBM i saves straight to the IBM i on every keystroke-save. This extension lets you **check out a local copy**, work at your own pace, and **merge changes back** when ready — with full diff support and source date preservation. This allows AI tools to work with your source files locally.

Before the first checkout in each VS Code workspace, choose a visible local folder for member files. The extension never silently stores checked-out members inside its installation or private storage.

## First-Time Setup

1. Open a folder or `.code-workspace` file in VS Code.
2. When prompted, select **Choose Folder**, or run **IBM i Member Workspace: Configure Checkout Folder** from the Command Palette.
3. Select the directory that should contain checked-out members for this workspace.

The folder selection and checkout index are private to the current VS Code workspace and are not written to `.vscode/settings.json`. To change the folder later, first merge or discard every tracked checkout, then run **Configure Checkout Folder** again.

## Features

### Check Out Members

Right-click a member in the Code for IBM i Object Browser and choose **Check Out Member**. The source downloads to a local file (named after the member, e.g. `EXAMPLE.RPGLE`, for correct compilation) organized by system, library, and source file, and shows up in the **Checked Out Members** panel.

Select multiple members (Ctrl/Shift-click) before checking out, and they're all downloaded together — if any are already checked out, you're asked once whether to re-download or skip them.

### Check Out All Members

Right-click a **source file** (one level above members) and choose **Check Out All Members** to pull down every member it contains in one go. Since this can mean a lot of members, a confirmation dialog warns that it may take a while before starting.

### Protected Filter Members

Checkout is hidden by default for members in a protected (read-only) filter. Enable `ibmi-member-workspace.allowCheckoutFromProtectedFilter` to allow it when you deliberately want a local working copy of a protected source.

### Merge Back to IBM i

Right-click a checkout and choose **Merge Back to IBM i** to open a diff view — your local changes on the left, the live remote member on the right. Use VS Code's merge arrows to selectively apply changes, then save the remote side; Code for IBM i handles the upload and **preserves source dates**.

### Upload to IBM i

For a quick full replace, use **Upload to IBM i**. This overwrites the remote member with your local copy. A warning confirms that **source dates will not be preserved**.

Before uploading, the extension checks whether the member has changed on the IBM i since you checked it out. If it has, you're asked to **Overwrite Anyway** or **Show Diff** instead of silently losing the remote changes. In a multi-member upload, members changed on the IBM i are skipped and listed in the IBM i Member Workspace output panel.

After uploading, the member is read back from the IBM i. If what was stored differs from your local file (for example, a line longer than the record length was truncated), you're warned and the checkout stays **Modified** so you can review it with Merge Back.

### Refresh Remote Status

Compares your local file, the live remote content, and the remote content as it was at checkout time (not just a stale comparison) to classify each checkout:

- **In sync** — local matches remote exactly
- **Modified** — you've edited locally; remote is unchanged (safe — nothing to lose)
- **Remote changed** — the member changed on the IBM i but your local copy is untouched (safe to re-checkout)
- **Conflict** — changed both locally *and* on the IBM i (re-checkout would discard your edits — review with Merge Back first)

Local edits update the status to **Modified** automatically, whether you save in VS Code or another tool (an AI assistant, a script, git) writes the file. Saving the remote member from VS Code (from **Show Diff** or **Open Remote File**) also re-checks it. Changes made on the IBM i itself are only detected by a refresh.

Refresh per member (inline icon or context menu, with a prompt to Re-checkout or review the diff when the remote has changed), per source file group, or for every checkout at once from the panel toolbar. Bulk refreshes show per-member progress and can be cancelled.

### Compare With

Right-click a checkout for comparison tools: **Select for Compare** (mark one checkout, then **Compare with Selected** on another), **Compare with Active File**, **Compare with Local File**, **Compare with IFS File**, or **Compare with Member** (any source member by path).

### Other Actions

- **Open Local File** / **Open Remote File** — open either copy in the editor
- **Run Action** — trigger Code for IBM i's local source actions (compile, deploy, etc.)
- **Reveal in File Explorer** — show the local file in your OS file manager
- **Copy Member Path** — copy `LIBRARY/SOURCEFILE(MEMBER)` to the clipboard
- **Discard Checkout** — delete the local file and stop tracking it (with confirmation)

### Multi-Select

The Checked Out Members panel supports selecting multiple checkouts at once. **Open Local/Remote File, Run Action, Upload to IBM i, Refresh Remote Status,** and **Discard Checkout** all work on a multi-selection, each confirming with a message naming how many members the action will affect before proceeding. Actions that only make sense for one item at a time (Merge Back, Compare With, Copy Member Path, Reveal in File Explorer) are single-selection only.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ibmi-member-workspace.warnOnRedownload` | `true` | Show warning when checking out a member that is already checked out. |
| `ibmi-member-workspace.autoOpenOnCheckout` | `true` | Automatically open the file in the editor after a single-member checkout. |
| `ibmi-member-workspace.allowCheckoutFromProtectedFilter` | `false` | Allow checking out members from protected (read-only) filters. |
| `ibmi-member-workspace.gitIntegration` | `false` | Keep local checkpoints organized by work item in one Git repository per IBM i system. Does not upload or push changes. |

## Local Change History

Local Change History keeps checkpoints of IBM i source members on your computer. It uses Git internally, but you do not need to know Git commands. A **work item** is a separate line of work for a ticket or project, and a **checkpoint** is a saved point you can return to later.

Local Change History does not upload members to IBM i and does not send files to a Git server. Use **Upload to IBM i** or **Merge Back to IBM i** separately when you are ready.

### Prerequisites

- Git must be installed and on your system PATH.
- A checkout container must be configured for the workspace.

### Set Up

Run **IBM i Member Workspace: Set Up Local Change History**, or enable `ibmi-member-workspace.gitIntegration` in VS Code Settings. The selected folder (for example, `checkout`) is the **checkout container**. Each system working directory (for example, `checkout/alex.acklie.com`) is its own Git repository. Existing repositories at that exact system directory are adopted without changing their commits, branches, configuration, or remotes. If Git does not already know your name and email, the extension asks for them and saves them only in that system repository.

### Work Items

Use **IBM i Member Workspace: Switch Work Item** from the Command Palette, panel toolbar, or status bar.

- **Start New Work Item** — enter a ticket or project name such as `TICKET-123` or `payroll-fix`.
- **Switch Work Item** — select a previously created work item.
- The active work item appears in the status bar and in the Checked Out Members panel header:

```text
Status bar shows                    What happens on the next checkout
─────────────────────────────────   ────────────────────────────────────────────
No Work Item  (highlighted)         You are asked to start or choose a work item
Work Item: TICKET-1                 The member is saved in TICKET-1
```

Every checkout belongs to a work item, so members from different tickets are never mixed:

- While no work item is selected, checking out a member first asks you to start one or choose an existing one. Cancelling cancels the checkout.
- The first checkout in each VS Code session asks you to confirm the active work item, so a checkout never goes into the previous ticket by accident. Choosing a work item with **Switch Work Item** counts as confirming it.
- A new work item starts empty: it does not include another work item's members.

Before switching, the extension asks you to save open editors and checkpoint local changes. It never discards changes automatically. Work items cannot be changed while a checkout, upload, or Merge Back is in progress. Each work item has its own checked-out-member list and synchronization baselines.

#### How a checkout chooses its work item

```text
 Check Out Member  /  Check Out All Members
                 │
                 ▼
 Local Change History enabled? ───── no ────▶ Check out without history
                 │ yes
                 ▼
 A work item is selected? ────────── no ──────────┐
                 │ yes                            │
                 ▼                                │
 Already confirmed in this                        │
 VS Code session? ────────────────── no ──────────┤
                 │ yes                            ▼
                 │                ┌──────────────────────────────────────┐
                 │                │  Which work item is this checkout    │
                 │                │  for?                                │
                 │                │   > Continue in TICKET-1  (*)        │
                 │                │   + Start New Work Item...           │
                 │                │   > TICKET-2              (switch)   │
                 │                └──────────────────────────────────────┘
                 │                     │ chosen                │ Esc
                 ▼                     ▼                       ▼
 Download the member(s)  ◀─────────────┘               Checkout cancelled
                 │
                 ▼
 Save a checkpoint on the work item
 (one checkpoint for a multi-member checkout)

 (*) Offered only when a work item is already selected.
```

#### Starting a new work item

A new work item starts from the repository's clean first commit, so it holds only the members you check out for that ticket:

```text
 Before 1.2.0 — TICKET-2 was created from TICKET-1 and inherited its members

   init ──● PAYROLL ──● TAXCALC                    TICKET-1 = PAYROLL, TAXCALC
                      └──● INVOICE                 TICKET-2 = PAYROLL, TAXCALC, INVOICE   ✗ mixed

 Since 1.2.0 — every new work item starts empty

   init ─┬─● PAYROLL ──● TAXCALC                   TICKET-1 = PAYROLL, TAXCALC
         └─● INVOICE                               TICKET-2 = INVOICE                     ✓ separate
```

If the current work item already has members, you choose how the new one begins:

```text
 Start New Work Item "TICKET-2"
            │
            ├──▶ Start empty            (default)  TICKET-2 has no members.
            │                                      TICKET-1 keeps its own.
            │
            ├──▶ Copy current members              TICKET-2 starts with a copy of
            │                                      the current members.
            │
            └──▶ Move current members              Only when no work item was selected:
                                                   the members checked out without a
                                                   work item become TICKET-2.
```

Upgrading from 1.1.x: members you checked out without choosing a work item stay under **No Work Item**. On your next checkout, choose **Start New Work Item**, enter the ticket, and pick **Move current members** to put them into that ticket.

### Moving Members to Another Work Item

If members were checked out into the wrong work item, select them, right-click, and choose **Move to Work Item…**. Pick an existing work item or start a new one. Each member's local file, including edits not yet sent to the IBM i, and its synchronization status move together. You stay in the current work item unless you choose **Switch to** afterwards.

```text
 Move PAYROLL from TICKET-1 to TICKET-2

   1. TICKET-1   Save a checkpoint of pending changes (you are asked first)
   2. TICKET-2   Add PAYROLL with its local edits and    ── "move: … from TICKET-1"
                 synchronization status
   3. TICKET-1   Remove PAYROLL                          ── "move: … to TICKET-2"
   4.            Stay on TICKET-1, or choose "Switch to TICKET-2"

 PAYROLL is added to TICKET-2 before it is removed from TICKET-1.
 If a step fails, it is in both work items — never in neither.
```

A member cannot be moved to a work item that already has it; discard it there first.

### Automatic Checkpoints

The following events save a checkpoint on the active work item:

| Event | Checkpoint description |
|-------|---------------|
| Member checked out | `checkout: LIBRARY/SOURCEFILE(MEMBER) from SYSTEM` |
| Several members checked out together | `checkout: N members of LIBRARY/SOURCEFILE from SYSTEM` (one checkpoint for the batch) |
| Member uploaded to IBM i | `upload: LIBRARY/SOURCEFILE(MEMBER) to SYSTEM` |
| Several members uploaded together | `upload: N members to SYSTEM` (one checkpoint for the batch) |
| Member re-checked out | `recheckout: LIBRARY/SOURCEFILE(MEMBER) from SYSTEM` |
| Merge-back saved | `merge-back: LIBRARY/SOURCEFILE(MEMBER) to SYSTEM` |
| Checkout discarded | `discard: LIBRARY/SOURCEFILE(MEMBER)` |
| Members moved to another work item | `move: … from WORKITEM` in the target, `move: … to WORKITEM` in the source |

If a file has not changed since its last checkpoint, no duplicate checkpoint is created. Checkpoints are never saved while the repository is on a detached commit (for example, after checking out an old commit in Source Control); use **Switch Work Item** to return to a work item.

### Manual Checkpoints

Right-click a checkout and choose **Save Checkpoint**. Add an optional description or leave it blank to use `snapshot: LIBRARY/SOURCEFILE(MEMBER)`. This only saves local history; it does not upload to IBM i.

### Workflow Example

1. Run **Set Up Local Change History** and provide a name and email if requested.
2. Check out a member. When asked which work item it belongs to, choose **Start New Work Item** and enter your ticket, such as `TICKET-4821`. You can also run **Switch Work Item** first.
3. Check out and edit the other members you need.
4. Use **Save Checkpoint** whenever you want an intermediate recovery point.
5. Upload or merge back when ready; successful lifecycle actions create automatic checkpoints.
6. Use **View Local History** to open VS Code's Source Control view.
7. For the next ticket, start a new work item. It begins empty, and the members of `TICKET-4821` stay in that work item.

If setup or a checkpoint fails, the notification explains the required action. Detailed Git diagnostics are available in the **IBM i Member Workspace** output panel.

## Local File Structure

```text
<checkout container>/
  myhost.company.com/
    .git/                 # repository for this IBM i system only
    MYLIB/
      QRPGLESRC/
        PAYROLL.RPGLE
      QCLSRC/
        PAYROLLC.CLLE
```

Organizing by system, library, and source file preserves the original filename for compilation and prevents collisions across different IBM i systems.

### Repository-layout recovery

Version 1.1.0 originally created `.git` at the checkout container in some installations. When that known layout is detected, the extension inspects it before offering repair. Safe repair adopts or initializes each system repository, restores missing valid work-item branches from that system repository's current history, and never rewrites child history or changes remotes.

After repair, choose **Archive Misplaced Repository** to rename the container's `.git` to a timestamped backup. The generated container `.gitignore` is archived only when it is unchanged. Nothing is deleted, and the notification lists the backup paths; rename them back to `.git` and `.gitignore` to restore the old layout. If unrelated files or commits are present, automated repair stops and the parent repository is left untouched for manual recovery.

Unrelated changes in a system repository are never included in automatic checkpoints. Commit or stash them in VS Code Source Control before switching work items.

## Requirements

- VS Code 1.90 or later
- [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi) v3.0.0 or later
- Active connection to an IBM i system

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or later (includes npm)
- VS Code 1.90 or later, with [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi) installed

### Build

```sh
git clone https://github.com/vinhry/ibmi-member-workspace.git
cd ibmi-member-workspace
npm ci             # install the locked dependencies
npm run compile    # compile TypeScript into out/
```

Other useful scripts:

| Command | What it does |
|---------|--------------|
| `npm run watch` | Recompile automatically whenever a source file changes |
| `npm run lint` | Check the source with ESLint |
| `npm test` | Compile and run the unit tests |
| `npm run package:list` | Preview the files that will be included in the VSIX |
| `npm run package` | Compile and build the installable VSIX |

### Run Without Installing (Development)

1. Open the project folder in VS Code.
2. In a terminal, run `npm run watch` and leave it running.
3. Press **F5**. When asked to pick a debugger, choose **VS Code Extension Development**.
4. A second VS Code window titled **[Extension Development Host]** opens with the extension loaded. Connect to your IBM i there to try it out.
5. After changing code, press **Ctrl+R** (**Cmd+R** on macOS) in that window to reload it.

### Package and Install

1. Package the extension as a `.vsix` file:

   ```sh
   npm run package
   ```

   This compiles the project and creates `ibmi-member-workspace-<version>.vsix` in the project folder.

2. Install the `.vsix` using either of these:
   - **From VS Code:** open the Extensions view (**Ctrl+Shift+X** / **Cmd+Shift+X**), click the **...** menu at the top of the view, choose **Install from VSIX...**, and select the file.
   - **From a terminal:**

     ```sh
     code --install-extension ibmi-member-workspace-<version>.vsix
     ```

     On macOS, if `code` isn't found, open the Command Palette in VS Code and run **Shell Command: Install 'code' command in PATH**.

3. Reload VS Code when prompted. The **Member Workspace** icon appears in the Activity Bar once you connect to an IBM i.

To update, package and install the new `.vsix` the same way; it replaces the installed version. To remove the extension, find **IBM i Member Workspace** in the Extensions view and choose **Uninstall**.

### Moving from Another Checkout Extension

IBM i Member Workspace has its own command IDs, settings, views, and extension storage. It can be enabled alongside the original extension, but it does not import or share checkout metadata.

1. Finish or back up any local work in the original extension.
2. Install **IBM i Member Workspace** from the Marketplace or its VSIX.
3. Open your VS Code workspace and choose its checkout folder when prompted.
4. Check out the members you want this extension to track.

Do not configure two checkout extensions to use the same local folder. Existing files are not tracked until they are checked out with IBM i Member Workspace, and each VS Code workspace maintains its own checkout index.

## Releases

The public source for each release is tagged in this repository. Release VSIX files are also attached to [GitHub Releases](https://github.com/vinhry/ibmi-member-workspace/releases). The Marketplace extension ID is `vinhry.ibmi-member-workspace`.

## Support

Report problems and request features through the [IBM i Member Workspace issue tracker](https://github.com/vinhry/ibmi-member-workspace/issues). This project is maintained and supported independently.

## License and Attribution

GPL-3.0. This project is derived from GPL-licensed work; see [NOTICE](NOTICE) for its origin and maintenance information.
