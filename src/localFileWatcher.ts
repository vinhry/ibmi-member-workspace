import * as fs from "node:fs";
import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { errorMessage } from "./errors";
import { formatMemberPath } from "./types";

const debounceMs = 300;

/**
 * Watches the checkout folder so edits made outside VS Code (AI tools, scripts,
 * git) update a checkout's status just like a save in the editor does, and a
 * deleted local file shows up in the checkout view right away.
 */
export class LocalFileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly service: CheckoutService,
    private readonly log: vscode.OutputChannel
  ) {}

  /** Starts watching `root` (replacing any previous watch), or stops watching when undefined. */
  setRoot(root: vscode.Uri | undefined): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!root) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*")
    );
    this.watcher.onDidChange((uri) => this.schedule(uri));
    this.watcher.onDidCreate((uri) => this.schedule(uri));
    this.watcher.onDidDelete((uri) => this.schedule(uri));
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  /** Coalesces bursts of writes to one file into a single status update. */
  private schedule(uri: vscode.Uri): void {
    // Local Change History keeps a .git directory per system; its internals are never checkouts.
    if (uri.path.split("/").includes(".git")) {
      return;
    }
    const key = uri.fsPath;
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.update(key);
      }, debounceMs)
    );
  }

  private async update(localPath: string): Promise<void> {
    const entry = this.service.findEntryByLocalPath(localPath);
    if (!entry) {
      return;
    }
    if (!fs.existsSync(localPath)) {
      // Shows the checkout as "local file missing"; Refresh offers Re-checkout or Remove.
      this.service.notifyLocalFileChanged();
      return;
    }
    try {
      await this.service.updateStatusFromLocalFile(entry);
    } catch (err) {
      this.log.appendLine(`[status] Could not update ${formatMemberPath(entry)}: ${errorMessage(err)}`);
    }
  }
}
