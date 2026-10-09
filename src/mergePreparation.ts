import { classifyStatus, hashContent } from "./sync";
import { CheckedOutMember, formatMemberPath, isReferenceCopy, sanitizeSystemName } from "./types";

/**
 * What a Merge Back needs decided before anything is shown: which editor to open with which texts.
 * Kept free of the `vscode` module so it can be unit tested; `mergeHandler.ts` does the showing.
 */

export interface MergeSide {
  text: string;
  hash: string;
}

export type MergePlan =
  /** Local and IBM i are the same text. */
  | { kind: "in-sync" }
  /** Only the local copy changed since checkout: an upload sends it, nothing to merge. */
  | { kind: "remote-unchanged"; local: MergeSide; remote: MergeSide }
  /** Only the IBM i copy changed since checkout: a re-checkout takes it, nothing to merge. */
  | { kind: "local-unchanged"; local: MergeSide; remote: MergeSide }
  /** Both changed, and the common ancestor is known. */
  | { kind: "three-way"; base: MergeSide; local: MergeSide; remote: MergeSide }
  /** Both changed, but the text at checkout isn't kept (checked out before 1.8.10): compare the two. */
  | { kind: "two-way"; local: MergeSide; remote: MergeSide; reason: "no-baseline" };

function side(text: string): MergeSide {
  return { text, hash: hashContent(text) };
}

/**
 * Decides the merge from the local text, the IBM i's text now, and the baseline recorded at
 * checkout. The baseline text may be missing or damaged; then whichever side still hashes to the
 * baseline is the base (and `healedFrom` says which, so the caller can keep it).
 */
export function planMerge(
  localText: string,
  remoteText: string,
  baselineHash: string,
  baselineText: string | undefined
): { plan: MergePlan; healedFrom?: "local" | "remote" } {
  const local = side(localText);
  const remote = side(remoteText);
  switch (classifyStatus(local.hash, remote.hash, baselineHash)) {
    case "in-sync":
      return { plan: { kind: "in-sync" } };
    case "modified":
      return { plan: { kind: "remote-unchanged", local, remote } };
    case "remote-changed":
      return { plan: { kind: "local-unchanged", local, remote } };
    default:
      break;
  }
  if (baselineText !== undefined && hashContent(baselineText) === baselineHash) {
    return { plan: { kind: "three-way", base: side(baselineText), local, remote } };
  }
  // Both sides differ from the baseline here, so neither can stand in for it: compare the two.
  return { plan: { kind: "two-way", local, remote, reason: "no-baseline" } };
}

/**
 * The baseline after the merge editor's result was saved over the local copy. The IBM i's text
 * the user merged against becomes the common ancestor, so an upload no longer warns about those
 * remote changes; unless the saved text is still the local snapshot (nothing was merged), in
 * which case the baseline stands and an upload still asks before overwriting the IBM i.
 */
export function baselineAfterMergeSave(
  savedHash: string,
  localSnapshotHash: string,
  remoteHash: string,
  currentBaseline: string
): string {
  return savedHash === localSnapshotHash ? currentBaseline : remoteHash;
}

/** The snapshot files one member's merge or comparison uses, relative to the extension storage. */
export function mergeSnapshotPaths(entry: CheckedOutMember): { dir: string[]; base: string; remote: string; local: string } {
  // The same upper-case extension as the local file, so the snapshots get its language.
  const extension = entry.extension ? `.${entry.extension.toUpperCase()}` : "";
  const dir = ["merge", sanitizeSystemName(entry.system), entry.library, entry.sourceFile, entry.memberName];
  return { dir, base: `base${extension}`, remote: `ibmi${extension}`, local: `local${extension}` };
}

/** The argument of VS Code's `_open.mergeEditor`: the IBM i on the left, the local copy on the right. */
export function mergeEditorArguments<U>(
  uris: { base: U; remote: U; local: U; output: U },
  entry: CheckedOutMember
): { base: U; input1: { uri: U; title: string; description: string }; input2: { uri: U; title: string; description: string }; output: U } {
  return {
    base: uris.base,
    input1: { uri: uris.remote, title: "IBM i now", description: `${formatMemberPath(entry)} on ${entry.system}` },
    input2: { uri: uris.local, title: "Local (yours)", description: entry.localPath },
    output: uris.output,
  };
}

export interface MergeCandidate {
  entry: CheckedOutMember;
  /** Preselected: members changed on the IBM i, with or without local changes. */
  picked: boolean;
  /** Why the member can't be merged, when it can't. */
  skip?: "reference" | "remote-missing";
}

/** The members of a multi-selection a Merge Back can offer, conflicts and remote changes first. */
export function selectMergeCandidates(entries: readonly CheckedOutMember[]): MergeCandidate[] {
  return entries.map((entry) => {
    if (isReferenceCopy(entry)) {
      return { entry, picked: false, skip: "reference" as const };
    }
    if (entry.status === "remote-missing") {
      return { entry, picked: false, skip: "remote-missing" as const };
    }
    return { entry, picked: entry.status === "conflict" || entry.status === "remote-changed" };
  });
}
