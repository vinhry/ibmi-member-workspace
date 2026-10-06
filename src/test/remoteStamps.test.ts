import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  changeStamp,
  groupBySourceFile,
  newlyChanged,
  planRefresh,
  refreshIntervalMs,
  remoteChangeBadge,
} from "../remoteStamps";
import { HASH_VERSION } from "../sync";
import type { CheckedOutMember, CheckoutStatus } from "../types";

function member(name: string, overrides: Partial<CheckedOutMember> = {}): CheckedOutMember {
  return {
    id: `SYS/MYLIB/QRPGLESRC/${name}`,
    system: "SYS",
    library: "MYLIB",
    sourceFile: "QRPGLESRC",
    memberName: name,
    extension: "rpgle",
    localPath: `/tmp/${name}.RPGLE`,
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "base",
    hashVersion: HASH_VERSION,
    status: "in-sync",
    ...overrides,
  };
}

describe("changeStamp", () => {
  it("joins the catalog columns, trimmed, with empty text for nulls", () => {
    assert.equal(
      changeStamp({ CHANGED: "2026-10-01-12.00.00.000000", SOURCE_UPDATED: null, MEMBER_ROWS: 120, MEMBER_SIZE: " 9216 " }),
      "2026-10-01-12.00.00.000000||120|9216"
    );
  });

  it("differs when any column does", () => {
    const row = { CHANGED: "t1", SOURCE_UPDATED: "t2", MEMBER_ROWS: 10, MEMBER_SIZE: 100 };
    assert.notEqual(changeStamp(row), changeStamp({ ...row, MEMBER_ROWS: 11 }));
    assert.notEqual(changeStamp(row), changeStamp({ ...row, SOURCE_UPDATED: "t3" }));
  });
});

describe("groupBySourceFile", () => {
  it("groups members by library and source file, ignoring case, in first-seen order", () => {
    const a = member("A");
    const b = member("B", { sourceFile: "QCLSRC" });
    const c = member("C", { library: "mylib" });
    const groups = groupBySourceFile([a, b, c]);
    assert.deepEqual(groups.map((group) => [group.library, group.sourceFile, group.entries.map((entry) => entry.memberName)]), [
      ["MYLIB", "QRPGLESRC", ["A", "C"]],
      ["MYLIB", "QCLSRC", ["B"]],
    ]);
  });
});

describe("planRefresh", () => {
  it("skips a member whose stamp is the one recorded at its last full comparison", () => {
    const prog = member("PROG", { remoteSeen: { stamp: "s1", hash: "remote" } });
    assert.deepEqual(planRefresh([prog], new Map([["PROG", "s1"]])), {
      download: [],
      unchanged: [{ entry: prog, hash: "remote" }],
      missing: [],
    });
  });

  it("downloads a member whose stamp changed, and records the new stamp", () => {
    const prog = member("PROG", { remoteSeen: { stamp: "s1", hash: "remote" } });
    assert.deepEqual(planRefresh([prog], new Map([["PROG", "s2"]])), {
      download: [{ entry: prog, stamp: "s2" }],
      unchanged: [],
      missing: [],
    });
  });

  it("downloads a member never compared with a stamp, or one with an old baseline", () => {
    const never = member("NEVER");
    const old = member("OLD", { remoteSeen: { stamp: "s1", hash: "remote" }, hashVersion: undefined });
    const plan = planRefresh([never, old], new Map([["NEVER", "s1"], ["OLD", "s1"]]));
    assert.deepEqual(plan.download, [{ entry: never, stamp: "s1" }, { entry: old, stamp: "s1" }]);
    assert.deepEqual(plan.unchanged, []);
  });

  it("reports a member missing from the catalog instead of downloading it", () => {
    const gone = member("GONE", { remoteSeen: { stamp: "s1", hash: "remote" } });
    const never = member("NEVER");
    assert.deepEqual(planRefresh([gone, never], new Map()), { download: [], unchanged: [], missing: [{ entry: gone }, { entry: never }] });
  });

  it("downloads everything when the catalog couldn't be read", () => {
    const prog = member("PROG", { remoteSeen: { stamp: "s1", hash: "remote" } });
    assert.deepEqual(planRefresh([prog], undefined), { download: [{ entry: prog }], unchanged: [], missing: [] });
  });

  it("matches member names whatever their case", () => {
    const prog = member("prog", { remoteSeen: { stamp: "s1", hash: "remote" } });
    assert.equal(planRefresh([prog], new Map([["PROG", "s1"]])).unchanged.length, 1);
  });
});

describe("refreshIntervalMs", () => {
  it("is off for 0, negatives and anything that isn't a number", () => {
    for (const value of [0, -5, Number.NaN, "10", undefined, null]) {
      assert.equal(refreshIntervalMs(value), undefined, String(value));
    }
  });

  it("runs at most every 5 minutes and at least every 240", () => {
    assert.equal(refreshIntervalMs(1), 5 * 60_000);
    assert.equal(refreshIntervalMs(15), 15 * 60_000);
    assert.equal(refreshIntervalMs(1000), 240 * 60_000);
  });
});

describe("newlyChanged", () => {
  it("lists members that became a conflict or changed on the IBM i, not ones that already were", () => {
    const before = new Map<string, CheckoutStatus>([
      ["A", "modified"],
      ["B", "conflict"],
      ["C", "in-sync"],
      ["D", "in-sync"],
      ["E", "in-sync"],
      ["F", "remote-missing"],
    ]);
    const after = [
      { id: "A", status: "conflict" as const },
      { id: "B", status: "conflict" as const },
      { id: "C", status: "remote-changed" as const },
      { id: "D", status: "in-sync" as const },
      { id: "E", status: "remote-missing" as const },
      { id: "F", status: "remote-missing" as const },
    ];
    assert.deepEqual(newlyChanged(before, after), { conflicts: ["A"], remoteChanged: ["C"], remoteMissing: ["E"] });
  });
});

describe("remoteChangeBadge", () => {
  it("counts members deleted on the IBM i too", () => {
    assert.deepEqual(
      remoteChangeBadge([{ status: "remote-missing" }, { status: "remote-changed" }, { status: "in-sync" }]),
      { value: 2, tooltip: "1 changed on the IBM i, 1 deleted on the IBM i" }
    );
  });

  it("counts members changed on the IBM i, with and without local changes", () => {
    assert.deepEqual(
      remoteChangeBadge([{ status: "remote-changed" }, { status: "conflict" }, { status: "modified" }, { status: "remote-changed" }]),
      { value: 3, tooltip: "2 changed on the IBM i, 1 changed on the IBM i and locally (conflict)" }
    );
    assert.deepEqual(remoteChangeBadge([{ status: "conflict" }]), {
      value: 1,
      tooltip: "1 changed on the IBM i and locally (conflict)",
    });
  });

  it("shows no badge when nothing changed on the IBM i", () => {
    assert.equal(remoteChangeBadge([{ status: "modified" }, { status: "in-sync" }]), undefined);
  });
});
