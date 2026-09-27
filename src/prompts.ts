import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { errorMessage } from "./errors";
import { CheckedOutMember, TreeItemType, storedEntryFor } from "./types";

/** The stored checkout a command's tree-item argument refers to; see {@link storedEntryFor}. */
export function resolveMember(service: CheckoutService, item: TreeItemType | undefined): CheckedOutMember | undefined {
  return storedEntryFor(item, (system) => service.getEntriesForSystem(system));
}

export function resolveMemberSelections(
  service: CheckoutService,
  item: TreeItemType,
  allSelections?: TreeItemType[]
): Extract<TreeItemType, { kind: "member" }>[] {
  const selections = allSelections && allSelections.length > 1 ? allSelections : [item];
  return selections.flatMap((selection) => {
    const entry = resolveMember(service, selection);
    return entry ? [{ kind: "member" as const, entry }] : [];
  });
}

/**
 * Offers to save open editors with unsaved edits to the given checkouts, so
 * operations that read the local file see what the user sees. Returns false if
 * the user cancels.
 */
export async function saveDirtyLocalFiles(entries: CheckedOutMember[]): Promise<boolean> {
  const paths = new Set(entries.map((e) => vscode.Uri.file(e.localPath).fsPath));
  const dirty = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && doc.uri.scheme === "file" && paths.has(doc.uri.fsPath)
  );
  if (dirty.length === 0) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    dirty.length === 1
      ? `${vscode.workspace.asRelativePath(dirty[0].uri)} has unsaved changes.`
      : `${dirty.length} checked-out files have unsaved changes.`,
    { modal: true, detail: "Save them before continuing so the IBM i is compared with your latest edits." },
    "Save and Continue"
  );
  if (choice !== "Save and Continue") {
    return false;
  }

  for (const doc of dirty) {
    if (!(await doc.save())) {
      vscode.window.showErrorMessage(`Could not save ${doc.uri.fsPath}.`);
      return false;
    }
  }
  return true;
}

export async function countLocalChanges(
  service: CheckoutService,
  entries: CheckedOutMember[],
  log: vscode.OutputChannel
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    try {
      if (await service.hasLocalChanges(entry)) {
        count++;
      }
    } catch (err) {
      log.appendLine(`[status] Could not read ${entry.localPath}: ${errorMessage(err)}`);
    }
  }
  return count;
}
