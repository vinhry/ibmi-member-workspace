import type { Resolution, SourceMemberRow } from "./dependencyResolve";
import { errorMessage } from "./errors";
import { RawReference, isCobolType } from "./dependencyScan";
import type { DependencySubject, ProviderOutcome } from "./dependencySources";

/**
 * Find All Dependencies: what a member uses, what those members use, and so on. The walk is
 * breadth-first because a member's source has to be read before its own dependencies are known.
 * Each member is looked into once (so A → B → A ends), and the walk stops to ask at a depth
 * and a member limit, since a shared copybook or utility program can reach half the system.
 * IBM i calls are injected, keeping this module testable.
 */

export interface WalkLookup {
  resolution: Resolution;
  outcomes: ProviderOutcome[];
}

export interface WalkLimits {
  /** Levels below the root to list; members on the last level are listed but not looked into. */
  maxDepth: number;
  /** Members to list, not counting the root. */
  maxMembers: number;
}

export interface WalkLimitReached {
  reason: "depth" | "members";
  /** Members found so far. */
  members: number;
  /** The deepest level found so far. */
  depth: number;
}

export interface WalkProgress {
  members: number;
  /** The level of the member being looked into; the root is 0. */
  depth: number;
  member: string;
}

/**
 * The source type a found member is scanned as. A copybook without a source type is written in
 * the language of the member that copies it, and a COBOL copybook is COBOL whatever its type
 * (shops use CPY, CBLLE, blank and others).
 */
function scanTypeOf(reference: RawReference, sourceType: string, parentType: string): string {
  if (reference.kind === "copybook" && (!sourceType || isCobolType(parentType))) {
    return parentType.toLowerCase();
  }
  return (sourceType || "mbr").toLowerCase();
}

export interface WalkIo {
  lookup(subject: DependencySubject): Promise<WalkLookup>;
  /** Asked when a limit is reached; true raises it by its first value and goes on. */
  onLimit(reached: WalkLimitReached): Promise<boolean>;
  cancelled(): boolean;
  progress?(state: WalkProgress): void;
}

export interface WalkNode {
  /** The member, with the extension its source is scanned as. */
  subject: DependencySubject;
  /** 1 for what the root uses directly. */
  depth: number;
  /** How the member that uses it refers to it. */
  reference: RawReference;
  /** Matching source members, best first; the walk follows the first. */
  candidates: SourceMemberRow[];
  /** Members between the root and this one, e.g. ["ORD200", "ORDHDR"]; empty for direct dependencies. */
  via: string[];
}

export interface WalkUnresolved {
  reference: RawReference;
  /** Members between the root and the one whose reference this is; empty for the root's own. */
  via: string[];
}

export interface WalkFailure {
  /** LIB/FILE(MEMBER). */
  member: string;
  via: string[];
  error: string;
}

export interface WalkResult {
  nodes: WalkNode[];
  unresolved: WalkUnresolved[];
  failed: WalkFailure[];
  /** What each provider reported, per member looked into. */
  outcomes: Array<{ member: string; outcomes: ProviderOutcome[] }>;
  /** The user chose to stop at a limit, so some members were not looked into. */
  stopped: boolean;
  cancelled: boolean;
}

export function subjectKey(subject: Pick<DependencySubject, "library" | "sourceFile" | "memberName">): string {
  return `${subject.library}/${subject.sourceFile}(${subject.memberName})`.toUpperCase();
}

interface Pending {
  subject: DependencySubject;
  depth: number;
  /** `via` of the members this one refers to. */
  path: string[];
}

export async function walkDependencies(
  root: DependencySubject,
  io: WalkIo,
  limits: WalkLimits
): Promise<WalkResult> {
  const result: WalkResult = { nodes: [], unresolved: [], failed: [], outcomes: [], stopped: false, cancelled: false };
  const visited = new Set([subjectKey(root)]);
  let maxDepth = Math.max(1, limits.maxDepth);
  let maxMembers = Math.max(1, limits.maxMembers);
  let queue: Pending[] = [{ subject: root, depth: 0, path: [] }];
  // Members listed on the last allowed level, looked into only if the user raises the depth limit.
  let deferred: Pending[] = [];

  walk: for (;;) {
    if (queue.length === 0) {
      if (deferred.length === 0) {
        break;
      }
      const deepest = Math.max(...deferred.map((pending) => pending.depth));
      if (!(await io.onLimit({ reason: "depth", members: result.nodes.length, depth: deepest }))) {
        result.stopped = true;
        break;
      }
      maxDepth += Math.max(1, limits.maxDepth);
      queue = deferred;
      deferred = [];
    }
    if (io.cancelled()) {
      result.cancelled = true;
      break;
    }
    const current = queue.shift()!;
    io.progress?.({ members: result.nodes.length, depth: current.depth, member: current.subject.memberName });

    let lookup: WalkLookup;
    try {
      lookup = await io.lookup(current.subject);
    } catch (err) {
      result.failed.push({
        member: subjectKey(current.subject),
        via: current.path.slice(0, -1),
        error: errorMessage(err),
      });
      continue;
    }
    result.outcomes.push({ member: subjectKey(current.subject), outcomes: lookup.outcomes });
    result.unresolved.push(...lookup.resolution.unresolved.map((reference) => ({ reference, via: current.path })));

    for (const { reference, candidates } of lookup.resolution.resolved) {
      const [best] = candidates;
      if (reference.kind === "procedure" || !best) {
        continue;
      }
      const subject: DependencySubject = {
        library: best.library,
        sourceFile: best.sourceFile,
        memberName: best.member,
        extension: scanTypeOf(reference, best.sourceType, current.subject.extension),
      };
      const key = subjectKey(subject);
      if (visited.has(key)) {
        continue;
      }
      if (result.nodes.length >= maxMembers) {
        const depth = result.nodes[result.nodes.length - 1]?.depth ?? 0;
        if (!(await io.onLimit({ reason: "members", members: result.nodes.length, depth }))) {
          result.stopped = true;
          break walk;
        }
        maxMembers += Math.max(1, limits.maxMembers);
      }
      visited.add(key);
      const node: WalkNode = { subject, depth: current.depth + 1, reference, candidates, via: current.path };
      result.nodes.push(node);
      const next: Pending = { subject, depth: node.depth, path: [...current.path, best.member] };
      (node.depth < maxDepth ? queue : deferred).push(next);
    }
  }
  return result;
}

/** One outcome per provider across every member looked into, for the one-line summary. */
export function mergeOutcomes(perMember: WalkResult["outcomes"]): ProviderOutcome[] {
  const merged = new Map<string, ProviderOutcome>();
  for (const outcome of perMember.flatMap((member) => member.outcomes)) {
    const known = merged.get(outcome.label);
    if (!known) {
      merged.set(outcome.label, { ...outcome });
    } else if (outcome.status === "ran") {
      const note = known.status === "ran" ? known.note ?? outcome.note : outcome.note;
      const count = known.status === "ran" ? known.count + outcome.count : outcome.count;
      merged.set(outcome.label, { ...outcome, count, ...(note === undefined ? {} : { note }) });
    }
  }
  return [...merged.values()];
}
