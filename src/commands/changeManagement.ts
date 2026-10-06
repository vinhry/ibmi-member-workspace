import * as vscode from "vscode";
import { connectedUser, getSystemName, runClCommand } from "../codeForIBMi";
import { ChangeCheckoutResult, nameValueProblem, releaseProblem, runChangeManagementCheckout } from "../changeManagement";
import { errorMessage } from "../errors";
import type { BrowserNode, MemberInfo } from "../memberInfo";
import { resolveMemberSelections } from "../prompts";
import { TreeItemType } from "../types";
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
    )
  );
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
/** workspaceState key: the project last named for a change-management checkout (&PROJECT). */
const LAST_PROJECT = "changeManagement.lastProject";

const CHECKOUT_COMMAND_SETTING = "changeManagement.checkoutCommand";
const RELEASE_SETTING = "changeManagement.release";

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

  // The usual release, from user settings only, like the command it goes into.
  const usualRelease = (vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .inspect<string>(RELEASE_SETTING)?.globalValue ?? "").trim().toUpperCase();

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
        prompt: usualRelease
          ? "The release to check out from (&RELEASE). Change it for this checkout if needed."
          : "The release to check out from (&RELEASE), for example MYGROUP/MYAPP/BASE",
        value: usualRelease,
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
      void vscode.commands.executeCommand("workbench.action.openSettings", `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING}`);
    }
    return;
  }
  if (!result) {
    return;
  }

  const { devLibrary, succeeded, failed, release } = result;
  if (release && release !== usualRelease) {
    const makeDefault = "Make Default";
    void vscode.window
      .showInformationMessage(
        usualRelease
          ? `Make ${release} your default release instead of ${usualRelease}?`
          : `Make ${release} your default release?`,
        makeDefault
      )
      .then(async (choice) => {
        if (choice === makeDefault) {
          await vscode.workspace.getConfiguration("ibmi-member-workspace").update(RELEASE_SETTING, release, vscode.ConfigurationTarget.Global);
        }
      });
  }
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
  await checkoutMembersBatch(ctx.service, system, succeeded.map((member) => ({ ...member, library: devLibrary })), ctx.log);
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
    void vscode.commands.executeCommand("workbench.action.openSettings", `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING}`);
  }
}
