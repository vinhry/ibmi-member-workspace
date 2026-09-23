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
  status: CheckoutStatus;
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
  return migrateWorkItems("workspace", { workspace: value.entries });
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

export function systemKey(system: string): string {
  return system.toLocaleUpperCase("en-US");
}

export function buildCheckoutId(
  system: string,
  library: string,
  sourceFile: string,
  memberName: string
): string {
  return `${system}_${library}_${sourceFile}_${memberName}`.toUpperCase();
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
