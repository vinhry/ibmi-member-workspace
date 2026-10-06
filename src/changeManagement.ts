/**
 * Runs the shop's change-management commands (for example Rocket LMI): the checkout command for
 * members that should be changed rather than read, from the
 * `ibmi-member-workspace.changeManagement.checkoutCommand` template, and the check-in command for
 * checkouts whose change is done, from `changeManagement.checkinCommand`. IBM i calls and prompts
 * are injected, so this has no `vscode` dependency.
 */
import { errorMessage } from "./errors";
import { CheckedOutMember, memberNameProblem, systemKey } from "./types";

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

/** Which change-management command a template is: the messages name it. */
export type ChangeManagementVerb = "checkout" | "checkin";

function verbLabel(verb: ChangeManagementVerb): string {
  return verb === "checkin" ? "check-in" : "checkout";
}

/** Why a template can't be used, or undefined when it can. */
export function commandTemplateProblem(template: string, verb: ChangeManagementVerb): string | undefined {
  if (!template.trim()) {
    return `The change-management ${verbLabel(verb)} command is empty.`;
  }
  const unknown = [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1].toUpperCase())
    .filter((name) => !(CHECKOUT_COMMAND_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    return `The change-management ${verbLabel(verb)} command uses unknown placeholders: ${[...new Set(unknown)].map((name) => `&${name}`).join(", ")}. ` +
      `Use ${CHECKOUT_COMMAND_PLACEHOLDERS.map((name) => `&${name}`).join(", ")}.`;
  }
  return undefined;
}

/** Why a checkout template can't be used, or undefined when it can. */
export function checkoutTemplateProblem(template: string): string | undefined {
  return commandTemplateProblem(template, "checkout");
}

type Placeholder = (typeof CHECKOUT_COMMAND_PLACEHOLDERS)[number];

/** Why a value the template needs can't go in, or undefined: missing when used, or not a name. */
function neededValue(template: string, name: Placeholder, label: string, value: string | undefined): string | undefined {
  return !usesPlaceholder(template, name)
    ? undefined
    : value === undefined || value === ""
      ? `The command uses &${name}, but no ${label} is known.`
      : nameValueProblem(label, value);
}

/** Why the release can't go in, or undefined: missing when used, or not a release. */
function neededRelease(template: string, release: string | undefined): string | undefined {
  return !usesPlaceholder(template, "RELEASE")
    ? undefined
    : release
      ? releaseProblem(release)
      : "The command uses &RELEASE, but no release is known.";
}

/** The template as one line with every placeholder replaced, uppercase. */
function fillTemplate(template: string, values: Record<Placeholder, string>): string {
  return template
    .trim()
    // The setting is edited in a multi-line box; a command is one line.
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(PLACEHOLDER, (_match, name: string) => values[name.toUpperCase() as Placeholder].toUpperCase());
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
  const problem = checkoutTemplateProblem(template) ??
    memberNameProblem(member) ??
    memberNameProblem({ ...member, library: devLibrary }) ??
    neededValue(template, "PROJECT", "project", project) ??
    neededValue(template, "USER", "user profile", user) ??
    neededRelease(template, release);
  if (problem) {
    throw new Error(problem);
  }
  return fillTemplate(template, {
    OPENLIB: member.library,
    OPENSPF: member.sourceFile,
    OPENMBR: member.memberName,
    EXT: member.extension,
    DEVLIB: devLibrary,
    PROJECT: project ?? "",
    RELEASE: release ?? "",
    USER: user ?? "",
  });
}

/**
 * A checked-out member to check in: the checkout's names (its library is the development
 * library), plus what was recorded when it was checked out through change management.
 */
export interface CheckinMember extends ChangeMember {
  /** The library it was checked out from (&OPENLIB), when known. */
  openLibrary?: string;
  /** The project it was checked out for, suggested for &PROJECT. */
  project?: string;
  /** The release it was checked out from, suggested for &RELEASE. */
  release?: string;
}

