import * as vscode from "vscode";
import { getSystemName, onConnectionChange } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { newlyChanged, refreshIntervalMs, remoteChangeBadge } from "../remoteStamps";
import { formatMemberPath } from "../types";
import { CommandContext } from "./context";

const ON_CONNECT = "backgroundRefresh.onConnect";
const INTERVAL = "backgroundRefresh.intervalMinutes";
/** Code for IBM i finishes setting up the connection before the first query. */
const CONNECT_DELAY_MS = 5000;

/**
 * Keeps the Checked Out Members view's badge on the members changed on the IBM i, and, when the user
 * turns it on, refreshes their status quietly on connect and every few minutes. Both settings are
 * user settings only (application scope), as each refresh runs queries on the IBM i.
 */
export function registerBackgroundRefresh(ctx: CommandContext): void {
  const { context, service, treeView, log } = ctx;

  const updateBadge = () => {
    const system = getSystemName();
    treeView.badge = remoteChangeBadge(system ? service.getEntriesForSystem(system) : []);
  };
  context.subscriptions.push(service.onDidChange(updateBadge));
  updateBadge();

  let running = false;
  const run = async (reason: string) => {
    const system = getSystemName();
    // A checkout, upload or refresh under way goes first; the next tick tries again.
    if (running || !system || service.isBusy()) {
      return;
    }
    const entries = service.getEntriesForSystem(system);
    if (entries.length === 0) {
      return;
    }
    running = true;
    const before = new Map(entries.map((entry) => [entry.id, entry.status]));
    try {
      const tally = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Checking IBM i members" },
        (progress) => service.refreshEntries(entries, progress, undefined, { quick: true })
      );
      log.appendLine(
        `[refresh] Background refresh (${reason}): ${tally.inSync} in sync, ${tally.modified} modified, ` +
        `${tally.remoteChanged} remote changed, ${tally.conflict} conflict, ${tally.errors} error(s)`
      );
      const { conflicts } = newlyChanged(before, service.getEntriesForSystem(system));
      if (conflicts.length > 0) {
        void reportConflicts(ctx, conflicts);
      }
    } catch (err) {
      log.appendLine(`[refresh] Background refresh (${reason}) failed: ${errorMessage(err)}`);
    } finally {
      running = false;
    }
  };

  const settings = () => vscode.workspace.getConfiguration("ibmi-member-workspace");
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearInterval(timer);
    timer = undefined;
    const ms = refreshIntervalMs(settings().get<number>(INTERVAL));
    if (ms !== undefined) {
      timer = setInterval(() => void run(`every ${ms / 60_000} minutes`), ms);
    }
  };
  schedule();

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`ibmi-member-workspace.${INTERVAL}`)) {
        schedule();
      }
    })
  );

  onConnectionChange(context, () => {
    updateBadge();
    if (getSystemName() && settings().get<boolean>(ON_CONNECT, false)) {
      setTimeout(() => void run("on connect"), CONNECT_DELAY_MS);
    }
  });
}

/** Tells the user about members that changed on the IBM i while they have local changes to them. */
async function reportConflicts(ctx: CommandContext, ids: readonly string[]): Promise<void> {
  const entries = ids.flatMap((id) => {
    const entry = ctx.service.findEntryById(id);
    return entry ? [entry] : [];
  });
  if (entries.length === 0) {
    return;
  }
  if (entries.length === 1) {
    const choice = await vscode.window.showWarningMessage(
      `${formatMemberPath(entries[0])} changed on the IBM i, and you have local changes to it. ` +
      "Review both with Merge Back before you upload.",
      "Merge Back"
    );
    if (choice === "Merge Back") {
      await vscode.commands.executeCommand("ibmi-member-workspace.mergeBack", { kind: "member", entry: entries[0] });
    }
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `${entries.length} members you changed locally also changed on the IBM i. Review each with Merge Back before you upload.`,
    "Show Members"
  );
  if (choice === "Show Members") {
    await vscode.commands.executeCommand("ibmi-member-workspace.checkoutView.focus");
  }
}
