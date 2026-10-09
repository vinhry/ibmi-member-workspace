import * as vscode from "vscode";
import {
  AUTO_UPLOAD_MODES,
  AutoUploadMode,
  AutoUploadScheduler,
  effectiveUploadMode,
  isAutoUploadMode,
} from "../autoUpload";
import { CheckoutService } from "../checkoutService";
import { getSystemName, isConnectionReadOnly } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { MergeHandler } from "../mergeHandler";
import { activeCheckout } from "../prompts";
import { CheckedOutMember, formatMemberPath, isReferenceCopy, systemKey } from "../types";
import { uploadWithConflictHandling } from "./uploadMember";

const SETTING = "autoUploadOnSave";

const MODE_LABELS: Record<AutoUploadMode, { label: string; detail: string }> = {
  off: { label: "Off", detail: "Upload only with the Upload to IBM i command." },
  ask: { label: "Ask", detail: "Ask before uploading each saved checkout." },
  silent: { label: "On", detail: "Upload saved checkouts without asking. Changes made on the IBM i still prompt." },
};

/** The active editor shows a checkout that can be uploaded (not a reference copy). */
const EDITABLE_CHECKOUT_ACTIVE = "ibmi-member-workspace:editableCheckoutActive";
/** The active editor shows a checkout, reference copies included. */
const CHECKOUT_ACTIVE = "ibmi-member-workspace:checkoutActive";

const MEMBER_MODE_DETAILS: Record<AutoUploadMode, string> = {
  off: "Don't upload this member when it is saved.",
  ask: "Ask before uploading this member each time it is saved.",
  silent: "Upload this member whenever it is saved, without asking. Changes made on the IBM i still prompt.",
};

export function getAutoUploadMode(): AutoUploadMode {
  const mode = vscode.workspace.getConfiguration("ibmi-member-workspace").get<string>(SETTING, "off");
  return isAutoUploadMode(mode) ? mode : "off";
}

/** Saves the mode in user settings, the only place it is read: a workspace can't turn on uploads. */
async function setAutoUploadMode(mode: AutoUploadMode): Promise<void> {
  await vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .update(SETTING, mode, vscode.ConfigurationTarget.Global);
}

/** The editable checkout shown in the active editor, if any. */
function activeEditableCheckout(service: CheckoutService): CheckedOutMember | undefined {
  const entry = activeCheckout(service);
  return entry && !isReferenceCopy(entry) ? entry : undefined;
}

/**
 * Sets up upload on save: the scheduler that the editor's save handler feeds,
 * a status-bar item showing the mode (for the open member, when one is open),
 * and the commands that change the setting or one member's choice.
 */
export function registerAutoUpload(options: {
  context: vscode.ExtensionContext;
  service: CheckoutService;
  mergeHandler: MergeHandler;
  log: vscode.OutputChannel;
}): AutoUploadScheduler {
  const { context, service, mergeHandler, log } = options;

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
      if (mergeHandler.hasOpenMerge(entry.id)) {
        return "a Merge Back is open for it and not yet saved";
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
    setMemberMode: (entry, mode) => service.setUploadOnSave(entry.id, mode),
    upload: async (entry) => {
      await uploadWithConflictHandling(service, mergeHandler, entry, log, { quiet: true });
    },
    log: (message) => log.appendLine(message),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });
  context.subscriptions.push(scheduler);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(statusBar);
  let editableCheckoutActive: boolean | undefined;
  let checkoutActive: boolean | undefined;
  const refreshStatusBar = () => {
    const setting = getAutoUploadMode();
    const active = activeCheckout(service);
    const entry = active && !isReferenceCopy(active) ? active : undefined;
    if (checkoutActive !== (active !== undefined)) {
      checkoutActive = active !== undefined;
      void vscode.commands.executeCommand("setContext", CHECKOUT_ACTIVE, checkoutActive);
    }
    if (editableCheckoutActive !== (entry !== undefined)) {
      editableCheckoutActive = entry !== undefined;
      void vscode.commands.executeCommand("setContext", EDITABLE_CHECKOUT_ACTIVE, editableCheckoutActive);
    }
    if (entry) {
      // The open member's mode is always shown, so it can be turned on for this member alone.
      const mode = effectiveUploadMode(entry, setting);
      const own = isAutoUploadMode(entry.uploadOnSave);
      statusBar.text = `$(cloud-upload) Auto-upload: ${MODE_LABELS[mode].label}${own ? " (this member)" : ""}`;
      statusBar.tooltip = `Upload ${formatMemberPath(entry)} to the IBM i when saved: ${MODE_LABELS[mode].label}. ` +
        (own ? `This member's own choice; the setting is ${MODE_LABELS[setting].label}.` : "Follows the setting.") +
        "\nClick to change for this member.";
      statusBar.command = "ibmi-member-workspace.changeMemberAutoUpload";
      statusBar.show();
      return;
    }
    statusBar.command = "ibmi-member-workspace.toggleAutoUpload";
    if (setting === "off") {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(cloud-upload) Auto-upload: ${MODE_LABELS[setting].label}`;
    statusBar.tooltip = `Upload checked-out members to the IBM i when saved: ${MODE_LABELS[setting].detail}\nClick to change.`;
    statusBar.show();
  };
  refreshStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`ibmi-member-workspace.${SETTING}`)) {
        refreshStatusBar();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(refreshStatusBar),
    service.onDidChange(refreshStatusBar)
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
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.changeMemberAutoUpload", async () => {
      const entry = activeEditableCheckout(service);
      if (!entry) {
        void vscode.window.showInformationMessage("Open a checked-out member to change upload on save for it.");
        return;
      }
      const setting = getAutoUploadMode();
      const own = isAutoUploadMode(entry.uploadOnSave) ? entry.uploadOnSave : undefined;
      type Item = vscode.QuickPickItem & { mode?: AutoUploadMode | "setting"; changeSetting?: boolean };
      const items: Item[] = [
        {
          mode: "setting",
          label: "Use Setting",
          description: `${own ? "" : "current · "}${MODE_LABELS[setting].label}`,
          detail: "Follow the Upload on Save setting, like other members.",
        },
        ...AUTO_UPLOAD_MODES.map((mode): Item => ({
          mode,
          label: MODE_LABELS[mode].label,
          description: mode === own ? "current" : undefined,
          detail: MEMBER_MODE_DETAILS[mode],
        })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "Change the Setting for All Members…", changeSetting: true },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Upload ${formatMemberPath(entry)} on Save`,
      });
      if (!picked) {
        return;
      }
      if (picked.changeSetting) {
        await vscode.commands.executeCommand("ibmi-member-workspace.toggleAutoUpload");
        return;
      }
      const mode = picked.mode === "setting" ? undefined : picked.mode;
      if (mode !== own) {
        try {
          await service.setUploadOnSave(entry.id, mode);
        } catch (err) {
          void vscode.window.showErrorMessage(`Could not change upload on save: ${errorMessage(err)}`);
        }
      }
    })
  );

  return scheduler;
}
