import type { RemoteSeen } from "./remoteStamps";
import type { SourceLayout } from "./sourceCheck";

export interface CheckedOutMember {
  id: string;
  system: string;
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
  localPath: string;
  checkedOutAt: string;
  lastCheckedAt?: string;
  remoteHashAtCheckout: string;
  /** 2 when `remoteHashAtCheckout` uses the current hash; absent for baselines stored before 1.2.2. */
  hashVersion?: 2;
  /**
   * "reference": a read-only copy brought in to read (e.g. a dependency from production). It is
   * never uploaded or merged back; changes go through the shop's change management instead.
   */
  kind?: "reference";
  /** Upload on save for this member only, instead of the `autoUploadOnSave` setting. */
  uploadOnSave?: "off" | "ask" | "silent";
  /** The source file's line length and CCSID, read at checkout; absent for checkouts made before 1.7.10. */
  sourceLayout?: SourceLayout;
  /** The member's change stamp and hash at its last full comparison, for quick refresh; cleared by writes to it. */
  remoteSeen?: RemoteSeen;
  /**
   * Set when the member was checked out here right after a change-management checkout (Check Out
   * from DEVLIB): where it came from, for Check In Through Change Management to fill in.
   */
  changeManagement?: ChangeManagementOrigin;
  status: CheckoutStatus;
}

/** What a change-management checkout recorded about a member checked out here afterwards. */
export interface ChangeManagementOrigin {
  /** The library the member was checked out from (the production library). */
  openLibrary: string;
  /** The change-management project (task) it was checked out for. */
  project?: string;
  /** The release it was checked out from. */
  release?: string;
  /** When the change-management checkout ran (ISO 8601). */
  checkedOutAt: string;
}

export function isReferenceCopy(entry: Pick<CheckedOutMember, "kind">): boolean {
  return entry.kind === "reference";
}

export type CheckoutStatus =
  | "checked-out"
  | "merged"
  | "modified"
  | "remote-changed"
  | "conflict"
  | "in-sync";

export interface CheckoutIndex {
  version: 3;
  systems: Record<string, SystemCheckoutState>;
  /** Empty work items migrated from v2 cannot be attributed until a system connects. */
  unassignedWorkItems: Record<string, CheckedOutMember[]>;
}

export interface SystemCheckoutState {
  system: string;
  directory: string;
  activeWorkItem: string;
  workItems: Record<string, CheckedOutMember[]>;
}

/** The branch a new Local Change History repository starts on: "no work item selected". */
export const DEFAULT_WORK_ITEM = "workspace";

export function isDefaultWorkItem(name: string): boolean {
  return name === DEFAULT_WORK_ITEM;
}

/** How a new work item gets its checked-out members. */
export type WorkItemCarry = "empty" | "copy" | "move";

/**
 * Makes `name` the active work item. Its list is always replaced: the branch was just created,
 * so any list already stored under that name belongs to an older, deleted branch.
 * "copy" clones the current members; "move" re-keys the current list (the branch was renamed).
 */
export function startWorkItemState(
  state: SystemCheckoutState,
  name: string,
  carry: WorkItemCarry
): void {
  const previous = state.activeWorkItem;
  const current = state.workItems[previous] ?? [];
  if (carry === "move" && previous !== name) {
    delete state.workItems[previous];
  }
  state.workItems[name] = carry === "empty" ? [] : current.map((entry) => ({ ...entry }));
  state.activeWorkItem = name;
}

/** Moves entries between work items, keeping their sync baselines and statuses. */
export function moveEntriesState(
  state: SystemCheckoutState,
  ids: ReadonlySet<string>,
  from: string,
  to: string
): void {
  const source = state.workItems[from] ?? [];
  const moving = source.filter((entry) => ids.has(entry.id));
  state.workItems[from] = source.filter((entry) => !ids.has(entry.id));
  state.workItems[to] = [
    ...(state.workItems[to] ?? []).filter((entry) => !ids.has(entry.id)),
    ...moving,
  ];
}

