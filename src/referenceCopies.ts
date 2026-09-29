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
  | "failed";

export interface ReferenceCopyResult {
  member: string;
  status: ReferenceCopyStatus;
  localPath?: string;
  readOnly?: boolean;
  error?: string;
}

/** Brings each member as a reference copy, one at a time; one failing never stops the others. */
export async function bringReferenceCopies(
  io: ReferenceCopyIo,
  members: readonly MemberInfo[],
  checkpointPaths: string[]
): Promise<ReferenceCopyResult[]> {
  const results: ReferenceCopyResult[] = [];
  for (const m of members) {
    const member = `${m.library}/${m.sourceFile}(${m.memberName})`.toUpperCase();
    const existing = io.findEntry(m.library, m.sourceFile, m.memberName);
    if (existing) {
      const reference = isReferenceCopy(existing);
      results.push({
        member: formatMemberPath(existing),
        status: reference ? "alreadyReference" : "checkedOutForChange",
        localPath: existing.localPath,
        readOnly: reference,
      });
      continue;
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
      results.push({
        member: formatMemberPath(entry),
        status: reference ? "brought" : "checkedOutForChange",
        localPath: entry.localPath,
        readOnly: reference,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      io.log(`[bob] Could not bring ${member}: ${error}`);
      results.push({ member, status: "failed", error });
    }
  }
  return results;
}
