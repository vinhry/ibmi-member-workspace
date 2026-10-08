import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DateFormat,
  contextValueFor,
  matchesSearch,
  memberDescription,
  memberIcon,
  memberTooltip,
  membersOf,
  sourceFileGroups,
  statusDescription,
} from "../checkoutTreeModel";
import type { CheckedOutMember, CheckoutStatus } from "../types";

const format: DateFormat = { date: (iso) => iso.slice(0, 10), dateTime: (iso) => iso };

function member(library: string, sourceFile: string, name: string, overrides: Partial<CheckedOutMember> = {}): CheckedOutMember {
  return {
    id: `SYS/${library}/${sourceFile}/${name}`,
    system: "SYS",
    library,
    sourceFile,
    memberName: name,
    extension: "rpgle",
    localPath: `/c/SYS/${library}/${sourceFile}/${name}.RPGLE`,
    checkedOutAt: "2026-10-01T09:00:00.000Z",
    remoteHashAtCheckout: "base",
    status: "in-sync",
    ...overrides,
  };
}

const ALL_STATUSES: CheckoutStatus[] = ["checked-out", "merged", "modified", "remote-changed", "conflict", "in-sync", "remote-missing"];

describe("checkoutTreeModel: what is listed", () => {
  const entries = [
    member("PRODLIB", "QRPGLESRC", "ORD200"),
    member("DEVLIB", "QRPGLESRC", "ORD100"),
    member("DEVLIB", "QCLLESRC", "NIGHTLY"),
    member("DEVLIB", "QRPGLESRC", "CUST10"),
  ];

  it("searches member names whatever their case", () => {
    assert.equal(matchesSearch(entries[0], "ord"), true);
    assert.equal(matchesSearch(entries[0], "cust"), false);
    assert.equal(matchesSearch(entries[0], ""), true);
  });

  it("lists each source file once, by library then file, only with matching members", () => {
    assert.deepEqual(sourceFileGroups(entries, ""), [
      { library: "DEVLIB", sourceFile: "QCLLESRC" },
      { library: "DEVLIB", sourceFile: "QRPGLESRC" },
      { library: "PRODLIB", sourceFile: "QRPGLESRC" },
    ]);
    assert.deepEqual(sourceFileGroups(entries, "ord"), [
      { library: "DEVLIB", sourceFile: "QRPGLESRC" },
      { library: "PRODLIB", sourceFile: "QRPGLESRC" },
    ]);
  });

  it("lists a source file's matching members by name", () => {
    assert.deepEqual(membersOf(entries, "devlib", "qrpglesrc", "").map((e) => e.memberName), ["CUST10", "ORD100"]);
    assert.deepEqual(membersOf(entries, "DEVLIB", "QRPGLESRC", "ord").map((e) => e.memberName), ["ORD100"]);
  });
});

describe("checkoutTreeModel: how a member looks", () => {
  it("gives every status a description, an icon and a context value", () => {
    for (const status of ALL_STATUSES) {
      const entry = member("DEVLIB", "QRPGLESRC", "ORD100", { status, lastCheckedAt: "2026-10-05T10:00:00.000Z" });
      assert.ok(statusDescription(entry, format).length > 0, status);
      assert.ok(memberIcon(entry, false).id, status);
      assert.equal(contextValueFor(entry), `checkout-${status}`);
    }
    const missing = member("DEVLIB", "QRPGLESRC", "ORD100", { status: "remote-missing", lastCheckedAt: "2026-10-05T10:00:00.000Z" });
    assert.equal(statusDescription(missing, format), "deleted on IBM i (checked 2026-10-05)");
    assert.deepEqual(memberIcon(missing, false), { id: "circle-slash", colorId: "charts.red" });
    assert.equal(statusDescription(member("A", "B", "C", { status: "checked-out" }), format), "checked out 2026-10-01");
  });

  it("puts a missing local file before everything, then reference copies", () => {
    const reference = member("PRODLIB", "QRPGLESRC", "ORD200", { kind: "reference", status: "remote-changed" });
    assert.equal(memberDescription(reference, true, format), "local file missing — Refresh to re-checkout or remove");
    assert.deepEqual(memberIcon(reference, true), { id: "error", colorId: "problemsErrorIcon.foreground" });
    assert.equal(memberDescription(reference, false, format), "reference · remote changed 2026-10-01");
    assert.deepEqual(memberIcon(reference, false), { id: "lock" });
    assert.equal(contextValueFor(reference), "reference-remote-changed");
  });

  it("explains a reference copy and a member deleted on the IBM i in the tooltip", () => {
    const tooltip = memberTooltip(member("PRODLIB", "QRPGLESRC", "ORD200", { kind: "reference", status: "remote-missing" }), true, format);
    assert.match(tooltip, /^\*\*PRODLIB\/QRPGLESRC\(ORD200\)\*\*/);
    assert.match(tooltip, /Read-only reference copy/);
    assert.match(tooltip, /no longer exists on the IBM i/);
    assert.match(tooltip, /\(missing\)\n$/);
    assert.doesNotMatch(tooltip, /Last checked/);
  });
});
