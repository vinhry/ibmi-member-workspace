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

/**
 * Placeholders a template may use: the member's, named as in Code for IBM i actions, plus &DEVLIB
 * &PROJECT and &RELEASE (asked when the command runs) and &USER (the connection's user profile).
 */
export const CHECKOUT_COMMAND_PLACEHOLDERS = ["OPENLIB", "OPENSPF", "OPENMBR", "EXT", "DEVLIB", "PROJECT", "RELEASE", "USER"] as const;

const PLACEHOLDER = /&([A-Z][A-Z0-9_]*)/gi;

/** An IBM i name, as `memberNameProblem` checks them: nothing that could end a parameter or quote. */
const IBMI_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i;

/**
 * Why a release can't go in a command, or undefined when it can: one to three IBM i names joined by
 * "/", as Rocket LMI names a release (group/application/release, for example MYGROUP/MYAPP/BASE).
 */
export function releaseProblem(value: string): string | undefined {
  const parts = value.split("/");
  return parts.length <= 3 && parts.every((part) => IBMI_NAME.test(part))
    ? undefined
    : `"${value}" is not a valid release: use up to three IBM i names joined by /, for example MYGROUP/MYAPP/BASE.`;
}

/** Whether `template` uses the placeholder `name` (for example "PROJECT"), in any case. */
export function usesPlaceholder(template: string, name: string): boolean {
  return [...template.matchAll(PLACEHOLDER)].some((match) => match[1].toUpperCase() === name.toUpperCase());
}

/** Why a project number or user profile can't go in a command, or undefined when it can. */
export function nameValueProblem(label: string, value: string): string | undefined {
  return IBMI_NAME.test(value)
    ? undefined
    : `"${value}" is not a valid ${label}: use up to 10 letters, digits, _, $, # or @.`;
}

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
 * system names. Names that aren't valid system names are refused rather than put in a command, as
 * are a project or user the template uses but that is missing or not a valid name.
 */
export function expandCheckoutCommand(
  template: string,
  member: ChangeMember,
  devLibrary: string,
  { project, user, release }: { project?: string; user?: string; release?: string } = {}
): string {
  const needed = (name: string, label: string, value: string | undefined) =>
    !usesPlaceholder(template, name)
      ? undefined
      : value === undefined || value === ""
        ? `The command uses &${name}, but no ${label} is known.`
        : nameValueProblem(label, value);
  const problem = checkoutTemplateProblem(template) ??
    memberNameProblem(member) ??
    memberNameProblem({ ...member, library: devLibrary }) ??
    needed("PROJECT", "project", project) ??
    needed("USER", "user profile", user) ??
    (!usesPlaceholder(template, "RELEASE")
      ? undefined
      : release
        ? releaseProblem(release)
        : "The command uses &RELEASE, but no release is known.");
  if (problem) {
    throw new Error(problem);
  }
  const values: Record<(typeof CHECKOUT_COMMAND_PLACEHOLDERS)[number], string> = {
    OPENLIB: member.library,
    OPENSPF: member.sourceFile,
    OPENMBR: member.memberName,
    EXT: member.extension,
    DEVLIB: devLibrary,
    PROJECT: project ?? "",
    RELEASE: release ?? "",
    USER: user ?? "",
  };
  return template
    .trim()
    // The setting is edited in a multi-line box; a command is one line.
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(PLACEHOLDER, (_match, name: string) => values[name.toUpperCase() as keyof typeof values].toUpperCase());
}

/**
 * Messages that only say a command failed (LMI's "ended abnormally", SQL's "external routine detected
 * an error" from the SQL job the command ran in, CL's "errors occurred"); the cause is in the others.
 */
const GENERIC_FAILURES = /^(CMS9913|SQL0443|CPF9999|CPF0001|CPF9898)\b/;
/** Messages of a failed command reported at most. */
const MAX_FAILURE_MESSAGES = 10;

/**
 * The messages to report for a failed command, from its output: each once, the specific ones before
 * the generic ones that only say it failed, so the cause is never cut off.
 */
export function commandFailureMessages(output: string): string[] {
  const lines = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  const generic = lines.filter((line) => GENERIC_FAILURES.test(line));
  const specific = lines.filter((line) => !GENERIC_FAILURES.test(line));
  return [...specific, ...generic].slice(0, MAX_FAILURE_MESSAGES);
}

export interface ChangeCheckoutDeps {
  /** Asks for the development library; undefined when cancelled. */
  askDevLibrary(): Promise<string | undefined>;
  /** Asks for the change-management project (&PROJECT), only when the template uses it; undefined when cancelled. */
  askProject(): Promise<string | undefined>;
  /** Shows the exact commands and asks to run them. */
  /** Asks for the release (&RELEASE), pre-filled with the usual one, only when the template uses it; undefined when cancelled. */
  askRelease(): Promise<string | undefined>;
  confirm(commands: string[], devLibrary: string, project?: string): Promise<boolean>;
  connectedSystem(): string | undefined;
  /** The connection's user profile, for &USER. */
  currentUser(): string | undefined;
  /** Runs one CL command on the IBM i; throws with the IBM i's message when it fails. */
  runCommand(command: string): Promise<void>;
  log(message: string): void;
}

export interface ChangeCheckoutResult {
  devLibrary: string;
  /** The release the commands used, when the template has &RELEASE. */
  release?: string;
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
  let project: string | undefined;
  if (usesPlaceholder(template, "PROJECT")) {
    project = (await deps.askProject())?.trim().toUpperCase();
    if (!project) {
      return undefined;
    }
  }
  let release: string | undefined;
  if (usesPlaceholder(template, "RELEASE")) {
    release = (await deps.askRelease())?.trim().toUpperCase();
    if (!release) {
      return undefined;
    }
  }
  const user = usesPlaceholder(template, "USER") ? deps.currentUser()?.trim().toUpperCase() : undefined;
  const planned = members.map((member) => ({
    member,
    command: expandCheckoutCommand(template, member, devLibrary, { project, user, release }),
  }));
  const refused = refusal(deps.connectedSystem(), system);
  if (refused) {
    throw new Error(refused);
  }
  if (!(await deps.confirm(planned.map(({ command }) => command), devLibrary, project))) {
    return undefined;
  }

  const result: ChangeCheckoutResult = { devLibrary, ...(release ? { release } : {}), succeeded: [], failed: [] };
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
