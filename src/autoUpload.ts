import type { CheckedOutMember, CheckoutStatus } from "./types";

export type AutoUploadMode = "off" | "ask" | "silent";

export const AUTO_UPLOAD_MODES: readonly AutoUploadMode[] = ["off", "ask", "silent"];

/** Coalesces a burst of saves to one file into a single upload. */
export const AUTO_UPLOAD_DEBOUNCE_MS = 300;

/** How long to wait before trying again while another checkout, upload, or switch is running. */
export const AUTO_UPLOAD_BUSY_RETRY_MS = 1000;

export interface AutoUploadDeps {
  mode(): AutoUploadMode;
  /** The checkout for a local file in the active work item, resolved when the upload runs. */
  findEntry(localPath: string): CheckedOutMember | undefined;
  /** Why this checkout can't be uploaded now (e.g. disconnected), or undefined when it can. */
  skipReason(entry: CheckedOutMember): string | undefined;
  /** Whether another checkout, upload, or work-item operation is running. */
  isBusy(): boolean;
  /** Asks before uploading in "ask" mode; "always" switches to silent. Undefined when declined. */
  confirm(entry: CheckedOutMember): Promise<"upload" | "always" | undefined>;
  setMode(mode: AutoUploadMode): Promise<void>;
  upload(entry: CheckedOutMember): Promise<void>;
  log(message: string): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * Whether a saved checkout has local edits worth uploading. "in-sync", "merged"
 * and a fresh "checked-out" match the IBM i already; "remote-changed" means only
 * the IBM i changed, so uploading would overwrite it with the unchanged base.
 */
export function hasLocalEditsToUpload(status: CheckoutStatus): boolean {
  return status === "modified" || status === "conflict";
}

/**
 * Uploads checked-out members after they are saved in the editor, according to
 * the `autoUploadOnSave` setting. One upload runs per file at a time; a save
 * during an upload or an open prompt uploads the latest content afterwards
 * instead of being dropped.
 */
export class AutoUploadScheduler {
  private readonly timers = new Map<string, unknown>();
  private readonly inFlight = new Set<string>();
  private readonly asking = new Set<string>();
  /** Files saved again while an upload or prompt was in progress. */
  private readonly rerun = new Set<string>();

  constructor(private readonly deps: AutoUploadDeps) {}

  /** Called after a checked-out file is saved in the editor. */
  schedule(localPath: string, delayMs = AUTO_UPLOAD_DEBOUNCE_MS): void {
    if (this.deps.mode() === "off") {
      return;
    }
    const pending = this.timers.get(localPath);
    if (pending !== undefined) {
      this.deps.clearTimer(pending);
    }
    this.timers.set(
      localPath,
      this.deps.setTimer(() => {
        this.timers.delete(localPath);
        void this.run(localPath);
      }, delayMs)
    );
  }

  dispose(): void {
    for (const handle of this.timers.values()) {
      this.deps.clearTimer(handle);
    }
    this.timers.clear();
  }

  private async run(localPath: string): Promise<void> {
    if (this.inFlight.has(localPath) || this.asking.has(localPath)) {
      this.rerun.add(localPath);
      return;
    }
    const mode = this.deps.mode();
    let entry = this.uploadable(localPath, mode);
    if (!entry) {
      return;
    }
    if (this.deps.isBusy()) {
      this.schedule(localPath, AUTO_UPLOAD_BUSY_RETRY_MS);
      return;
    }

    if (mode === "ask") {
      this.asking.add(localPath);
      let choice: "upload" | "always" | undefined;
      try {
        choice = await this.deps.confirm(entry);
      } finally {
        this.asking.delete(localPath);
      }
      // The upload below reads the file as it is now, so saves made meanwhile are included.
      this.rerun.delete(localPath);
      if (!choice) {
        this.deps.log(`[auto-upload] Not uploaded: ${localPath} (declined)`);
        return;
      }
      if (choice === "always") {
        await this.deps.setMode("silent");
      }
      // The work item or status may have changed while the prompt was open.
      entry = this.uploadable(localPath, this.deps.mode());
      if (!entry) {
        return;
      }
      if (this.deps.isBusy()) {
        this.schedule(localPath, AUTO_UPLOAD_BUSY_RETRY_MS);
        return;
      }
    }

    this.inFlight.add(localPath);
    this.rerun.delete(localPath);
    try {
      await this.deps.upload(entry);
    } catch (err) {
      this.deps.log(`[auto-upload] Upload failed for ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(localPath);
    }
    if (this.rerun.delete(localPath)) {
      this.schedule(localPath);
    }
  }

  /** The checkout to upload for `localPath`, or undefined (with a log line) when it should be skipped. */
  private uploadable(localPath: string, mode: AutoUploadMode): CheckedOutMember | undefined {
    if (mode === "off") {
      return undefined;
    }
    const entry = this.deps.findEntry(localPath);
    if (!entry) {
      return undefined;
    }
    if (!hasLocalEditsToUpload(entry.status)) {
      return undefined;
    }
    const reason = this.deps.skipReason(entry);
    if (reason) {
      this.deps.log(`[auto-upload] Not uploaded: ${localPath} (${reason})`);
      return undefined;
    }
    return entry;
  }
}
