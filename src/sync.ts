import * as crypto from "crypto";
import { CheckoutStatus } from "./types";

export type RemoteStatus = "in-sync" | "modified" | "remote-changed" | "conflict";

/** `CheckedOutMember.hashVersion` of baselines computed with {@link hashContent}. */
export const HASH_VERSION = 2;

/**
 * The significant text of a source member. Records are blank-padded, so a BOM,
 * CRLF vs LF, trailing blanks on a line, and blank lines at the end carry no
 * meaning. Leading and embedded blank lines are kept.
 */
export function canonicalMemberText(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(canonicalMemberText(content), "utf-8").digest("hex");
}

/**
 * The hash used before {@link HASH_VERSION} 2. It depended on the editor's
 * `files.trimTrailingWhitespace` setting and kept a BOM; only used to upgrade
 * baselines stored by older versions.
 */
export function legacyHashContent(content: string, trimTrailingWhitespace: boolean): string {
  let normalized = content.replace(/\r\n/g, "\n");
  if (trimTrailingWhitespace) {
    normalized = normalized.replace(/[ \t]+$/gm, "");
  }
  // Only a trailing run of blank lines is ignored (anchored to the very end of
  // the string, no /m flag) — leading/embedded blank lines are left untouched.
  normalized = normalized.replace(/\n+$/, "");
  return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Converts a baseline stored by an older version to {@link hashContent}. A
 * candidate (the live remote or local text) whose legacy hash equals the
 * baseline is the checkout's base content, so its current hash is the new
 * baseline. The trim setting may have changed since checkout, so both legacy
 * variants are tried. Undefined when no candidate is unchanged since checkout.
 */
export function migrateLegacyBaseline(
  baseline: string,
  candidates: readonly string[]
): string | undefined {
  const base = candidates.find((text) =>
    legacyHashContent(text, false) === baseline || legacyHashContent(text, true) === baseline
  );
  return base === undefined ? undefined : hashContent(base);
}

/**
 * Three-way comparison of the local copy, the live remote member, and the
 * baseline hash recorded at checkout/upload time. Local and remote were
 * identical at that point, so the baseline is their common ancestor.
 */
export function classifyStatus(
  localHash: string,
  remoteHash: string,
  baselineHash: string
): RemoteStatus {
  if (localHash === remoteHash) {
    return "in-sync";
  }
  if (remoteHash === baselineHash) {
    return "modified";
  }
  if (localHash === baselineHash) {
    return "remote-changed";
  }
  return "conflict";
}

/**
 * The baseline to record after comparing local and remote. When both sides are
 * identical (e.g. after a Merge Back save) that content is the new common
 * ancestor; otherwise the existing baseline stands.
 */
export function nextBaseline(
  localHash: string,
  remoteHash: string,
  baselineHash: string
): string {
  return localHash === remoteHash ? remoteHash : baselineHash;
}

/**
 * Status after the local copy is saved, assuming the remote is unchanged since
 * it was last checked. `localChanged` is whether local now differs from the baseline.
 */
export function statusAfterLocalSave(
  status: CheckoutStatus,
  localChanged: boolean
): CheckoutStatus {
  if (localChanged) {
    switch (status) {
      case "checked-out":
      case "in-sync":
      case "merged":
        return "modified";
      case "remote-changed":
        return "conflict";
      default:
        return status;
    }
  }
  switch (status) {
    case "modified":
      return "in-sync";
    case "conflict":
      return "remote-changed";
    default:
      return status;
  }
}

/**
 * Baseline and status after an upload, from the member as re-read from the
 * IBM i. The IBM i can alter what it stores (e.g. truncating lines longer than
 * the record length), so the remote copy, not the local one, is the new baseline.
 */
export function statusAfterUpload(
  localHash: string,
  remoteHashAfterUpload: string
): { baseline: string; status: CheckoutStatus; altered: boolean } {
  const altered = localHash !== remoteHashAfterUpload;
  return {
    baseline: remoteHashAfterUpload,
    status: altered ? "modified" : "merged",
    altered,
  };
}

/**
 * Shapes a local file for upload: the same text that {@link hashContent}
 * hashes, so the upload and the sync status can't disagree. Code for IBM i's
 * source-date save splits the body on "\n" and diffs it line by line against
 * the member as read with SQL (LF-joined, no trailing newline): a BOM or CRLF
 * endings would mark every line changed, and each trailing blank line would
 * become a blank last record that breaks compiles.
 */
export function normalizeForMemberUpload(content: string): string {
  return canonicalMemberText(content);
}
