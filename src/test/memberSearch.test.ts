import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FoundMember,
  addToHistory,
  describeSearch,
  foundMemberInfo,
  isWildcard,
  memberPattern,
  memberPatternProblem,
  orderFound,
} from "../memberSearch";

describe("memberPatternProblem", () => {
  it("accepts IBM i names with wildcards", () => {
    for (const input of ["VU0005CC", "ord*", "*ENT", " $ORD#1 ", "A*B"]) {
      assert.equal(memberPatternProblem(input), undefined, input);
    }
  });

  it("refuses anything that isn't a name, too long, or only wildcards", () => {
    for (const input of ["", "*", "**", "ORD 100", "ORD'X", "ORD%", "TOOLONGNAME1"]) {
      assert.ok(memberPatternProblem(input), input);
    }
  });
});

describe("memberPattern and isWildcard", () => {
  it("trims and uppercases, and tells a pattern from a name", () => {
    assert.equal(memberPattern(" ord* "), "ORD*");
    assert.equal(isWildcard("ORD*"), true);
    assert.equal(isWildcard("ORD100"), false);
  });
});

describe("orderFound", () => {
  const found = (library: string, member: string, sourceFile = "QRPGLESRC"): FoundMember =>
    ({ library, sourceFile, member, sourceType: "RPGLE" });

  it("puts the exact name first, then the search libraries' order, then the name", () => {
    const ordered = orderFound(
      [found("OTHER", "ORD100"), found("DEVLIB", "ORD100X"), found("PRODSRC", "ORD100"), found("DEVLIB", "ORD100")],
      { pattern: "ORD100", libraries: ["DEVLIB", "PRODSRC"] }
    );
    assert.deepEqual(ordered.map((m) => `${m.library}/${m.member}`), [
      "DEVLIB/ORD100",
      "PRODSRC/ORD100",
      "OTHER/ORD100",
      "DEVLIB/ORD100X",
    ]);
  });

  it("offers each member once", () => {
    const ordered = orderFound([found("PRODSRC", "ORD100"), { ...found("prodsrc", "ord100"), via: "source of program X" }], {
      pattern: "ORD*",
      libraries: [],
    });
    assert.equal(ordered.length, 1);
  });
});

describe("addToHistory", () => {
  it("puts the newest search first, moving a repeated one to the top", () => {
    let history = addToHistory([], { input: "ord*", byText: false });
    history = addToHistory(history, { input: "VU0005CC", byText: false });
    history = addToHistory(history, { input: "ORD*", byText: false });
    assert.deepEqual(history, [{ input: "ORD*", byText: false }, { input: "VU0005CC", byText: false }]);
  });

  it("keeps a name search, a text search and another scope apart", () => {
    let history = addToHistory([], { input: "ORDER", byText: false });
    history = addToHistory(history, { input: "ORDER", byText: true });
    history = addToHistory(history, { input: "ORDER", byText: false, scope: "everywhere" });
    assert.equal(history.length, 3);
  });

  it("keeps at most the limit", () => {
    let history: ReturnType<typeof addToHistory> = [];
    for (let i = 0; i < 25; i++) {
      history = addToHistory(history, { input: `M${i}`, byText: false });
    }
    assert.equal(history.length, 20);
    assert.equal(history[0].input, "M24");
  });
});

describe("describeSearch and foundMemberInfo", () => {
  it("labels a search and turns a found member into a checkout's names", () => {
    assert.equal(describeSearch({ input: "ord*", byText: false }), "ORD*");
    assert.equal(describeSearch({ input: "order", byText: true }), 'text "ORDER"');
    assert.deepEqual(foundMemberInfo({ library: "PROD", sourceFile: "QCLLESRC", member: "SY0204AC", sourceType: "CLLE" }), {
      library: "PROD",
      sourceFile: "QCLLESRC",
      memberName: "SY0204AC",
      extension: "clle",
    });
  });
});
