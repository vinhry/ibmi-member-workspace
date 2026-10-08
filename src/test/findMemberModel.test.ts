import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FindMemberResults, findMemberRows, foundDescription, foundIcon, foundMembersOf } from "../findMemberModel";
import type { FoundMember, MemberSearch } from "../memberSearch";

const search: MemberSearch = { input: "ORD*", byText: false };
const found: FoundMember = { library: "PRODLIB", sourceFile: "QRPGLESRC", member: "ORD100", sourceType: "RPGLE" };

function results(overrides: Partial<FindMemberResults> = {}): FindMemberResults {
  return { search, scopeLabel: "the library list", everywhere: false, state: "done", found: [], ...overrides };
}

describe("findMemberRows", () => {
  it("shows nothing until a search was made, then the results and the recent searches", () => {
    assert.deepEqual(findMemberRows(undefined, undefined, []), []);
    assert.deepEqual(findMemberRows(undefined, results(), [search]), [{ kind: "results" }, { kind: "history" }]);
    assert.deepEqual(findMemberRows({ kind: "history" }, undefined, [search]), [{ kind: "past", search }]);
  });

  it("says when a search is running or failed", () => {
    assert.deepEqual(findMemberRows({ kind: "results" }, results({ state: "searching" }), []), [{ kind: "message", label: "Searching…" }]);
    assert.deepEqual(findMemberRows({ kind: "results" }, results({ state: "failed", error: "SQL0204" }), []), [{ kind: "message", label: "Search failed: SQL0204" }]);
  });

  it("lists what was found", () => {
    const rows = findMemberRows({ kind: "results" }, results({ found: [found] }), []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "found");
  });

  it("offers member text and all user libraries when nothing was found, unless already searched", () => {
    const none = findMemberRows({ kind: "results" }, results(), []);
    assert.deepEqual(none.map((row) => row.kind), ["message", "suggestion", "suggestion"]);
    assert.deepEqual(none[1], { kind: "suggestion", label: 'Search member text for "ORD*"', search: { ...search, byText: true } });
    const byTextEverywhere = findMemberRows({ kind: "results" }, results({ search: { ...search, byText: true }, everywhere: true }), []);
    assert.deepEqual(byTextEverywhere, [{ kind: "message", label: "No member text contains it." }]);
  });
});

describe("found members", () => {
  it("says whether a found member is already checked out here", () => {
    assert.equal(foundDescription(found, undefined), "PRODLIB/QRPGLESRC · RPGLE");
    assert.equal(foundDescription(found, {}), "PRODLIB/QRPGLESRC · RPGLE · checked out");
    assert.equal(foundDescription(found, { kind: "reference" }), "PRODLIB/QRPGLESRC · RPGLE · reference copy");
    assert.deepEqual([foundIcon(undefined), foundIcon({}), foundIcon({ kind: "reference" })], ["file-code", "check", "lock"]);
  });

  it("takes the selection, or the row clicked, and ignores anything else", () => {
    const row = findMemberRows({ kind: "results" }, results({ found: [found, { ...found, member: "ORD200" }] }), []);
    assert.deepEqual(foundMembersOf(row[0]).map((m) => m.memberName), ["ORD100"]);
    assert.deepEqual(foundMembersOf(row[0], row).map((m) => m.memberName), ["ORD100", "ORD200"]);
    assert.deepEqual(foundMembersOf({ kind: "member" }), []);
  });
});