/** The check-in view of a checkout: its names and what its change-management checkout recorded. */
export function checkinMemberOf(
  entry: Pick<CheckedOutMember, "library" | "sourceFile" | "memberName" | "extension" | "changeManagement">
): CheckinMember {
  const origin = entry.changeManagement;
  return {
    library: entry.library,
    sourceFile: entry.sourceFile,
    memberName: entry.memberName,
    extension: entry.extension,
    ...(origin?.openLibrary ? { openLibrary: origin.openLibrary } : {}),
    ...(origin?.project ? { project: origin.project } : {}),
    ...(origin?.release ? { release: origin.release } : {}),
  };
}

/**
 * Why a checkout can't be checked in, or undefined when it can: a reference copy is never checked
 * in, and local changes must reach the IBM i first, since the check-in takes the member as it is there.
 */
export function checkinRefusal(entry: Pick<CheckedOutMember, "kind" | "status">): string | undefined {
  if (entry.kind === "reference") {
    return "it is a read-only reference copy";
  }
  if (entry.status === "modified" || entry.status === "conflict") {
    return "it has changes that haven't been uploaded to the IBM i; upload it first";
  }
  return undefined;
}

/**
 * The check-in template with the checkout's names filled in: &DEVLIB is the library it is checked
 * out in, &OPENLIB the one it was checked out from. The project and release default to the ones
 * recorded at checkout. Refuses as {@link expandCheckoutCommand} does.
 */
export function expandCheckinCommand(
  template: string,
  member: CheckinMember,
  {
    openLibrary = member.openLibrary,
    project = member.project,
    user,
    release = member.release,
  }: { openLibrary?: string; project?: string; user?: string; release?: string } = {}
): string {
  const problem = commandTemplateProblem(template, "checkin") ??
    memberNameProblem(member) ??
    neededValue(template, "OPENLIB", "production library", openLibrary) ??
    neededValue(template, "PROJECT", "project", project) ??
    neededValue(template, "USER", "user profile", user) ??
    neededRelease(template, release);
  if (problem) {
    throw new Error(problem);
  }
  return fillTemplate(template, {
    OPENLIB: openLibrary ?? "",
    OPENSPF: member.sourceFile,
    OPENMBR: member.memberName,
    EXT: member.extension,
    DEVLIB: member.library,
    PROJECT: project ?? "",
    RELEASE: release ?? "",
    USER: user ?? "",
  });
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
  /** Asks for the release (&RELEASE), pre-filled with the usual one, only when the template uses it; undefined when cancelled. */
  askRelease(): Promise<string | undefined>;
  /** Shows the exact commands and asks to run them. */
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
  /** The project the commands used, when the template has &PROJECT. */
  project?: string;
  /** The release the commands used, when the template has &RELEASE. */
  release?: string;
  succeeded: ChangeMember[];
  failed: Array<{ member: ChangeMember; command: string; error: string }>;
}

/** Runs the planned commands one by one; a failed or refused member doesn't stop the others. */
async function runCommands<M extends ChangeMember>(
  planned: ReadonlyArray<{ member: M; command: string }>,
  system: string,
  deps: Pick<ChangeCheckoutDeps, "connectedSystem" | "runCommand" | "log">
): Promise<{ succeeded: M[]; failed: Array<{ member: M; command: string; error: string }> }> {
  const succeeded: M[] = [];
  const failed: Array<{ member: M; command: string; error: string }> = [];
  for (const { member, command } of planned) {
    // The confirmation leaves time to connect elsewhere; these commands belong to `system`.
    const error = refusal(deps.connectedSystem(), system);
    if (error) {
      failed.push({ member, command, error });
      deps.log(`[change management] Not run on ${deps.connectedSystem() ?? "no system"}: ${command} (${error})`);
      continue;
    }
    try {
      deps.log(`[change management] ${command}`);
      await deps.runCommand(command);
      succeeded.push(member);
    } catch (err) {
      failed.push({ member, command, error: errorMessage(err) });
      deps.log(`[change management] Failed: ${command}: ${errorMessage(err)}`);
    }
  }
  return { succeeded, failed };
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

  const { succeeded, failed } = await runCommands(planned, system, deps);
  return { devLibrary, ...(project ? { project } : {}), ...(release ? { release } : {}), succeeded, failed };
}

