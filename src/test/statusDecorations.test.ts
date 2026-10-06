import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decorationFor } from "../statusDecorations";

describe("decorationFor", () => {
  it("marks local changes, remote changes and conflicts with arrows and a bang", () => {
    assert.deepEqual(decorationFor({ status: "modified" }), {
      badge: "↑",
      tooltip: "IBM i: local changes not yet uploaded",
      colorId: "gitDecoration.modifiedResourceForeground",
    });
    assert.equal(decorationFor({ status: "remote-changed" })?.badge, "↓");
    assert.equal(decorationFor({ status: "conflict" })?.badge, "!");
    assert.equal(decorationFor({ status: "conflict" })?.colorId, "gitDecoration.conflictingResourceForeground");
  });

  it("marks a member deleted on the IBM i with a cross, keeping the local copy", () => {
    assert.deepEqual(decorationFor({ status: "remote-missing" }), {
      badge: "✕",
      tooltip: "IBM i: the member no longer exists on the IBM i. Your local copy is kept.",
      colorId: "gitDecoration.deletedResourceForeground",
    });
    assert.equal(decorationFor({ status: "remote-missing", kind: "reference" })?.badge, "RO");
    assert.match(decorationFor({ status: "remote-missing", kind: "reference" })!.tooltip, /no longer exists/);
  });

  it("leaves members in sync alone", () => {
    for (const status of ["in-sync", "checked-out", "merged"] as const) {
      assert.equal(decorationFor({ status }), undefined, status);
    }
  });

  it("marks reference copies read-only whatever their status, without a color", () => {
    assert.deepEqual(decorationFor({ status: "in-sync", kind: "reference" }), {
      badge: "RO",
      tooltip: "IBM i: read-only reference copy",
    });
    assert.match(decorationFor({ status: "remote-changed", kind: "reference" })!.tooltip, /Refresh offers to update it/);
  });

  it("keeps every badge to the one or two characters VS Code allows", () => {
    for (const status of ["modified", "remote-changed", "conflict", "remote-missing"] as const) {
      for (const kind of [undefined, "reference"] as const) {
        const badge = decorationFor({ status, kind })?.badge ?? "";
        assert.ok(badge.length >= 1 && badge.length <= 2, `${status} ${kind}`);
      }
    }
  });
});
