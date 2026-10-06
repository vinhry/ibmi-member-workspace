import * as vscode from "vscode";
import { connectedUser, getSystemName, runClCommand } from "../codeForIBMi";
import {
  ChangeCheckinResult,
  ChangeCheckoutResult,
  CheckinMember,
  checkinMemberOf,
  checkinRefusal,
  nameValueProblem,
  releaseProblem,
  runChangeManagementCheckin,
  runChangeManagementCheckout,
} from "../changeManagement";
import { errorMessage } from "../errors";
import type { BrowserNode, MemberInfo } from "../memberInfo";
import { resolveMemberSelections } from "../prompts";
import { CheckedOutMember, TreeItemType, formatMemberPath, isReferenceCopy } from "../types";
import { checkoutMembersBatch, memberInfoOf } from "./checkout";
import { CommandContext } from "./context";
import { foundMembersOf } from "../findMemberView";
import { ensureWorkItemForCheckout } from "./git";

export function registerChangeManagementCommands(ctx: CommandContext): void {
  ctx.context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutThroughChangeManagement",
      async (arg: unknown, all?: unknown[]) => {
        const system = getSystemName();
        if (!system) {
          vscode.window.showWarningMessage("Connect to an IBM i first.");
          return;
        }
        const members = selectedMembers(ctx, arg, all);
        if (members.length > 0) {
          await changeThroughChangeManagement(ctx, system, members);
        }
      }
    ),
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkinThroughChangeManagement",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const entries = resolveMemberSelections(ctx.service, item, allSelections).map(({ entry }) => entry);
        if (entries.length > 0) {
          await checkInThroughChangeManagement(ctx, entries);
        }
      }
    )
  );
}

/** Whether a check-in command is set, so Check In… is worth offering after an upload. */
export function checkinCommandConfigured(): boolean {
  return Boolean(vscode.workspace.getConfiguration("ibmi-member-workspace").inspect<string>(CHECKIN_COMMAND_SETTING)?.globalValue?.trim());
}


/** The members a right-click stands for: Object Browser members, Checked Out Members items, or Find Member results. */
function selectedMembers(ctx: CommandContext, arg: unknown, all?: unknown[]): MemberInfo[] {
  if ((arg as { kind?: unknown } | undefined)?.kind === "found") {
    return foundMembersOf(arg, all);
  }
  if ((arg as { kind?: unknown } | undefined)?.kind === "member") {
    return resolveMemberSelections(ctx.service, arg as TreeItemType, all as TreeItemType[] | undefined).map(({ entry }) => ({
      library: entry.library,
      sourceFile: entry.sourceFile,
      memberName: entry.memberName,
      extension: entry.extension,
    }));
  }
  const nodes = all && all.length > 1 ? all : [arg];
  return nodes.flatMap((node) => {
    const info = memberInfoOf(node as BrowserNode);
    return info ? [info] : [];
  });
}

/** workspaceState key: the development library last named for a change-management checkout. */
const LAST_DEV_LIBRARY = "changeManagement.lastDevLibrary";
/** workspaceState key: the project last named for a change-management checkout or check-in (&PROJECT). */
const LAST_PROJECT = "changeManagement.lastProject";
/** workspaceState key: the production library last named for a change-management check-in (&OPENLIB). */
const LAST_OPEN_LIBRARY = "changeManagement.lastOpenLibrary";

const CHECKOUT_COMMAND_SETTING = "changeManagement.checkoutCommand";
const CHECKIN_COMMAND_SETTING = "changeManagement.checkinCommand";
const RELEASE_SETTING = "changeManagement.release";

const IBMI_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i;

/** The usual release, from user settings only, like the command it goes into. */
function usualRelease(): string {
  return (vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .inspect<string>(RELEASE_SETTING)?.globalValue ?? "").trim().toUpperCase();
}

