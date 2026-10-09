import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { CheckoutTreeProvider } from "../checkoutTreeProvider";
import { ProviderAvailabilityCache } from "../dependencySources";
import { GitService } from "../gitService";
import { LocalFileWatcher } from "../localFileWatcher";
import { MergeHandler } from "../mergeHandler";
import { TreeItemType } from "../types";

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
  log: vscode.OutputChannel;
  /** Which dependency providers work on each system, checked once per connection. */
  dependencyAvailability: ProviderAvailabilityCache;
}
