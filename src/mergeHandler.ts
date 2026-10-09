import * as vscode from "vscode";
import { CheckoutService, assertEditable } from "./checkoutService";
import { errorMessage } from "./errors";
import { assertNoLinkBelow } from "./localPath";
import { MergeSide, mergeEditorArguments, mergeSnapshotPaths, planMerge } from "./mergePreparation";
import { saveDirtyLocalFiles } from "./prompts";
import { CheckedOutMember, formatMemberPath } from "./types";

/** Where the snapshots a merge or comparison shows are kept, under the workspace's extension storage. */
const SNAPSHOT_DIR = "merge";

/**
 * A merge editor tab's input. `TabInputTextMerge` is still a proposed API in VS Code 1.90, so the
 * input is recognised by its fields instead of its class.
 */
function mergeTabInput(input: unknown): { base: vscode.Uri; result: vscode.Uri } | undefined {
  const candidate = input as { base?: unknown; result?: unknown } | undefined;
  return candidate?.base instanceof vscode.Uri && candidate.result instanceof vscode.Uri
    ? { base: candidate.base, result: candidate.result }
    : undefined;
}

interface OpenMerge {
  entry: CheckedOutMember;
  /** The IBM i's text the merge editor shows, adopted as the baseline when the result is saved. */
  remote: MergeSide;
  localSnapshotHash: string;
  /** Whether the result was saved over the local copy yet. */
  saved: boolean;
  /** The snapshot folder, removed when the merge editor closes. */
  dir: vscode.Uri;
}

/**
 * Merge Back, Compare with IBM i and Show Changes Since Checkout. A Merge Back opens VS Code's
 * merge editor with the member as it was at checkout (base), as it is on the IBM i now (left),
 * and the local copy (right); the result is saved over the local copy, which Upload (or upload on
 * save) then sends through the usual checks. Nothing here writes to the IBM i. The texts shown are
 * snapshot files in the extension storage, never the live local file or the member itself, so
 * editing the result can't change an input.
 */
