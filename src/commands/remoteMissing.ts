import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { errorMessage } from "../errors";
import { CheckedOutMember, formatMemberPath, isReferenceCopy } from "../types";

/**
 * Tells the user that checkouts no longer exist on the IBM i (deleted, renamed or moved) and offers
 * to stop tracking them. The local files are never touched: the member may come back, or the file
 * may be the only copy left.
 */
export async function reportRemoteMissing(service: CheckoutService, entries: readonly CheckedOutMember[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const remove = "Remove from Checkouts";
  const keep = "Keep";
  const message = entries.length === 1
    ? `${isReferenceCopy(entries[0]) ? "The reference copy " : ""}${formatMemberPath(entries[0])} no longer exists on the IBM i. Your local copy is kept.`
    : `${entries.length} checked-out members no longer exist on the IBM i: ${entries.map((entry) => entry.memberName).join(", ")}. Your local copies are kept.`;
  const choice = await vscode.window.showWarningMessage(
    message,
    { detail: entries.length === 1 ? entries[0].localPath : "Remove from Checkouts stops tracking them; the files stay on disk." },
    remove,
    keep
  );
  if (choice !== remove) {
    return;
  }
  try {
    await service.forgetEntries([...entries]);
  } catch (err) {
    vscode.window.showErrorMessage(`${remove} failed: ${errorMessage(err)}`);
  }
}
