import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CheckedOutMember,
  SystemCheckoutState,
  buildCheckoutId,
  moveEntriesState,
  parseCheckoutIndex,
  sanitizeSystemName,
  startWorkItemState,
} from "../types";

describe("parseCheckoutIndex", () => {
  it("parses a valid index", () => {
    const index = parseCheckoutIndex(JSON.stringify({
      version: 3,
      systems: {},
      unassignedWorkItems: { "TICKET-123": [] },
    }));
    assert.deepEqual(index, {
      version: 3,
      systems: {},
      unassignedWorkItems: { "TICKET-123": [] },
    });
  });

  it("migrates a version 1 index into the workspace work item", () => {
    assert.deepEqual(parseCheckoutIndex(JSON.stringify({ version: 1, entries: [] })), {
      version: 3,
      systems: {},
      unassignedWorkItems: { workspace: [] },
    });
  });

  it("migrates an index with no explicit version", () => {
    assert.equal(parseCheckoutIndex(JSON.stringify({ entries: [] })).version, 3);
  });

  it("groups version 2 work items by IBM i system and preserves empty work items", () => {
    const entry = (system: string, memberName: string) => ({
      id: `${system}_${memberName}`,
      system,
      library: "LIB",
      sourceFile: "QRPGLESRC",
      memberName,
      extension: "rpgle",
      localPath: `/checkout/${system}/LIB/QRPGLESRC/${memberName}.RPGLE`,
      checkedOutAt: "2026-09-22T00:00:00.000Z",
      remoteHashAtCheckout: "hash",
      status: "in-sync" as const,
    });
    const index = parseCheckoutIndex(JSON.stringify({
      version: 2,
      activeWorkItem: "TICKET-1",
      workItems: {
        "TICKET-1": [entry("alpha.example", "ONE"), entry("beta.example", "TWO")],
        EMPTY: [],
      },
    }));
    assert.equal(index.systems["ALPHA.EXAMPLE"].directory, "alpha.example");
    assert.deepEqual(index.systems["ALPHA.EXAMPLE"].workItems["TICKET-1"].map((item) => item.memberName), ["ONE"]);
    assert.deepEqual(index.systems["BETA.EXAMPLE"].workItems["TICKET-1"].map((item) => item.memberName), ["TWO"]);
    assert.deepEqual(index.unassignedWorkItems, { EMPTY: [] });
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseCheckoutIndex("{ not json"));
  });

  it("throws when the entries list is missing", () => {
    assert.throws(() => parseCheckoutIndex(JSON.stringify({ version: 1 })));
    assert.throws(() => parseCheckoutIndex(JSON.stringify({
      version: 3,
      systems: {},
      unassignedWorkItems: { bad: {} },
    })));
    assert.throws(() => parseCheckoutIndex("null"));
  });
});

describe("sanitizeSystemName", () => {
  it("cannot resolve to the checkout container or its parent", () => {
    assert.equal(sanitizeSystemName("."), "_");
    assert.equal(sanitizeSystemName(".."), "_");
    assert.equal(sanitizeSystemName("host/name"), "host_name");
  });
});

describe("buildCheckoutId", () => {
  it("does not collide for names containing underscores", () => {
    assert.notEqual(
      buildCheckoutId("SYS", "MY_LIB", "SRC", "X"),
      buildCheckoutId("SYS", "MY", "LIB_SRC", "X")
    );
  });

  it("is case-insensitive", () => {
    assert.equal(buildCheckoutId("sys", "lib", "src", "x"), buildCheckoutId("SYS", "LIB", "SRC", "X"));
  });
});

