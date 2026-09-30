/**
 * Runs the shop's change-management checkout command (for example Rocket LMI) for members
 * that should be changed rather than read, from the
 * `ibmi-member-workspace.changeManagement.checkoutCommand` template. IBM i calls and prompts are
 * injected, so this has no `vscode` dependency.
 */
import { errorMessage } from "./errors";
import { memberNameProblem, systemKey } from "./types";

export interface ChangeMember {
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
}

/** Placeholders a template may use, named as in Code for IBM i actions, plus &DEVLIB. */
export const CHECKOUT_COMMAND_PLACEHOLDERS = ["OPENLIB", "OPENSPF", "OPENMBR", "EXT", "DEVLIB"] as const;

const PLACEHOLDER = /&([A-Z][A-Z0-9_]*)/gi;

/** Why a template can't be used, or undefined when it can. */
export function checkoutTemplateProblem(template: string): string | undefined {
  if (!template.trim()) {
    return "The change-management checkout command is empty.";
  }
  const unknown = [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1].toUpperCase())
    .filter((name) => !(CHECKOUT_COMMAND_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    return `The change-management checkout command uses unknown placeholders: ${[...new Set(unknown)].map((name) => `&${name}`).join(", ")}. ` +
      `Use ${CHECKOUT_COMMAND_PLACEHOLDERS.map((name) => `&${name}`).join(", ")}.`;
  }
  return undefined;
}

/**
 * The template with the member's names filled in: uppercase and unquoted, since they are IBM i
 * system names. Names that aren't valid system names are refused rather than put in a command.
 */
export function expandCheckoutCommand(template: string, member: ChangeMember, devLibrary: string): string {
  const problem = checkoutTemplateProblem(template) ??
    memberNameProblem(member) ??
    memberNameProblem({ ...member, library: devLibrary });
  if (problem) {
    throw new Error(problem);
  }
  const values: Record<(typeof CHECKOUT_COMMAND_PLACEHOLDERS)[number], string> = {
    OPENLIB: member.library,
    OPENSPF: member.sourceFile,
    OPENMBR: member.memberName,
    EXT: member.extension,
    DEVLIB: devLibrary,
  };
  return template
    .trim()
    .replace(PLACEHOLDER, (_match, name: string) => values[name.toUpperCase() as keyof typeof values].toUpperCase());
}

export interface ChangeCheckoutDeps {
  /** Asks for the development library; undefined when cancelled. */
  askDevLibrary(): Promise<string | undefined>;
  /** Shows the exact commands and asks to run them. */
  confirm(commands: string[], devLibrary: string): Promise<boolean>;
  connectedSystem(): string | undefined;
  /** Runs one CL command on the IBM i; throws with the IBM i's message when it fails. */
  runCommand(command: string): Promise<void>;
  log(message: string): void;
}

export interface ChangeCheckoutResult {
  devLibrary: string;
  succeeded: ChangeMember[];
  failed: Array<{ member: ChangeMember; command: string; error: string }>;
}

function refusal(connected: string | undefined, system: string): string | undefined {
  if (!connected) {
    return "Not connected to the IBM i.";
  }
  return systemKey(connected) === systemKey(system) ? undefined : `Connected to ${connected}, not ${system}.`;
}

/**
 * Runs the checkout command for each member on `system` after the user names the development
 * library and confirms the exact commands. Undefined when cancelled. A failed or refused member
 * is reported and doesn't stop the others; nothing runs while another system is connected.
 */
export async function runChangeManagementCheckout(
  members: readonly ChangeMember[],
  system: string,
  template: string,
  deps: ChangeCheckoutDeps
): Promise<ChangeCheckoutResult | undefined> {
  const templateProblem = checkoutTemplateProblem(template);
  if (templateProblem) {
    throw new Error(templateProblem);
  }
  const answer = (await deps.askDevLibrary())?.trim().toUpperCase();
  if (!answer) {
    return undefined;
  }
  const devLibrary = answer;
  const planned = members.map((member) => ({ member, command: expandCheckoutCommand(template, member, devLibrary) }));
  const refused = refusal(deps.connectedSystem(), system);
  if (refused) {
    throw new Error(refused);
  }
  if (!(await deps.confirm(planned.map(({ command }) => command), devLibrary))) {
    return undefined;
  }

  const result: ChangeCheckoutResult = { devLibrary, succeeded: [], failed: [] };
  for (const { member, command } of planned) {
    // The confirmation leaves time to connect elsewhere; these commands belong to `system`.
    const error = refusal(deps.connectedSystem(), system);
    if (error) {
      result.failed.push({ member, command, error });
      deps.log(`[change management] Not run on ${deps.connectedSystem() ?? "no system"}: ${command} (${error})`);
      continue;
    }
    try {
      deps.log(`[change management] ${command}`);
      await deps.runCommand(command);
      result.succeeded.push(member);
    } catch (err) {
      result.failed.push({ member, command, error: errorMessage(err) });
      deps.log(`[change management] Failed: ${command}: ${errorMessage(err)}`);
    }
  }
  return result;
}