export interface RefreshTally {
  inSync: number;
  modified: number;
  remoteChanged: number;
  conflict: number;
  errors: number;
}

export function emptyTally(): RefreshTally {
  return { inSync: 0, modified: 0, remoteChanged: 0, conflict: 0, errors: 0 };
}

/** Parses the persisted checkout index and upgrades older formats to per-system storage. */
export function parseCheckoutIndex(json: string): CheckoutIndex {
  return withCurrentIds(parseIndexStructure(json));
}

function parseIndexStructure(json: string): CheckoutIndex {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Checkout index is not an object");
  }
  const value = parsed as {
    version?: number;
    entries?: CheckedOutMember[];
    activeWorkItem?: string;
    workItems?: Record<string, CheckedOutMember[]>;
    systems?: Record<string, SystemCheckoutState>;
    unassignedWorkItems?: Record<string, CheckedOutMember[]>;
  };
  if (value.version === 3 && value.systems && value.unassignedWorkItems) {
    if (!Object.values(value.systems).every(isSystemCheckoutState) ||
        !Object.values(value.unassignedWorkItems).every(Array.isArray)) {
      throw new Error("Checkout index contains invalid per-system state");
    }
    return {
      version: 3,
      systems: value.systems,
      unassignedWorkItems: value.unassignedWorkItems,
    };
  }
  if (value.version === 2 && value.activeWorkItem && value.workItems) {
    if (!Object.values(value.workItems).every(Array.isArray)) {
      throw new Error("Checkout index contains an invalid work item");
    }
    return migrateWorkItems(value.activeWorkItem, value.workItems);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error("Checkout index is missing its entries list");
  }
  return migrateWorkItems(DEFAULT_WORK_ITEM, { [DEFAULT_WORK_ITEM]: value.entries });
}

/** Recomputes ids so entries written with the older "_"-joined format keep matching. */
function withCurrentIds(index: CheckoutIndex): CheckoutIndex {
  const reid = (entries: CheckedOutMember[]) =>
    entries.map((e) => ({
      ...e,
      id: buildCheckoutId(e.system, e.library, e.sourceFile, e.memberName),
    }));
  const mapValues = (items: Record<string, CheckedOutMember[]>) =>
    Object.fromEntries(Object.entries(items).map(([name, entries]) => [name, reid(entries)]));
  return {
    version: 3,
    systems: Object.fromEntries(
      Object.entries(index.systems).map(([key, state]) => [
        key,
        { ...state, workItems: mapValues(state.workItems) },
      ])
    ),
    unassignedWorkItems: mapValues(index.unassignedWorkItems),
  };
}

function migrateWorkItems(
  activeWorkItem: string,
  workItems: Record<string, CheckedOutMember[]>
): CheckoutIndex {
  const systems: Record<string, SystemCheckoutState> = {};
  const unassignedWorkItems: Record<string, CheckedOutMember[]> = {};
  for (const [workItem, entries] of Object.entries(workItems)) {
    const systemNames = new Set(entries.map((entry) => entry.system));
    if (systemNames.size === 0) {
      unassignedWorkItems[workItem] = [];
    }
    for (const system of systemNames) {
      const key = systemKey(system);
      const state = systems[key] ??= {
        system,
        directory: sanitizeSystemName(system),
        activeWorkItem,
        workItems: {},
      };
      state.workItems[workItem] = entries.filter(
        (entry) => systemKey(entry.system) === key
      );
    }
  }
  return { version: 3, systems, unassignedWorkItems };
}

function isSystemCheckoutState(value: unknown): value is SystemCheckoutState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Partial<SystemCheckoutState>;
  return typeof state.system === "string" &&
    typeof state.directory === "string" &&
    typeof state.activeWorkItem === "string" &&
    typeof state.workItems === "object" &&
    state.workItems !== null &&
    Object.values(state.workItems).every(Array.isArray);
}

/** Checkouts tracked in one work item of one system ("" for work items not tied to a system yet). */
export interface TrackedGroup {
  system: string;
  workItem: string;
  count: number;
}