export interface ChangeCheckinDeps {
  /**
   * Asks for the library the members were checked out from (&OPENLIB), only when the template
   * uses it and a member's isn't known; undefined when cancelled.
   */
  askOpenLibrary(): Promise<string | undefined>;
  /** Asks for the project (&PROJECT), suggesting the one recorded at checkout, only when the template uses it; undefined when cancelled. */
  askProject(suggested: string | undefined): Promise<string | undefined>;
  /** Asks for the release (&RELEASE), suggesting the one recorded at checkout, only when the template uses it; undefined when cancelled. */
  askRelease(suggested: string | undefined): Promise<string | undefined>;
  /** Shows the exact commands and asks to run them. */
  confirm(commands: string[]): Promise<boolean>;
  connectedSystem(): string | undefined;
  /** The connection's user profile, for &USER. */
  currentUser(): string | undefined;
  /** Runs one CL command on the IBM i; throws with the IBM i's message when it fails. */
  runCommand(command: string): Promise<void>;
  log(message: string): void;
}

export interface ChangeCheckinResult {
  /** The project the commands used, when the template has &PROJECT. */
  project?: string;
  /** The release the commands used, when the template has &RELEASE. */
  release?: string;
  succeeded: CheckinMember[];
  failed: Array<{ member: CheckinMember; command: string; error: string }>;
}

/**
 * Runs the check-in command for each checkout on `system` after the user confirms the exact
 * commands. The project and release recorded at checkout are suggested; one answer serves every
 * member. Undefined when cancelled. A failed or refused member is reported and doesn't stop the
 * others; nothing runs while another system is connected.
 */
export async function runChangeManagementCheckin(
  members: readonly CheckinMember[],
  system: string,
  template: string,
  deps: ChangeCheckinDeps
): Promise<ChangeCheckinResult | undefined> {
  const templateProblem = commandTemplateProblem(template, "checkin");
  if (templateProblem) {
    throw new Error(templateProblem);
  }
  let openLibrary: string | undefined;
  if (usesPlaceholder(template, "OPENLIB") && members.some((member) => !member.openLibrary)) {
    openLibrary = (await deps.askOpenLibrary())?.trim().toUpperCase();
    if (!openLibrary) {
      return undefined;
    }
  }
  let project: string | undefined;
  if (usesPlaceholder(template, "PROJECT")) {
    project = (await deps.askProject(members.find((member) => member.project)?.project))?.trim().toUpperCase();
    if (!project) {
      return undefined;
    }
  }
  let release: string | undefined;
  if (usesPlaceholder(template, "RELEASE")) {
    release = (await deps.askRelease(members.find((member) => member.release)?.release))?.trim().toUpperCase();
    if (!release) {
      return undefined;
    }
  }
  const user = usesPlaceholder(template, "USER") ? deps.currentUser()?.trim().toUpperCase() : undefined;
  const planned = members.map((member) => ({
    member,
    command: expandCheckinCommand(template, member, { openLibrary: member.openLibrary ?? openLibrary, project, user, release }),
  }));
  const refused = refusal(deps.connectedSystem(), system);
  if (refused) {
    throw new Error(refused);
  }
  if (!(await deps.confirm(planned.map(({ command }) => command)))) {
    return undefined;
  }
  const { succeeded, failed } = await runCommands(planned, system, deps);
  return { ...(project ? { project } : {}), ...(release ? { release } : {}), succeeded, failed };
}
