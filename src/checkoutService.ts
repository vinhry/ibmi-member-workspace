import * as vscode from "vscode";
import {
  CheckedOutMember,
  CheckoutIndex,
  RefreshTally,
  buildCheckoutId,
  buildLocalFileName,
  emptyTally,
  formatMemberPath,
  parseCheckoutIndex,
  sanitizeSystemName,
} from "./types";
import {
  downloadMemberContent,
  uploadMemberContent,
  getSystemName,
} from "./codeForIBMi";
import { CheckoutCancelledError, errorMessage } from "./errors";
import { RemoteStatus, classifyStatus, hashContent } from "./sync";

export type UploadResult = "uploaded" | "failed" | "remote-changed";

type RefreshProgress = vscode.Progress<{ message?: string; increment?: number }>;

export class CheckoutService implements vscode.Disposable {
  private index: CheckoutIndex = { version: 1, entries: [] };
  private storageUri: vscode.Uri;
  private checkoutsUri: vscode.Uri;
  private indexUri: vscode.Uri;
  private indexTempUri: vscode.Uri;

  private batchDepth = 0;
  private dirty = false;
  private saveQueue: Promise<void> = Promise.resolve();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    this.storageUri = context.globalStorageUri;
    this.checkoutsUri = vscode.Uri.joinPath(this.storageUri, "checkouts");
    this.indexUri = vscode.Uri.joinPath(this.storageUri, "checkout-index.json");
    this.indexTempUri = vscode.Uri.joinPath(this.storageUri, "checkout-index.json.tmp");
  }

  async initialize(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.checkoutsUri);
    } catch {
      // already exists
    }
    await this.loadIndex();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Runs `fn` with index saves deferred until it finishes, so a batch
   * operation writes the index once instead of once per member.
   */
  async runBatch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth++;
    try {
      return await fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirty) {
        await this.saveIndex();
      }
    }
  }

  getEntriesForSystem(system: string): CheckedOutMember[] {
    return this.index.entries.filter(
      (e) => e.system.toUpperCase() === system.toUpperCase()
    );
  }

  findEntry(
    system: string,
    library: string,
    sourceFile: string,
    memberName: string
  ): CheckedOutMember | undefined {
    const id = buildCheckoutId(system, library, sourceFile, memberName);
    return this.index.entries.find((e) => e.id === id);
  }

  async checkoutMember(
    library: string,
    sourceFile: string,
    memberName: string,
    memberExtension: string,
    options?: { redownloadBehavior?: "ask" | "skip" | "force"; suppressAutoOpen?: boolean }
  ): Promise<CheckedOutMember> {
    const { redownloadBehavior = "ask", suppressAutoOpen = false } = options ?? {};

    const system = getSystemName();
    if (!system) {
      throw new Error("Not connected to IBM i");
    }

    const existing = this.findEntry(system, library, sourceFile, memberName);
    if (existing) {
      if (redownloadBehavior === "skip") {
        return existing;
      }

      if (redownloadBehavior === "ask") {
        const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
        const warn = config.get<boolean>("warnOnRedownload", true);

        if (warn) {
          const choice = await vscode.window.showWarningMessage(
            `${formatMemberPath(existing)} is already checked out since ${new Date(existing.checkedOutAt).toLocaleDateString()}. What would you like to do?`,
            "Open Existing",
            "Re-download",
            "Cancel"
          );

          if (choice === "Open Existing") {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(existing.localPath)
            );
            await vscode.window.showTextDocument(doc);
            return existing;
          }

          if (choice !== "Re-download") {
            throw new CheckoutCancelledError();
          }
        }
      }
      // redownloadBehavior === "force" falls through to re-download below
    }

    const content = await downloadMemberContent(
      library,
      sourceFile,
      memberName
    );

    const entry: CheckedOutMember = {
      id: buildCheckoutId(system, library, sourceFile, memberName),
      system,
      library: library.toUpperCase(),
      sourceFile: sourceFile.toUpperCase(),
      memberName: memberName.toUpperCase(),
      extension: memberExtension.toLowerCase(),
      localPath: "",
      checkedOutAt: new Date().toISOString(),
      remoteHashAtCheckout: "",
      status: "checked-out",
    };

    const localPath = await this.getLocalPath(entry);
    entry.localPath = localPath;

    const hash = this.hash(content, vscode.Uri.file(localPath));
    entry.remoteHashAtCheckout = hash;

    this.log.appendLine(
      `[checkout] ${library}/${sourceFile}/${memberName}  remoteHashAtCheckout=${hash.substring(0, 12)}`
    );

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(localPath),
      Buffer.from(content, "utf-8")
    );

    if (existing) {
      const idx = this.index.entries.findIndex((e) => e.id === entry.id);
      this.index.entries[idx] = entry;
    } else {
      this.index.entries.push(entry);
    }

    await this.persist();

    if (!suppressAutoOpen) {
      const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
      if (config.get<boolean>("autoOpenOnCheckout", true)) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(localPath)
        );
        await vscode.window.showTextDocument(doc);
      }

      vscode.window.showInformationMessage(
        `Checked out ${formatMemberPath(entry)} from ${system}`
      );
    }

    return entry;
  }

  async refreshRemoteStatus(entry: CheckedOutMember): Promise<RemoteStatus> {
    const localUri = vscode.Uri.file(entry.localPath);

    const remoteContent = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const remoteHash = this.hash(remoteContent, localUri);
    const localHash = this.hash(await this.readLocal(localUri), localUri);

    const status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);

    this.log.appendLine(
      `[refresh] ${entry.library}/${entry.sourceFile}/${entry.memberName}` +
      `  local=${localHash.substring(0, 12)}` +
      `  remote=${remoteHash.substring(0, 12)}` +
      `  baseline=${entry.remoteHashAtCheckout?.substring(0, 12)}` +
      `  → ${status}`
    );

    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    await this.persist();

    return status;
  }

  async recheckout(entry: CheckedOutMember): Promise<void> {
    const content = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const hash = this.hash(content, vscode.Uri.file(entry.localPath));

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(entry.localPath),
      Buffer.from(content, "utf-8")
    );

    entry.remoteHashAtCheckout = hash;
    entry.checkedOutAt = new Date().toISOString();
    entry.lastCheckedAt = entry.checkedOutAt;
    entry.status = "in-sync";
    await this.persist();
  }

  /**
   * Overwrites the remote member with the local copy. Unless
   * `overwriteRemoteChanges` is set, refuses (returning "remote-changed")
   * when the member was changed on the IBM i since it was checked out.
   */
  async uploadToRemote(
    entry: CheckedOutMember,
    options?: { overwriteRemoteChanges?: boolean }
  ): Promise<UploadResult> {
    const localUri = vscode.Uri.file(entry.localPath);
    const localContent = await this.readLocal(localUri);
    const localHash = this.hash(localContent, localUri);

    if (!options?.overwriteRemoteChanges) {
      const remoteContent = await downloadMemberContent(
        entry.library,
        entry.sourceFile,
        entry.memberName
      );
      const remoteHash = this.hash(remoteContent, localUri);
      if (remoteHash !== entry.remoteHashAtCheckout && remoteHash !== localHash) {
        this.log.appendLine(
          `[upload] ${formatMemberPath(entry)} changed on the remote since checkout — not uploaded`
        );
        entry.status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);
        entry.lastCheckedAt = new Date().toISOString();
        await this.persist();
        return "remote-changed";
      }
    }

    const success = await uploadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName,
      localContent
    );

    if (!success) {
      return "failed";
    }

    entry.remoteHashAtCheckout = localHash;
    entry.lastCheckedAt = new Date().toISOString();
    entry.status = "merged";
    await this.persist();
    return "uploaded";
  }

  async refreshSourceFileRemoteStatus(
    system: string,
    library: string,
    sourceFile: string,
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const entries = this.getEntriesForSystem(system).filter(
      (e) =>
        e.library.toUpperCase() === library.toUpperCase() &&
        e.sourceFile.toUpperCase() === sourceFile.toUpperCase()
    );
    return this.refreshEntries(entries, progress, token);
  }

  async refreshAllRemoteStatus(
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const system = getSystemName();
    if (!system) {
      return emptyTally();
    }

    return this.refreshEntries(this.getEntriesForSystem(system), progress, token);
  }

  async refreshEntries(
    entries: CheckedOutMember[],
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const tally = emptyTally();

    await this.runBatch(async () => {
      for (let i = 0; i < entries.length; i++) {
        if (token?.isCancellationRequested) {
          break;
        }
        const entry = entries[i];
        progress?.report({ message: `${entry.memberName} (${i + 1}/${entries.length})` });
        try {
          const result = await this.refreshRemoteStatus(entry);
          switch (result) {
            case "in-sync":
              tally.inSync++;
              break;
            case "modified":
              tally.modified++;
              break;
            case "remote-changed":
              tally.remoteChanged++;
              break;
            case "conflict":
              tally.conflict++;
              break;
          }
        } catch (err) {
          tally.errors++;
          this.log.appendLine(`[refresh] Error for ${formatMemberPath(entry)}: ${errorMessage(err)}`);
        }
        progress?.report({ increment: 100 / entries.length });
      }
    });

    return tally;
  }

  async discardCheckout(entry: CheckedOutMember): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Delete ${formatMemberPath(entry)} and remove from checkouts?`,
      { detail: "Make sure you've already merged any changes back to the IBM i.", modal: true },
      "Delete"
    );

    if (choice !== "Delete") {
      return;
    }

    await this.discardEntries([entry]);
  }

  async discardEntries(entries: CheckedOutMember[]): Promise<void> {
    for (const entry of entries) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(entry.localPath));
      } catch {
        // file may already be gone
      }
    }

    const ids = new Set(entries.map((e) => e.id));
    this.index.entries = this.index.entries.filter((e) => !ids.has(e.id));
    await this.persist();
  }

  private hash(content: string, resource: vscode.Uri): string {
    const trimTrailingWhitespace = vscode.workspace
      .getConfiguration("files", resource)
      .get<boolean>("trimTrailingWhitespace", false);
    return hashContent(content, trimTrailingWhitespace);
  }

  private async readLocal(localUri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(localUri)).toString("utf-8");
  }

  private async getLocalPath(entry: CheckedOutMember): Promise<string> {
    const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
    const customFolder = config.get<string>("localFolder", "");
    const systemFolder = sanitizeSystemName(entry.system);
    const fileName = buildLocalFileName(entry);

    let baseDir: vscode.Uri;
    if (customFolder) {
      baseDir = vscode.Uri.joinPath(
        vscode.Uri.file(customFolder),
        systemFolder, entry.library, entry.sourceFile
      );
    } else {
      baseDir = vscode.Uri.joinPath(
        this.checkoutsUri,
        systemFolder, entry.library, entry.sourceFile
      );
    }

    try {
      await vscode.workspace.fs.createDirectory(baseDir);
    } catch {
      // already exists
    }

    return vscode.Uri.joinPath(baseDir, fileName).fsPath;
  }

  private async loadIndex(): Promise<void> {
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(this.indexUri);
    } catch {
      // no index yet
      this.index = { version: 1, entries: [] };
      return;
    }

    try {
      this.index = parseCheckoutIndex(Buffer.from(data).toString("utf-8"));
    } catch (err) {
      this.index = { version: 1, entries: [] };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupUri = vscode.Uri.joinPath(this.storageUri, `checkout-index.corrupt-${stamp}.json`);
      try {
        await vscode.workspace.fs.writeFile(backupUri, data);
      } catch (backupErr) {
        this.log.appendLine(`[index] Could not back up unreadable index: ${errorMessage(backupErr)}`);
      }
      this.log.appendLine(
        `[index] ${this.indexUri.fsPath} is unreadable (${errorMessage(err)}); backed up to ${backupUri.fsPath}`
      );
      vscode.window.showWarningMessage(
        `The IBM i checkout index could not be read and was reset. A backup was saved to ${backupUri.fsPath}.`
      );
    }
  }

  /** Notifies listeners and saves the index, or defers the save while a batch is running. */
  private async persist(): Promise<void> {
    this._onDidChange.fire();
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    await this.saveIndex();
  }

  /** Writes the index atomically (temp file + rename), one write at a time. */
  private saveIndex(): Promise<void> {
    this.dirty = false;
    const data = Buffer.from(JSON.stringify(this.index, null, 2), "utf-8");
    const write = async () => {
      await vscode.workspace.fs.writeFile(this.indexTempUri, data);
      await vscode.workspace.fs.rename(this.indexTempUri, this.indexUri, { overwrite: true });
    };
    const result = this.saveQueue.then(write);
    this.saveQueue = result.catch(() => undefined);
    return result;
  }
}