/** Every work item, on every system, that still tracks checkouts, including ones not shown as Git branches. */
export function trackedGroups(index: CheckoutIndex): TrackedGroup[] {
  const groups: TrackedGroup[] = [];
  for (const state of Object.values(index.systems)) {
    for (const [workItem, entries] of Object.entries(state.workItems)) {
      if (entries.length > 0) {
        groups.push({ system: state.system, workItem, count: entries.length });
      }
    }
  }
  for (const [workItem, entries] of Object.entries(index.unassignedWorkItems)) {
    if (entries.length > 0) {
      groups.push({ system: "", workItem, count: entries.length });
    }
  }
  return groups;
}

/** A tracked group in words, e.g. "3 in no work item on PUB400". */
export function describeTrackedGroup(group: TrackedGroup): string {
  const where = isDefaultWorkItem(group.workItem) ? "no work item" : `work item ${group.workItem}`;
  return `${group.count} in ${where}${group.system ? ` on ${group.system}` : ""}`;
}

export function systemKey(system: string): string {
  return system.toLocaleUpperCase("en-US");
}

export function buildCheckoutId(
  system: string,
  library: string,
  sourceFile: string,
  memberName: string
): string {
  // "/" cannot appear in IBM i object names, so ids of different members never collide.
  return `${system}/${library}/${sourceFile}/${memberName}`.toUpperCase();
}

/** An IBM i system name: a library, file or member as it appears in a local path and a host command. */
const SYSTEM_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i;

/** A source type, used as the local file extension. */
const SOURCE_TYPE = /^[A-Z0-9_$#@.]{1,10}$/i;

/**
 * Why a member can't be checked out under these names, or undefined when it can. Names come from
 * Object Browser nodes, command arguments and the IBM i, and become local path segments; "/", "\\",
 * ".." or a drive letter would place the file outside the checkout folder.
 */
export function memberNameProblem(
  member: { library: string; sourceFile: string; memberName: string; extension: string }
): string | undefined {
  const names: Array<[string, string]> = [
    ["library", member.library],
    ["source file", member.sourceFile],
    ["member", member.memberName],
  ];
  for (const [label, value] of names) {
    if (!SYSTEM_NAME.test(value)) {
      return `"${value}" is not a valid IBM i ${label} name.`;
    }
  }
  return SOURCE_TYPE.test(member.extension)
    ? undefined
    : `"${member.extension}" is not a valid source type.`;
}

export function buildLocalFileName(entry: CheckedOutMember): string {
  return `${entry.memberName}.${entry.extension}`.toUpperCase();
}

export function sanitizeSystemName(system: string): string {
  const sanitized = [...system]
    .map((character) => character.charCodeAt(0) < 32 ? "_" : character)
    .join("")
    .replace(/[\\/:*?"<>|]/g, "_");
  return sanitized === "" || sanitized === "." || sanitized === ".." ? "_" : sanitized;
}

export function formatMemberPath(entry: CheckedOutMember): string {
  return `${entry.library}/${entry.sourceFile}(${entry.memberName})`;
}

export type TreeItemType =
  | { kind: "sourceFile"; system: string; library: string; sourceFile: string }
  | { kind: "member"; entry: CheckedOutMember };

/**
 * The stored checkout a command argument refers to. Commands receive tree items, but a `command:`
 * link can pass any object, so only its system and id are used, to find the real checkout.
 */
export function storedEntryFor(
  item: unknown,
  entriesFor: (system: string) => readonly CheckedOutMember[]
): CheckedOutMember | undefined {
  const entry = (item as { kind?: unknown; entry?: { system?: unknown; id?: unknown } } | undefined)?.entry;
  if ((item as { kind?: unknown } | undefined)?.kind !== "member" ||
      typeof entry?.system !== "string" || typeof entry.id !== "string") {
    return undefined;
  }
  const id = entry.id;
  return entriesFor(entry.system).find((stored) => stored.id === id);
}
