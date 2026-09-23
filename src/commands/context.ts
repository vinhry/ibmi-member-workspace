import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { CheckoutTreeProvider } from "../checkoutTreeProvider";
import { GitService } from "../gitService";
import { LocalFileWatcher } from "../localFileWatcher";
import { MergeHandler } from "../mergeHandler";
import { CheckedOutMember, TreeItemType } from "../types";

/** Everything command handlers need, created once in `activate`. */
export interface CommandContext {
  context: vscode.ExtensionContext;
  service: CheckoutService;
  treeProvider: CheckoutTreeProvider;
  mergeHandler: MergeHandler;
  treeView: vscode.TreeView<TreeItemType>;
  fileWatcher: LocalFileWatcher;
  gitService: GitService;
  refreshGitStatusBar: () => Promise<void>;
  /** Member documents opened by Merge Back, keyed by `mergeDocumentKey`, awaiting their save. */
  pendingMergeBacks: Map<string, CheckedOutMember>;
  log: vscode.OutputChannel;
}