export class MergeHandler implements vscode.Disposable {
  /** Open merge editors by the local file's fsPath. */
  private readonly merges = new Map<string, OpenMerge>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly service: CheckoutService,
    private readonly storageUri: vscode.Uri | undefined,
    private readonly log: vscode.OutputChannel
  ) {
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => this.onTabsChanged(event)),
      // Should a merge tab's input go unrecognised, the result document closing with it ends the merge.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === "file") {
          this.endMerge(doc.uri.fsPath);
        }
      })
    );
  }

  /**
   * Removes the snapshots of a previous session, unless a merge editor restored from it still
   * shows them (its save isn't tracked: the upload that follows asks about remote changes as usual).
   */
  async initialize(): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    const root = vscode.Uri.joinPath(this.storageUri, SNAPSHOT_DIR);
    const restored = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => mergeTabInput(tab.input)?.base.fsPath.startsWith(root.fsPath));
    if (restored) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
    } catch {
      // Nothing left over.
    }
  }

  /** Whether a Merge Back of the member is open and its result not yet saved. */
  hasOpenMerge(id: string): boolean {
    return [...this.merges.values()].some((merge) => merge.entry.id === id && !merge.saved);
  }

  /** How many Merge Backs are open with their result not yet saved. */
  get openMergeCount(): number {
    return [...this.merges.values()].filter((merge) => !merge.saved).length;
  }

  /**
   * Opens the merge editor for a member changed both locally and on the IBM i. When only one side
   * changed there is nothing to merge, and the matching action is offered instead. A checkout made
   * before 1.8.10 may have no text for its baseline; then the two sides are compared.
   */
  async openMergeEditor(entry: CheckedOutMember): Promise<void> {
    assertEditable(entry);
    if (!(await saveDirtyLocalFiles([entry]))) {
      return;
    }
    const memberPath = formatMemberPath(entry);
    const texts = await this.readForMerge(entry);
    if (!texts) {
      return;
    }
    const { plan } = planMerge(texts.local, texts.remote, entry.remoteHashAtCheckout, texts.baseline);
    switch (plan.kind) {
      case "in-sync":
        vscode.window.showInformationMessage(`${memberPath} is in sync with the IBM i; there is nothing to merge.`);
        return;
      case "remote-unchanged": {
        const upload = "Upload to IBM i";
        const compare = "Compare with IBM i";
        const choice = await vscode.window.showInformationMessage(
          `${memberPath} hasn't changed on the IBM i since checkout, so there is nothing to merge: Upload sends your local changes.`,
          upload,
          compare
        );
        if (choice === upload) {
          await vscode.commands.executeCommand("ibmi-member-workspace.uploadToRemote", { kind: "member", entry });
        } else if (choice === compare) {
          await this.showComparison(entry, plan.remote.text);
        }
        return;
      }
      case "local-unchanged": {
        const recheckout = "Re-checkout";
        const compare = "Compare with IBM i";
        const choice = await vscode.window.showInformationMessage(
          `Only the IBM i copy of ${memberPath} changed since checkout; your local copy has no changes. Re-checkout takes the IBM i's copy.`,
          recheckout,
          compare
        );
        if (choice === recheckout) {
          if (await this.service.hasLocalChanges(entry)) {
            vscode.window.showWarningMessage(`${memberPath} has local changes now. Run Merge Back again to combine them.`);
            return;
          }
          await this.service.recheckout(entry);
          vscode.window.showInformationMessage(`Re-checked out ${memberPath} from IBM i.`);
        } else if (choice === compare) {
          await this.showComparison(entry, plan.remote.text);
        }
        return;
      }
      case "two-way":
        vscode.window.showInformationMessage(
          `${memberPath} changed both locally and on the IBM i, but the text it had at checkout isn't kept ` +
          "(it was checked out before 1.8.10), so the two can only be compared: the IBM i's copy is on the left, " +
          "yours on the right. Edit yours, save, then upload."
        );
        await this.showComparison(entry, plan.remote.text);
        return;
      case "three-way":
        break;
    }

    const localUri = vscode.Uri.file(entry.localPath);
    // The merge editor writes the result through this path.
    this.service.assertLocalPathSafe(entry.localPath);
    const snapshots = await this.writeSnapshots(entry, { base: plan.base.text, remote: plan.remote.text, local: plan.local.text });
    this.merges.set(localUri.fsPath, {
      entry,
      remote: plan.remote,
      localSnapshotHash: plan.local.hash,
      saved: false,
      dir: snapshots.dir,
    });
    await vscode.commands.executeCommand(
      "_open.mergeEditor",
      mergeEditorArguments({ base: snapshots.base, remote: snapshots.remote, local: snapshots.local, output: localUri }, entry)
    );
    // The result starts as the local copy; this resets it to the base with both sides' changes
    // applied where they don't overlap, leaving only the conflicts to decide.
    try {
      await vscode.commands.executeCommand("mergeEditor.resetResultToBaseAndAutoMerge");
    } catch (err) {
      this.log.appendLine(`[merge] Could not auto-merge ${memberPath}; the result starts as your local copy: ${errorMessage(err)}`);
    }
  }

  /** Shows the IBM i's copy (left) against the local copy (right, editable). */
  async compareWithRemote(entry: CheckedOutMember): Promise<void> {
    const remote = await this.readRemote(entry);
    if (remote !== undefined) {
      await this.showComparison(entry, remote);
    }
  }

  /** Shows the member as it was at checkout (left) against the local copy (right, editable). */
  async showChangesSinceCheckout(entry: CheckedOutMember): Promise<void> {
    const memberPath = formatMemberPath(entry);
    const local = await this.service.readLocalText(entry);
    const baseline = await this.service.baselineText(entry, [local]);
    if (baseline === undefined) {
      const refresh = "Refresh Remote Status";
      const compare = "Compare with IBM i";
      const choice = await vscode.window.showInformationMessage(
        `The text ${memberPath} had at checkout isn't kept (it was checked out before 1.8.10). ` +
        "Refresh Remote Status keeps it while the IBM i copy is unchanged; otherwise compare with the IBM i.",
        refresh,
        compare
      );
      if (choice === refresh) {
        await vscode.commands.executeCommand("ibmi-member-workspace.refreshRemote", { kind: "member", entry });
      } else if (choice === compare) {
        await this.compareWithRemote(entry);
      }
      return;
    }
    const snapshots = await this.writeSnapshots(entry, { base: baseline });
    await vscode.commands.executeCommand(
      "vscode.diff",
      snapshots.base,
      vscode.Uri.file(entry.localPath),
      `${entry.memberName} — At checkout ↔ Local`
    );
  }

  /**
   * Called when a checkout's local file is saved. After the first save of an open merge's result,
   * the baseline is adopted (see `CheckoutService.adoptMergeBaseline`); later saves are ordinary.
   */
  async onDidSaveLocal(entry: CheckedOutMember, savedText: string): Promise<void> {
    const merge = this.merges.get(vscode.Uri.file(entry.localPath).fsPath);
    if (!merge || merge.saved) {
      return;
    }
    merge.saved = true;
    try {
      const result = await this.service.adoptMergeBaseline(entry, merge.remote, merge.localSnapshotHash, savedText);
      if (result.status !== "success" && result.status !== "noChanges") {
        vscode.window.showWarningMessage(result.message ?? "The merge was saved, but its local checkpoint failed.");
      }
    } catch (err) {
      vscode.window.showWarningMessage(`The merge was saved, but the checkout's status wasn't updated: ${errorMessage(err)}`);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async readForMerge(
    entry: CheckedOutMember
  ): Promise<{ remote: string; local: string; baseline: string | undefined } | undefined> {
    const remote = await this.readRemote(entry);
    if (remote === undefined) {
      return undefined;
    }
    const local = await this.service.readLocalText(entry);
    const baseline = await this.service.baselineText(entry, [remote, local]);
    return { remote, local, baseline };
  }

  /** The member's text on the IBM i, with progress and Cancel; undefined when cancelled. */
  private async readRemote(entry: CheckedOutMember): Promise<string | undefined> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reading ${formatMemberPath(entry)} from the IBM i...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          return await this.service.readRemoteText(entry, controller.signal);
        } catch (err) {
          if (token.isCancellationRequested) {
            return undefined;
          }
          throw err;
        }
      }
    );
  }

  private async showComparison(entry: CheckedOutMember, remoteText: string): Promise<void> {
    const snapshots = await this.writeSnapshots(entry, { remote: remoteText });
    await vscode.commands.executeCommand(
      "vscode.diff",
      snapshots.remote,
      vscode.Uri.file(entry.localPath),
      `${entry.memberName} — IBM i ↔ Local`
    );
  }

  /** Writes the given texts as the member's snapshot files and returns their locations. */
  private async writeSnapshots(
    entry: CheckedOutMember,
    texts: { base?: string; remote?: string; local?: string }
  ): Promise<{ dir: vscode.Uri; base: vscode.Uri; remote: vscode.Uri; local: vscode.Uri }> {
    if (!this.storageUri) {
      throw new Error("This workspace has no extension storage to keep the comparison's files in.");
    }
    const paths = mergeSnapshotPaths(entry);
    const dir = vscode.Uri.joinPath(this.storageUri, ...paths.dir);
    // A link planted in the storage folder must not redirect a snapshot write.
    assertNoLinkBelow(this.storageUri.fsPath, dir.fsPath);
    await vscode.workspace.fs.createDirectory(dir);
    const uris = {
      dir,
      base: vscode.Uri.joinPath(dir, paths.base),
      remote: vscode.Uri.joinPath(dir, paths.remote),
      local: vscode.Uri.joinPath(dir, paths.local),
    };
    for (const key of ["base", "remote", "local"] as const) {
      const text = texts[key];
      if (text !== undefined) {
        await vscode.workspace.fs.writeFile(uris[key], Buffer.from(text, "utf-8"));
      }
    }
    return uris;
  }

  private onTabsChanged(event: vscode.TabChangeEvent): void {
    for (const tab of event.closed) {
      const input = mergeTabInput(tab.input);
      if (input) {
        this.endMerge(input.result.fsPath);
      }
    }
  }

  /** Forgets the merge of a local file and removes its snapshots. */
  private endMerge(localFsPath: string): void {
    const merge = this.merges.get(localFsPath);
    if (!merge) {
      return;
    }
    this.merges.delete(localFsPath);
    vscode.workspace.fs.delete(merge.dir, { recursive: true, useTrash: false }).then(undefined, () => {
      // Already gone, or cleaned up at the next start.
    });
  }
}
