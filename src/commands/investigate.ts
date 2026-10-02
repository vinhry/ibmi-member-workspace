import * as vscode from "vscode";
import { PromptMember } from "../bobPrompts";
import { getSystemName, onConnectionChange } from "../codeForIBMi";
import type { BrowserNode } from "../memberInfo";
import { resolveMemberSelections } from "../prompts";
import { CheckedOutMember, TreeItemType, isReferenceCopy } from "../types";
import { memberInfoOf } from "./checkout";
import { CommandContext } from "./context";

/**
 * Shared by the Investigate menus of IBM Bob ("Bob, Investigate") and VS Code ("Investigate with
 * AI"): which members a right-click stands for, and the context key that shows the Explorer's menu
 * only on checked-out files.
 */

/** Keeps `ibmi-member-workspace:checkoutPaths` on the connected system's checkouts. */
export function trackCheckoutPaths(ctx: CommandContext): void {
  const { context, service } = ctx;
  // Status changes fire often; the context key is set only when the list of paths changed.
  let lastPaths: string | undefined;
  const update = () => {
    const system = getSystemName();
    const paths = system ? service.getEntriesForSystem(system).map((entry) => vscode.Uri.file(entry.localPath).fsPath) : [];
    const key = paths.join("\n");
    if (key !== lastPaths) {
      lastPaths = key;
      void vscode.commands.executeCommand("setContext", "ibmi-member-workspace:checkoutPaths", paths);
    }
  };
  update();
  context.subscriptions.push(service.onDidChange(update));
  onConnectionChange(context, update);
}

/** The members a right-click stands for: Explorer files, Checked Out Members items, or Object Browser nodes. */
export function investigatedMembers(
  ctx: CommandContext,
  arg: unknown,
  all?: unknown[]
): { members: PromptMember[]; notCheckedOut: number } {
  const { service } = ctx;
  const selections = all && all.length > 1 ? all : [arg];
  if (arg instanceof vscode.Uri) {
    const members: PromptMember[] = [];
    let notCheckedOut = 0;
    for (const uri of selections) {
      const entry = uri instanceof vscode.Uri ? service.findEntryByLocalPath(uri.fsPath) : undefined;
      if (entry) {
        members.push(promptMemberOf(entry));
      } else {
        notCheckedOut++;
      }
    }
    return { members, notCheckedOut };
  }
  if ((arg as { kind?: unknown } | undefined)?.kind === "member") {
    return {
      members: resolveMemberSelections(service, arg as TreeItemType, selections as TreeItemType[]).map(({ entry }) => promptMemberOf(entry)),
      notCheckedOut: 0,
    };
  }
  const system = getSystemName();
  return {
    members: selections.flatMap((node) => {
      const info = memberInfoOf(node as BrowserNode);
      if (!info) {
        return [];
      }
      // A member already checked out is named with its local copy.
      const entry = system ? service.findEntry(system, info.library, info.sourceFile, info.memberName) : undefined;
      return [entry
        ? promptMemberOf(entry)
        : { library: info.library, sourceFile: info.sourceFile, member: info.memberName, sourceType: info.extension }];
    }),
    notCheckedOut: 0,
  };
}

/** Warns when nothing was selected that a prompt can name; true when there are members to investigate. */
export function hasMembersToInvestigate(found: { members: PromptMember[]; notCheckedOut: number }, menu: string): boolean {
  if (found.members.length > 0) {
    return true;
  }
  vscode.window.showWarningMessage(
    found.notCheckedOut > 0 ? `${menu} works on checked-out members; none of the selected files is one.` : "No member selected."
  );
  return false;
}

/** Says which selected members a prompt left out. */
export function warnLeftOut(skipped: readonly string[], notCheckedOut: number): void {
  const leftOut = [
    ...(skipped.length > 0 ? [`${skipped.length} member(s) over the limit of 25 were left out`] : []),
    ...(notCheckedOut > 0 ? [`${notCheckedOut} selected file(s) that aren't checkouts were left out`] : []),
  ];
  if (leftOut.length > 0) {
    void vscode.window.showWarningMessage(`${leftOut.join("; ")}.`);
  }
}

function promptMemberOf(entry: CheckedOutMember): PromptMember {
  return {
    library: entry.library,
    sourceFile: entry.sourceFile,
    member: entry.memberName,
    localPath: entry.localPath,
    readOnly: isReferenceCopy(entry),
    sourceType: entry.extension,
  };
}
