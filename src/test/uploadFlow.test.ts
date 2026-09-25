import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UploadResult } from "../checkoutService";
import type { CheckedOutMember } from "../types";
import { UploadFlowDeps, runUploadFlow } from "../uploadFlow";

const entry: CheckedOutMember = {
  id: "SYS|MYLIB|QRPGLESRC|PROG",
  system: "SYS",
  library: "MYLIB",
  sourceFile: "QRPGLESRC",
  memberName: "PROG",
  extension: "rpgle",
  localPath: "/tmp/PROG.RPGLE",
  checkedOutAt: "2026-01-01T00:00:00.000Z",
  remoteHashAtCheckout: "abc",
  status: "modified",
};

/** Records every call; `results` are returned by successive uploads. */
function fakeDeps(options: {
  results: Array<UploadResult | Error>;
  remoteChoice?: "overwrite" | "diff";
  mergeBack?: boolean;
}) {
  const calls: string[] = [];
  const results = [...options.results];
  const deps: UploadFlowDeps = {
    upload: async (_member, uploadOptions) => {
      calls.push(uploadOptions?.overwriteRemoteChanges ? "upload(overwrite)" : "upload");
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result ?? "failed";
    },
    resolveRemoteChange: async () => {
      calls.push("resolveRemoteChange");
      return options.remoteChoice;
    },
    openMerge: async () => {
      calls.push("openMerge");
    },
    notifyUploaded: (_member, quiet) => {
      calls.push(quiet ? "notifyUploaded(quiet)" : "notifyUploaded");
    },
    notifyAltered: async () => {
      calls.push("notifyAltered");
      return options.mergeBack ?? false;
    },
    notifyFailed: (_member, error) => {
      calls.push(error === undefined ? "notifyFailed" : `notifyFailed(${(error as Error).message})`);
    },
  };
  return { deps, calls };
}

describe("runUploadFlow", () => {
  it("reports a successful upload", async () => {
    const { deps, calls } = fakeDeps({ results: ["uploaded"] });
    assert.equal(await runUploadFlow(entry, deps), "uploaded");
    assert.deepEqual(calls, ["upload", "notifyUploaded"]);
  });

  it("reports a quiet automatic upload quietly", async () => {
    const { deps, calls } = fakeDeps({ results: ["uploaded"] });
    assert.equal(await runUploadFlow(entry, deps, { quiet: true }), "uploaded");
    assert.deepEqual(calls, ["upload", "notifyUploaded(quiet)"]);
  });

  it("overwrites remote changes only after the user chooses to", async () => {
    const { deps, calls } = fakeDeps({ results: ["remote-changed", "uploaded"], remoteChoice: "overwrite" });
    assert.equal(await runUploadFlow(entry, deps), "uploaded");
    assert.deepEqual(calls, ["upload", "resolveRemoteChange", "upload(overwrite)", "notifyUploaded"]);
  });

  it("still asks about remote changes during a quiet automatic upload", async () => {
    const { deps, calls } = fakeDeps({ results: ["remote-changed"] });
    assert.equal(await runUploadFlow(entry, deps, { quiet: true }), "kept-remote");
    assert.deepEqual(calls, ["upload", "resolveRemoteChange"]);
  });

  it("opens Merge Back instead of overwriting when the user chooses Show Diff", async () => {
    const { deps, calls } = fakeDeps({ results: ["remote-changed"], remoteChoice: "diff" });
    assert.equal(await runUploadFlow(entry, deps), "showing-diff");
    assert.deepEqual(calls, ["upload", "resolveRemoteChange", "openMerge"]);
  });

  it("offers Merge Back when the IBM i stored something different", async () => {
    const accepted = fakeDeps({ results: ["uploaded-altered"], mergeBack: true });
    assert.equal(await runUploadFlow(entry, accepted.deps), "uploaded-altered");
    assert.deepEqual(accepted.calls, ["upload", "notifyAltered", "openMerge"]);

    const dismissed = fakeDeps({ results: ["uploaded-altered"] });
    assert.equal(await runUploadFlow(entry, dismissed.deps), "uploaded-altered");
    assert.deepEqual(dismissed.calls, ["upload", "notifyAltered"]);
  });

  it("reports a failed upload", async () => {
    const { deps, calls } = fakeDeps({ results: ["failed"] });
    assert.equal(await runUploadFlow(entry, deps), "failed");
    assert.deepEqual(calls, ["upload", "notifyFailed"]);
  });

  it("reports an upload error", async () => {
    const { deps, calls } = fakeDeps({ results: [new Error("Not connected to IBM i")] });
    assert.equal(await runUploadFlow(entry, deps), "failed");
    assert.deepEqual(calls, ["upload", "notifyFailed(Not connected to IBM i)"]);
  });
});
