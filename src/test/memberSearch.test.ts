import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FoundMember, isWildcard, memberPattern, memberPatternProblem, orderFound } from "../memberSearch";

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