describe("parseCheckoutIndex id migration", () => {
  const legacy: CheckedOutMember = {
    id: "SYS_MYLIB_QRPGLESRC_PROG",
    system: "SYS",
    library: "MYLIB",
    sourceFile: "QRPGLESRC",
    memberName: "PROG",
    extension: "rpgle",
    localPath: "/tmp/PROG.RPGLE",
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "abc",
    status: "checked-out",
  };
  const currentId = buildCheckoutId("SYS", "MYLIB", "QRPGLESRC", "PROG");

  it("rewrites legacy underscore-joined ids when migrating a version 1 index", () => {
    const index = parseCheckoutIndex(JSON.stringify({ version: 1, entries: [legacy] }));
    const [entry] = index.systems.SYS.workItems.workspace;
    assert.equal(entry.id, currentId);
    assert.equal(entry.localPath, legacy.localPath);
  });

  it("rewrites legacy ids in every work item of a version 3 index", () => {
    const index = parseCheckoutIndex(JSON.stringify({
      version: 3,
      systems: {
        SYS: {
          system: "SYS",
          directory: "SYS",
          activeWorkItem: "A",
          workItems: { A: [legacy], B: [legacy] },
        },
      },
      unassignedWorkItems: {},
    }));
    assert.equal(index.systems.SYS.workItems.A[0].id, currentId);
    assert.equal(index.systems.SYS.workItems.B[0].id, currentId);
  });
});

describe("work item state", () => {
  const member = (memberName: string, baseline: string): CheckedOutMember => ({
    id: buildCheckoutId("SYS", "LIB", "QRPGLESRC", memberName),
    system: "SYS",
    library: "LIB",
    sourceFile: "QRPGLESRC",
    memberName,
    extension: "rpgle",
    localPath: `/checkout/SYS/LIB/QRPGLESRC/${memberName}.RPGLE`,
    checkedOutAt: "2026-09-23T00:00:00.000Z",
    remoteHashAtCheckout: baseline,
    status: "modified",
  });
  const state = (): SystemCheckoutState => ({
    system: "SYS",
    directory: "SYS",
    activeWorkItem: "workspace",
    workItems: {
      workspace: [member("ONE", "h1"), member("TWO", "h2")],
      "TICKET-2": [member("STALE", "old")],
    },
  });

  it("starts empty and replaces a stale list stored under the same name", () => {
    const value = state();
    startWorkItemState(value, "TICKET-2", "empty");
    assert.equal(value.activeWorkItem, "TICKET-2");
    assert.deepEqual(value.workItems["TICKET-2"], []);
    assert.equal(value.workItems.workspace.length, 2);
  });

  it("copies members as independent entries", () => {
    const value = state();
    startWorkItemState(value, "TICKET-3", "copy");
    assert.deepEqual(value.workItems["TICKET-3"], value.workItems.workspace);
    value.workItems["TICKET-3"][0].status = "in-sync";
    assert.equal(value.workItems.workspace[0].status, "modified");
  });

  it("moves members into the renamed work item", () => {
    const value = state();
    startWorkItemState(value, "TICKET-4", "move");
    assert.equal(value.activeWorkItem, "TICKET-4");
    assert.equal(value.workItems.workspace, undefined);
    assert.deepEqual(value.workItems["TICKET-4"].map((entry) => entry.memberName), ["ONE", "TWO"]);
  });

  it("moves selected entries between work items keeping their baselines", () => {
    const value = state();
    moveEntriesState(value, new Set([buildCheckoutId("SYS", "LIB", "QRPGLESRC", "TWO")]), "workspace", "TICKET-2");
    assert.deepEqual(value.workItems.workspace.map((entry) => entry.memberName), ["ONE"]);
    assert.deepEqual(
      value.workItems["TICKET-2"].map((entry) => [entry.memberName, entry.remoteHashAtCheckout, entry.status]),
      [["STALE", "old", "modified"], ["TWO", "h2", "modified"]]
    );
    moveEntriesState(value, new Set([buildCheckoutId("SYS", "LIB", "QRPGLESRC", "ONE")]), "workspace", "NEW");
    assert.deepEqual(value.workItems.NEW.map((entry) => entry.memberName), ["ONE"]);
  });
});
