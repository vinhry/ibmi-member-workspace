import { DOWNLOAD_CONCURRENCY, mapWithLimit } from "./concurrency";
import type { MemberInfo } from "./memberInfo";
import { CheckedOutMember, formatMemberPath, isReferenceCopy } from "./types";

/**
 * Bringing members as read-only reference copies for an AI agent to read. The members may be
 * production source, so this never creates a checkout that can be changed: every member is
 * checked out with `reference: true`, which no caller can override. A member already checked
 * out for change is left exactly as it is. Kept free of the `vscode` module so it can be unit tested.
 */

/** The checkout options this module passes; `reference` is always true. */
export interface ReferenceCheckoutOptions {
  reference: true;
  redownloadBehavior: "skip";
  suppressAutoOpen: true;
  discardLocalChanges: false;
  deferCheckpointTo: string[];
}

export interface ReferenceCopyIo {
  findEntry(library: string, sourceFile: string, memberName: string): CheckedOutMember | undefined;
  checkoutMember(
    library: string,
    sourceFile: string,
    memberName: string,
    extension: string,
    options: ReferenceCheckoutOptions
  ): Promise<CheckedOutMember>;
  log(message: string): void;
}

export type ReferenceCopyStatus =
  /** Downloaded now as a read-only reference copy. */
  | "brought"
  /** Already a reference copy; the local copy was kept. */
  | "alreadyReference"
  /** Checked out for change before; left untouched and still editable by the user. */
  | "checkedOutForChange"
  /** Not brought: the request was abandoned first. */
  | "cancelled"
  | "failed";

export interface ReferenceCopyResult {
  member: string;
  status: ReferenceCopyStatus;
  localPath?: string;
  readOnly?: boolean;
  error?: string;
}

/**
 * Brings each member as a reference copy, a few at a time ({@link DOWNLOAD_CONCURRENCY} unless
 * `limit` says otherwise), in the members' order; one failing never stops the others. Once `signal`
 * aborts, the members not started yet are reported as cancelled.
 */
export async function bringReferenceCopies(
  io: ReferenceCopyIo,
  members: readonly MemberInfo[],
  checkpointPaths: string[],
  signal?: AbortSignal,
  { limit = DOWNLOAD_CONCURRENCY }: { limit?: number } = {}
): Promise<ReferenceCopyResult[]> {
  const settled = await mapWithLimit(members, limit, (m) => bringOne(io, m, checkpointPaths), { signal });
  return settled.map((result, index) =>
    result.status === "fulfilled" ? result.value : { member: memberLabel(members[index]), status: "cancelled" }
  );
}

function memberLabel(m: MemberInfo): string {
  return `${m.library}/${m.sourceFile}(${m.memberName})`.toUpperCase();
}

/** Brings one member; never rejects, a failure is a result. */
async function bringOne(io: ReferenceCopyIo, m: MemberInfo, checkpointPaths: string[]): Promise<ReferenceCopyResult> {
  const member = memberLabel(m);
  const existing = io.findEntry(m.library, m.sourceFile, m.memberName);
  if (existing) {
    const reference = isReferenceCopy(existing);
    return {
      member: formatMemberPath(existing),
      status: reference ? "alreadyReference" : "checkedOutForChange",
      localPath: existing.localPath,
      readOnly: reference,
    };
  }
  try {
    const entry = await io.checkoutMember(m.library, m.sourceFile, m.memberName, m.extension, {
      reference: true,
      redownloadBehavior: "skip",
      suppressAutoOpen: true,
      discardLocalChanges: false,
      deferCheckpointTo: checkpointPaths,
    });
    const reference = isReferenceCopy(entry);
    io.log(`[bob] ${reference ? "reference" : "kept"}: ${formatMemberPath(entry)}`);
    return {
      member: formatMemberPath(entry),
      status: reference ? "brought" : "checkedOutForChange",
      localPath: entry.localPath,
      readOnly: reference,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    io.log(`[bob] Could not bring ${member}: ${error}`);
    return { member, status: "failed", error };
  }
}
