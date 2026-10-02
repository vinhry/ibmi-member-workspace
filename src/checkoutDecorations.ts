import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { decorationFor } from "./statusDecorations";

/** Shows each checked-out file's sync status in the Explorer and on editor tabs (see `statusDecorations.ts`). */
export class CheckoutDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly service: CheckoutService) {
    // Statuses change in batches; asking again for every shown file also clears discarded checkouts.
    this.subscription = service.onDidChange(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const entry = this.service.findEntryByLocalPath(uri.fsPath);
    const decoration = entry && decorationFor(entry);
    return decoration && new vscode.FileDecoration(
      decoration.badge,
      decoration.tooltip,
      decoration.colorId ? new vscode.ThemeColor(decoration.colorId) : undefined
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
