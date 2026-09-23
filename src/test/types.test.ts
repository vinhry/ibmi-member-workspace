import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCheckoutIndex, sanitizeSystemName } from "../types";

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
