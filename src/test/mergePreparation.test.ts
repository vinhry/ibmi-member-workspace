import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baselineAfterMergeSave,
  mergeEditorArguments,
  mergeSnapshotPaths,
  planMerge,
  selectMergeCandidates,
} from "../mergePreparation";
import { hashContent } from "../sync";
import type { CheckedOutMember } from "../types";

const base = "A\nB\nC\n";
const local = "A\nB changed locally\nC\n";
const remote = "A\nB\nC changed on the IBM i\n";
const baseHash = hashContent(base);

function entry(overrides: Partial<CheckedOutMember> = {}): CheckedOutMember {
  return {
    id: "DEV:MYLIB/QRPGLESRC/ORD100", system: "Dev:1", library: "MYLIB", sourceFile: "QRPGLESRC", memberName: "ORD100",
    extension: "rpgle", localPath: "/c/Dev_1/MYLIB/QRPGLESRC/ORD100.rpgle", checkedOutAt: "", remoteHashAtCheckout: baseHash,
    status: "conflict", ...overrides,
  };
}

describe("planMerge", () => {
  it("has nothing to merge when both sides are the same text, whatever the line endings", () => {
    assert.deepEqual(planMerge("A\r\nB  \r\n", "﻿A\nB\n\n", baseHash, undefined).plan, { kind: "in-sync" });
  });

  it("sends an upload when only the local copy changed, and a re-checkout when only the IBM i did", () => {
    assert.equal(planMerge(local, base, baseHash, base).plan.kind, "remote-unchanged");
    assert.equal(planMerge(base, remote, baseHash, base).plan.kind, "local-unchanged");
  });

  it("merges three ways when both changed and the baseline text is kept", () => {
    const { plan, healedFrom } = planMerge(local, remote, baseHash, base);
    assert.equal(plan.kind, "three-way");
    assert.equal(healedFrom, undefined);
    if (plan.kind === "three-way") {
      assert.deepEqual([plan.base.text, plan.local.text, plan.remote.text], [base, local, remote]);
      assert.equal(plan.base.hash, baseHash);
    }
  });

  it("falls back to a two-way comparison when the baseline text is missing or damaged", () => {
    assert.deepEqual(planMerge(local, remote, baseHash, undefined).plan.kind, "two-way");
    const damaged = planMerge(local, remote, baseHash, "not the base").plan;
    assert.equal(damaged.kind, "two-way");
    if (damaged.kind === "two-way") {
      assert.equal(damaged.reason, "no-baseline");
    }
  });

  it("treats a legacy baseline (no text can match it) as a conflict to compare", () => {
    assert.equal(planMerge(local, remote, "legacy-hash", undefined).plan.kind, "two-way");
  });
});

describe("baselineAfterMergeSave", () => {
  it("adopts the IBM i's text once something was merged into the local copy", () => {
    assert.equal(baselineAfterMergeSave(hashContent("merged"), hashContent(local), hashContent(remote), baseHash), hashContent(remote));
  });

  it("keeps the baseline when the saved text is still the local snapshot", () => {
    assert.equal(baselineAfterMergeSave(hashContent(local), hashContent(local), hashContent(remote), baseHash), baseHash);
  });
});

describe("mergeSnapshotPaths", () => {
  it("puts one member's snapshots in their own folder, keeping the extension for syntax colouring", () => {
    const paths = mergeSnapshotPaths(entry());
    assert.deepEqual(paths.dir, ["merge", "Dev_1", "MYLIB", "QRPGLESRC", "ORD100"]);
    assert.deepEqual([paths.base, paths.remote, paths.local], ["base.RPGLE", "ibmi.RPGLE", "local.RPGLE"]);
  });

  it("copes with a member without an extension", () => {
    const paths = mergeSnapshotPaths(entry({ extension: "" }));
    assert.deepEqual([paths.base, paths.remote, paths.local], ["base", "ibmi", "local"]);
  });
});

describe("mergeEditorArguments", () => {
  it("shows the IBM i on the left, the local copy on the right, and writes the result to the output", () => {
    const args = mergeEditorArguments({ base: "b", remote: "r", local: "l", output: "o" }, entry());
    assert.equal(args.base, "b");
    assert.equal(args.output, "o");
    assert.deepEqual(args.input1, { uri: "r", title: "IBM i now", description: "MYLIB/QRPGLESRC(ORD100) on Dev:1" });
    assert.deepEqual(args.input2, { uri: "l", title: "Local (yours)", description: "/c/Dev_1/MYLIB/QRPGLESRC/ORD100.rpgle" });
  });
});

describe("selectMergeCandidates", () => {
  it("preselects members changed on the IBM i and skips reference copies and deleted members", () => {
    const candidates = selectMergeCandidates([
      entry({ status: "conflict" }),
      entry({ status: "remote-changed" }),
      entry({ status: "modified" }),
      entry({ status: "in-sync", kind: "reference" }),
      entry({ status: "remote-missing" }),
    ]);
    assert.deepEqual(candidates.map((c) => [c.picked, c.skip]), [
      [true, undefined], [true, undefined], [false, undefined], [false, "reference"], [false, "remote-missing"],
    ]);
  });
});
