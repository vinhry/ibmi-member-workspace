import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { errorMessage } from "./errors";
import { CheckedOutMember, storedEntryFor } from "./types";

/**
 * The checkout a command's argument refers to: a Checked Out Members item (see
 * {@link storedEntryFor}), a file from the Explorer or an editor menu, or, with no argument (the
 * Command Palette or a keybinding), the file in the active editor.
 */
export function resolveMember(service: CheckoutService, item: unknown): CheckedOutMember | undefined {
  if (item === undefined || item === null) {
    return activeCheckout(service);
  }
  if (item instanceof vscode.Uri) {
    return checkoutOfUri(service, item);
  }
  return storedEntryFor(item, (system) => service.getEntriesForSystem(system));
}

/** The checkout open in the active editor, reference copies included. */
export function activeCheckout(service: CheckoutService): CheckedOutMember | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri ? checkoutOfUri(service, uri) : undefined;
}

function checkoutOfUri(service: CheckoutService, uri: vscode.Uri): CheckedOutMember | undefined {
  return uri.scheme === "file" ? service.findEntryByLocalPath(uri.fsPath) : undefined;
}

/** The checkouts a multi-selection (tree items or Explorer files) stands for; see {@link resolveMember}. */
export function resolveMemberSelections(
  service: CheckoutService,
  item: unknown,
  allSelections?: unknown[]
): Array<{ kind: "member"; entry: CheckedOutMember }> {
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
