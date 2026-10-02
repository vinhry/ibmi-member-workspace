import type { UploadResult } from "./checkoutService";
import type { CheckedOutMember } from "./types";

/** The user-facing steps of an upload, supplied by the caller so the flow can be tested without VS Code. */
export interface UploadFlowDeps {
  upload(
    entry: CheckedOutMember,
    options?: { overwriteRemoteChanges?: boolean; ignoreSourceProblems?: boolean }
  ): Promise<UploadResult>;
  /**
   * Asks whether to upload a local copy with lines too long for the source file or characters its
   * CCSID can't store; "upload" uploads it anyway. `quiet` for automatic uploads, which mustn't wait.
   */
  resolveSourceProblems(entry: CheckedOutMember, quiet: boolean): Promise<"upload" | undefined>;
  /** Asks what to do about changes made on the IBM i since checkout; undefined when dismissed. */
  resolveRemoteChange(entry: CheckedOutMember): Promise<"overwrite" | "diff" | undefined>;
  openMerge(entry: CheckedOutMember): Promise<void>;
  /** Reports a successful upload; `quiet` for automatic uploads, which only flash the status bar. */
  notifyUploaded(entry: CheckedOutMember, quiet: boolean): void;
  /** Warns that the stored member differs from the local file; true when the user chose Merge Back. */
  notifyAltered(entry: CheckedOutMember): Promise<boolean>;
  notifyFailed(entry: CheckedOutMember, error?: unknown): void;
}

export type UploadFlowOutcome =
  | "uploaded"
  | "uploaded-altered"
  | "failed"
  /** The local copy has text the source member can't hold, and the user didn't upload it. */
  | "source-problems"
  /** Remote changes were found and the user left the member alone. */
  | "kept-remote"
  /** Remote changes were found and the user opened Merge Back instead. */
  | "showing-diff";

/**
 * Uploads one member, handling every upload result the same way for the
 * Upload command and upload on save. Changes made on the IBM i since checkout,
 * and text the source member can't hold, are never uploaded without asking,
 * even for a quiet automatic upload. The checks and the read-back after upload
 * stay in `CheckoutService.uploadToRemote`. `ignoreSourceProblems` is for an
 * upload the user already chose to make anyway.
 */
export async function runUploadFlow(
  entry: CheckedOutMember,
  deps: UploadFlowDeps,
  { quiet = false, ignoreSourceProblems = false }: { quiet?: boolean; ignoreSourceProblems?: boolean } = {}
): Promise<UploadFlowOutcome> {
  try {
    let result = await deps.upload(entry, { ignoreSourceProblems });
    if (result === "source-problems") {
      if ((await deps.resolveSourceProblems(entry, quiet)) !== "upload") {
        return "source-problems";
      }
      ignoreSourceProblems = true;
      result = await deps.upload(entry, { ignoreSourceProblems });
    }
    if (result === "remote-changed") {
      const choice = await deps.resolveRemoteChange(entry);
      if (choice === "diff") {
        await deps.openMerge(entry);
        return "showing-diff";
      }
      if (choice !== "overwrite") {
        return "kept-remote";
      }
      result = await deps.upload(entry, { overwriteRemoteChanges: true, ignoreSourceProblems });
    }

    switch (result) {
      case "uploaded":
        deps.notifyUploaded(entry, quiet);
        return "uploaded";
      case "uploaded-altered":
        if (await deps.notifyAltered(entry)) {
          await deps.openMerge(entry);
        }
        return "uploaded-altered";
      default:
        deps.notifyFailed(entry);
        return "failed";
    }
  } catch (err) {
    deps.notifyFailed(entry, err);
    return "failed";
  }
}
