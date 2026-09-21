import * as crypto from "crypto";

export type RemoteStatus = "in-sync" | "modified" | "remote-changed" | "conflict";

export function hashContent(content: string, trimTrailingWhitespace: boolean): string {
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
