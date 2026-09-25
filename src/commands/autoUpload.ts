import * as vscode from "vscode";
import {
  AUTO_UPLOAD_MODES,
  AutoUploadMode,
  AutoUploadScheduler,
} from "../autoUpload";
import { CheckoutService } from "../checkoutService";
import { getSystemName, isConnectionReadOnly } from "../codeForIBMi";
import { MergeHandler } from "../mergeHandler";
import { CheckedOutMember, formatMemberPath, systemKey } from "../types";
import { uploadWithConflictHandling } from "./uploadMember";

const SETTING = "autoUploadOnSave";

const MODE_LABELS: Record<AutoUploadMode, { label: string; detail: string }> = {
  off: { label: "Off", detail: "Upload only with the Upload to IBM i command." },
  ask: { label: "Ask", detail: "Ask before uploading each saved checkout." },
  silent: { label: "On", detail: "Upload saved checkouts without asking. Changes made on the IBM i still prompt." },
};

export function getAutoUploadMode(): AutoUploadMode {
  const mode = vscode.workspace.getConfiguration("ibmi-member-workspace").get<string>(SETTING, "off");
  return (AUTO_UPLOAD_MODES as readonly string[]).includes(mode) ? mode as AutoUploadMode : "off";
}

/** Saves the mode where it is currently set, so a workspace value isn't hidden behind a user value. */
async function setAutoUploadMode(mode: AutoUploadMode): Promise<void> {
  const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
  const inspected = config.inspect<string>(SETTING);
  const target = inspected?.workspaceFolderValue !== undefined
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(SETTING, mode, target);
}

/**
 * Sets up upload on save: the scheduler that the editor's save handler feeds,
 * a status-bar item showing the mode, and the command that changes it.
 */
export function registerAutoUpload(options: {
  context: vscode.ExtensionContext;
  service: CheckoutService;
  mergeHandler: MergeHandler;
  pendingMergeBacks: Map<string, CheckedOutMember>;
  log: vscode.OutputChannel;
}): AutoUploadScheduler {
  const { context, service, mergeHandler, pendingMergeBacks, log } = options;

  const scheduler = new AutoUploadScheduler({
    mode: getAutoUploadMode,
    findEntry: (localPath) => service.findEntryByLocalPath(localPath),
    skipReason: (entry) => {
      const system = getSystemName();
      if (!system) {
        return "not connected to the IBM i";
      }
      if (systemKey(system) !== systemKey(entry.system)) {
        return `connected to ${system}, not ${entry.system}`;
      }
      if (isConnectionReadOnly()) {
        return "the Code for IBM i connection is read-only";
      }
      if ([...pendingMergeBacks.values()].some((pending) => pending.id === entry.id)) {
        return "a Merge Back is open for it";
      }
      return undefined;
    },
    isBusy: () => service.isBusy(),
    confirm: async (entry) => {
      const choice = await vscode.window.showInformationMessage(
        `Upload ${formatMemberPath(entry)} to the IBM i?`,
        "Upload",
        "Always Upload",
        "Not Now"
      );
      return choice === "Upload" ? "upload" : choice === "Always Upload" ? "always" : undefined;
    },
    setMode: setAutoUploadMode,
    upload: async (entry) => {
      await uploadWithConflictHandling(service, mergeHandler, entry, log, { quiet: true });
    },
    log: (message) => log.appendLine(message),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });
  context.subscriptions.push(scheduler);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBar.command = "ibmi-member-workspace.toggleAutoUpload";
  context.subscriptions.push(statusBar);
  const refreshStatusBar = () => {
    const mode = getAutoUploadMode();
    if (mode === "off") {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(cloud-upload) Auto-upload: ${MODE_LABELS[mode].label}`;
    statusBar.tooltip = `Upload checked-out members to the IBM i when saved: ${MODE_LABELS[mode].detail}\nClick to change.`;
    statusBar.show();
  };
  refreshStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`ibmi-member-workspace.${SETTING}`)) {
        refreshStatusBar();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.toggleAutoUpload", async () => {
      const current = getAutoUploadMode();
      const picked = await vscode.window.showQuickPick(
        AUTO_UPLOAD_MODES.map((mode) => ({
          mode,
          label: MODE_LABELS[mode].label,
          description: mode === current ? "current" : undefined,
          detail: MODE_LABELS[mode].detail,
        })),
        { title: "Upload to IBM i on Save" }
      );
      if (picked && picked.mode !== current) {
        await setAutoUploadMode(picked.mode);
      }
    })
  );

  return scheduler;
}
