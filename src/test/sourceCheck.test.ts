import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SourceLayout,
  asciiReplacement,
  checksCharacters,
  describeProblem,
  layoutFromColumn,
  sourceProblems,
  storableIn,
  summarizeProblems,
} from "../sourceCheck";

const layout80: SourceLayout = { dataLength: 80, ccsid: 37 };

describe("sourceProblems: line length", () => {
  it("accepts a line that just fits and flags one character more", () => {
    const content = `${"A".repeat(80)}\n${"B".repeat(81)}`;
    assert.deepEqual(sourceProblems(content, layout80), [
      { kind: "long-line", line: 1, length: 81, column: 80, end: 81 },
    ]);
  });

  it("doesn't count trailing blanks, CRLF line ends, a BOM or trailing blank lines", () => {
    const content = `\uFEFF${"A".repeat(80)}   \r\n${"B".repeat(80)}\t\r\n\r\n   \r\n`;
    assert.deepEqual(sourceProblems(content, layout80), []);
  });

  it("gives positions in the text as given, past a BOM", () => {
    const [problem] = sourceProblems(`\uFEFF${"A".repeat(81)}`, layout80);
    assert.deepEqual(problem, { kind: "long-line", line: 0, length: 81, column: 81, end: 82 });
  });

  it("counts a character outside the BMP as one", () => {
    const content = `${"A".repeat(79)}\u{1F600}`;
    assert.deepEqual(sourceProblems(content, { dataLength: 80, ccsid: 1208 }), []);
    const longer = `${"A".repeat(80)}\u{1F600}`;
    assert.deepEqual(sourceProblems(longer, { dataLength: 80, ccsid: 1208 }), [
      { kind: "long-line", line: 0, length: 81, column: 80, end: 82 },
    ]);
  });

  it("checks length whatever the CCSID", () => {
    assert.equal(sourceProblems("X".repeat(13), { dataLength: 12 }).length, 1);
  });
});

describe("sourceProblems: characters", () => {
  it("flags typographic quotes in CCSID 37 but not Latin-1 letters or a no-break space", () => {
    const content = "     C                   EVAL      NAME = \u201CJos\u00E9\u201D\u00A0";
    const problems = sourceProblems(content, layout80);
    assert.deepEqual(problems.map((problem) => problem.kind === "character" && problem.char), ["\u201C", "\u201D"]);
    assert.deepEqual(problems[0], {
      kind: "character",
      line: 0,
      column: content.indexOf("\u201C"),
      end: content.indexOf("\u201C") + 1,
      char: "\u201C",
      replacement: "\"",
    });
  });

  it("allows the euro sign only in the euro CCSIDs, where it replaces the currency sign", () => {
    assert.equal(storableIn(0x20ac, 37), false);
    assert.equal(storableIn(0x20ac, 1140), true);
    assert.equal(storableIn(0xa4, 37), true);
    assert.equal(storableIn(0xa4, 1140), false);
  });

  it("doesn't check characters for Unicode, unknown or missing CCSIDs", () => {
    for (const ccsid of [1200, 1208, 13488, 65535, 937, undefined]) {
      assert.equal(checksCharacters(ccsid), false, String(ccsid));
      assert.deepEqual(sourceProblems("\u201Cquoted\u201D \u2014 \u2026", { dataLength: 80, ccsid }), []);
    }
  });

  it("flags a character with no plain-text spelling without a replacement", () => {
    const [problem] = sourceProblems("\u4E2D", layout80);
    assert.equal(problem.kind, "character");
    assert.equal("replacement" in problem, false);
  });

  it("lists problems in line and column order", () => {
    const content = `${"\u2019".repeat(1)}${"A".repeat(80)}\nB\u2014`;
    assert.deepEqual(
      sourceProblems(content, layout80).map((problem) => `${problem.line}:${problem.column}:${problem.kind}`),
      ["0:0:character", "0:80:long-line", "1:1:character"]
    );
  });
});

describe("layoutFromColumn", () => {
  it("reads the SRCDTA length and CCSID as QSYS2.SYSCOLUMNS returns them", () => {
    assert.deepEqual(layoutFromColumn(80, 37), { dataLength: 80, ccsid: 37 });
    assert.deepEqual(layoutFromColumn("100", "1140"), { dataLength: 100, ccsid: 1140 });
  });

  it("leaves out a missing CCSID and refuses an unusable length", () => {
    assert.deepEqual(layoutFromColumn(80, null), { dataLength: 80 });
    assert.deepEqual(layoutFromColumn(80, 0), { dataLength: 80 });
    assert.equal(layoutFromColumn(0, 37), undefined);
    assert.equal(layoutFromColumn(null, 37), undefined);
    assert.equal(layoutFromColumn("x", 37), undefined);
  });
});

describe("asciiReplacement", () => {
  it("spells typographic characters in plain text", () => {
    assert.equal(asciiReplacement("\u2018"), "'");
    assert.equal(asciiReplacement("\u201D"), "\"");
    assert.equal(asciiReplacement("\u2014"), "-");
    assert.equal(asciiReplacement("\u2026"), "...");
    assert.equal(asciiReplacement("\u2260"), "<>");
    assert.equal(asciiReplacement("\u200B"), "");
    assert.equal(asciiReplacement("\u00E9"), undefined);
  });
});

describe("describing problems", () => {
  it("describes each problem and sums them up", () => {
    const problems = sourceProblems(`${"A".repeat(81)}\n\u201Cx\u201D\n\u200B`, layout80);
    assert.equal(
      describeProblem(problems[0], layout80),
      "This line is 81 characters, but the source file holds 80. The rest is cut off when the member is uploaded."
    );
    assert.equal(
      describeProblem(problems[1], layout80),
      "\"\u201C\" (U+201C) can't be stored in CCSID 37 and is replaced when the member is uploaded. Use \"\\\"\" instead."
    );
    assert.match(describeProblem(problems[3], layout80), /Remove it\.$/);
    assert.equal(
      summarizeProblems(problems, layout80),
      "1 line is longer than the 80 characters the source file holds, and 3 characters can't be stored in CCSID 37"
    );
    assert.equal(summarizeProblems(problems.slice(1, 2), layout80), "1 character can't be stored in CCSID 37");
  });
});