/** After a command ran with another release than the usual one, offers to make it the usual one. */
function offerReleaseAsDefault(release: string | undefined, usual: string): void {
  if (!release || release === usual) {
    return;
  }
  const makeDefault = "Make Default";
  void vscode.window
    .showInformationMessage(
      usual ? `Make ${release} your default release instead of ${usual}?` : `Make ${release} your default release?`,
      makeDefault
    )
    .then(async (choice) => {
      if (choice === makeDefault) {
        await vscode.workspace.getConfiguration("ibmi-member-workspace").update(RELEASE_SETTING, release, vscode.ConfigurationTarget.Global);
      }
    });
}

function openSetting(setting: string): void {
  void vscode.commands.executeCommand("workbench.action.openSettings", `ibmi-member-workspace.${setting}`);
}

/**
 * "I Need to Change Some…": runs the change-management checkout command when one is set, then
 * offers to check out the development library's copies; otherwise explains the steps.
 */
export async function changeThroughChangeManagement(ctx: CommandContext, system: string, members: MemberInfo[]): Promise<void> {
  const template = vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .inspect<string>(CHECKOUT_COMMAND_SETTING)?.globalValue?.trim();
  if (!template) {
    await showChangeGuide(members);
    return;
  }

  const usual = usualRelease();

  let result: ChangeCheckoutResult | undefined;
  try {
    result = await runChangeManagementCheckout(members, system, template, {
      askDevLibrary: async () => vscode.window.showInputBox({
        title: "Change-Management Checkout",
        prompt: "The development library your change-management system checks the members out to (&DEVLIB)",
        value: ctx.context.workspaceState.get<string>(LAST_DEV_LIBRARY) ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i.test(value.trim())
          ? undefined
          : "Enter an IBM i library name.",
      }),
      askProject: async () => vscode.window.showInputBox({
        title: "Change-Management Checkout",
        prompt: "The change-management project (task) the members are checked out for (&PROJECT)",
        value: ctx.context.workspaceState.get<string>(LAST_PROJECT) ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => nameValueProblem("project", value.trim()),
      }),
      askRelease: async () => vscode.window.showInputBox({
        title: "Change-Management Checkout: Release",
        prompt: usual
          ? "The release to check out from (&RELEASE). Change it for this checkout if needed."
          : "The release to check out from (&RELEASE), for example MYGROUP/MYAPP/BASE",
        value: usual,
        ignoreFocusOut: true,
        validateInput: (value) => releaseProblem(value.trim()),
      }),
      confirm: async (commands, devLibrary, project) => {
        await ctx.context.workspaceState.update(LAST_DEV_LIBRARY, devLibrary);
        if (project) {
          await ctx.context.workspaceState.update(LAST_PROJECT, project);
        }
        const choice = await vscode.window.showWarningMessage(
          `Run ${commands.length === 1 ? "this command" : `these ${commands.length} commands`} on ${system}?`,
          { modal: true, detail: commands.join("\n") },
          "Run"
        );
        return choice === "Run";
      },
      connectedSystem: getSystemName,
      currentUser: connectedUser,
      runCommand: runClCommand,
      log: (message) => ctx.log.appendLine(message),
    });
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Could not run the change-management checkout: ${errorMessage(err)}`,
      "Open Setting"
    );
    if (choice) {
      openSetting(CHECKOUT_COMMAND_SETTING);
    }
    return;
  }
  if (!result) {
    return;
  }

  const { devLibrary, succeeded, failed, project, release } = result;
  offerReleaseAsDefault(release, usual);
  if (failed.length > 0) {
    const names = failed.map(({ member, error }) => `${member.memberName} (${error})`).join(", ");
    void vscode.window
      .showErrorMessage(`Change-management checkout failed for ${names}`, "Show Output")
      .then((choice) => choice && ctx.log.show());
  }
  if (succeeded.length === 0) {
    return;
  }
  const count = succeeded.length === 1 ? "1 member" : `${succeeded.length} members`;
  const checkOut = `Check Out from ${devLibrary}`;
  const choice = await vscode.window.showInformationMessage(
    `Checked out ${count} in change management. Check out the ${devLibrary} copies here to change them?`,
    checkOut
  );
  if (choice !== checkOut || !(await ensureWorkItemForCheckout(ctx, system))) {
    return;
  }
  const checkedOutAt = new Date().toISOString();
  await checkoutMembersBatch(
    ctx.service,
    system,
    succeeded.map((member) => ({
      ...member,
      library: devLibrary,
      // Kept with the checkout, so Check In Through Change Management knows where it came from.
      changeManagement: {
        openLibrary: member.library,
        ...(project ? { project } : {}),
        ...(release ? { release } : {}),
        checkedOutAt,
      },
    })),
    ctx.log
  );
}

/**
 * Check In Through Change Management: runs the check-in command for checkouts whose change is on
 * the IBM i, then offers to discard the local copies. Reference copies and members with changes
 * not yet uploaded are refused, since the check-in takes the member as it is on the IBM i.
 */
export async function checkInThroughChangeManagement(ctx: CommandContext, entries: CheckedOutMember[]): Promise<void> {
  const system = getSystemName();
  if (!system) {
    vscode.window.showWarningMessage("Connect to an IBM i first.");
    return;
  }
  const template = vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .inspect<string>(CHECKIN_COMMAND_SETTING)?.globalValue?.trim();
  if (!template) {
    const choice = await vscode.window.showInformationMessage(
      "To check members in through your change-management system from here, set " +
        `ibmi-member-workspace.${CHECKIN_COMMAND_SETTING} in your user settings to its check-in command.`,
      "Open Setting"
    );
    if (choice) {
      openSetting(CHECKIN_COMMAND_SETTING);
    }
    return;
  }

  const refused: Array<{ entry: CheckedOutMember; reason: string }> = [];
  const members = new Map<CheckinMember, CheckedOutMember>();
  for (const entry of entries) {
    const reason = checkinRefusal(entry) ??
      ((await ctx.service.hasLocalChanges(entry)) ? "it has changes that haven't been uploaded to the IBM i; upload it first" : undefined);
    if (reason) {
      refused.push({ entry, reason });
    } else {
      members.set(checkinMemberOf(entry), entry);
    }
  }
  if (refused.length > 0) {
    const upload = "Upload to IBM i";
    // Only reference copies are refused for another reason than local changes.
    const uploadable = refused.filter(({ entry }) => !isReferenceCopy(entry)).map(({ entry }) => entry);
    const message = refused.length === 1
      ? `Not checked in: ${formatMemberPath(refused[0].entry)}, ${refused[0].reason}.`
      : `Not checked in: ${refused.map(({ entry, reason }) => `${entry.memberName} (${reason})`).join(", ")}.`;
    const offer = uploadable.length > 0 ? [upload] : [];
    void vscode.window.showWarningMessage(message, ...offer).then((choice) => {
      if (choice === upload) {
        const items: TreeItemType[] = uploadable.map((entry) => ({ kind: "member", entry }));
        void vscode.commands.executeCommand("ibmi-member-workspace.uploadToRemote", items[0], items);
      }
    });
  }
  if (members.size === 0) {
    return;
  }

  const usual = usualRelease();
  let openLibraryAnswer: string | undefined;
  let result: ChangeCheckinResult | undefined;
  try {
    result = await runChangeManagementCheckin([...members.keys()], system, template, {
      askOpenLibrary: async () => {
        openLibraryAnswer = await vscode.window.showInputBox({
          title: "Change-Management Check-In",
          prompt: "The library the members were checked out from (&OPENLIB), for example the production library",
          value: ctx.context.workspaceState.get<string>(LAST_OPEN_LIBRARY) ?? "",
          ignoreFocusOut: true,
          validateInput: (value) => IBMI_NAME.test(value.trim()) ? undefined : "Enter an IBM i library name.",
        });
        return openLibraryAnswer;
      },
      askProject: async (suggested) => vscode.window.showInputBox({
        title: "Change-Management Check-In",
        prompt: "The change-management project (task) the members are checked in for (&PROJECT)",
        value: suggested ?? ctx.context.workspaceState.get<string>(LAST_PROJECT) ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => nameValueProblem("project", value.trim()),
      }),
      askRelease: async (suggested) => vscode.window.showInputBox({
        title: "Change-Management Check-In: Release",
        prompt: suggested || usual
          ? "The release to check in to (&RELEASE). Change it for this check-in if needed."
          : "The release to check in to (&RELEASE), for example MYGROUP/MYAPP/BASE",
        value: suggested ?? usual,
        ignoreFocusOut: true,
        validateInput: (value) => releaseProblem(value.trim()),
      }),
      confirm: async (commands) => {
        if (openLibraryAnswer?.trim()) {
          await ctx.context.workspaceState.update(LAST_OPEN_LIBRARY, openLibraryAnswer.trim().toUpperCase());
        }
        const choice = await vscode.window.showWarningMessage(
          `Run ${commands.length === 1 ? "this command" : `these ${commands.length} commands`} on ${system}?`,
          { modal: true, detail: commands.join("\n") },
          "Run"
        );
        return choice === "Run";
      },
      connectedSystem: getSystemName,
      currentUser: connectedUser,
      runCommand: runClCommand,
      log: (message) => ctx.log.appendLine(message),
    });
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Could not run the change-management check-in: ${errorMessage(err)}`,
      "Open Setting"
    );
    if (choice) {
      openSetting(CHECKIN_COMMAND_SETTING);
    }
    return;
  }
  if (!result) {
    return;
  }

  const { succeeded, failed, project, release } = result;
  if (project) {
    await ctx.context.workspaceState.update(LAST_PROJECT, project);
  }
  offerReleaseAsDefault(release, usual);
  if (failed.length > 0) {
    const names = failed.map(({ member, error }) => `${member.memberName} (${error})`).join(", ");
    void vscode.window
      .showErrorMessage(`Change-management check-in failed for ${names}`, "Show Output")
      .then((choice) => choice && ctx.log.show());
  }
  if (succeeded.length === 0) {
    return;
  }
  const checkedIn = succeeded.map((member) => members.get(member)!);
  const count = checkedIn.length === 1 ? formatMemberPath(checkedIn[0]) : `${checkedIn.length} members`;
  const discard = "Discard Checkout";
  const choice = await vscode.window.showInformationMessage(
    `Checked in ${count} in change management. Delete the local ${checkedIn.length === 1 ? "copy" : "copies"} and stop tracking ${checkedIn.length === 1 ? "it" : "them"}?`,
    discard,
    "Keep"
  );
  if (choice !== discard) {
    return;
  }
  try {
    await ctx.service.discardEntries(checkedIn);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not discard the checkout: ${errorMessage(err)}`);
  }
}

async function showChangeGuide(members: MemberInfo[]): Promise<void> {
  const paths = members.map((m) => `${m.library}/${m.sourceFile}(${m.memberName})`);
  const choice = await vscode.window.showInformationMessage(
    "Change these members through your change-management system",
    {
      modal: true,
      detail: `Check out ${paths.length === 1 ? "this member" : "these members"} in your change-management system ` +
        "(for example, Rocket LMI) so the change is tracked, then use Check Out Member on the copy in your " +
        `development library:\n\n${paths.join("\n")}\n\n` +
        "To run your change-management checkout command from here, set " +
        `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING} in your user settings.`,
    },
    "Copy Member Paths",
    "Open Setting"
  );
  if (choice === "Copy Member Paths") {
    await vscode.env.clipboard.writeText(paths.join("\n"));
  } else if (choice === "Open Setting") {
    openSetting(CHECKOUT_COMMAND_SETTING);
  }
}
