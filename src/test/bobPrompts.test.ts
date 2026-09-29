import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { MAX_PROMPT_MEMBERS, buildBobPrompt, mentionFor } from "../bobPrompts";

const root = path.join(path.sep, "work", "project");
const inside = path.join(root, "checkouts", "PUB400", "PRODSRC", "QRPGLESRC", "ORDENT.SQLRPGLE");

describe("buildBobPrompt", () => {
  it("asks Bob to analyze relationships with the research tools, read-only", () => {
    const { text, skipped } = buildBobPrompt(
      "relationships",
      [{ library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT", localPath: inside, readOnly: true }],
      [root]
    );
    assert.deepEqual(skipped, []);
    assert.match(text, /analyze the relationships of this IBM i member:/);
    assert.match(text, /^- PRODSRC\/QRPGLESRC\(ORDENT\) @\/checkouts\/PUB400\/PRODSRC\/QRPGLESRC\/ORDENT\.SQLRPGLE \(read-only reference copy\)$/m);
    assert.match(text, /find_member_dependencies/);
    assert.match(text, /find_where_used/);
    assert.match(text, /don't edit, rename or overwrite any file/);
    assert.doesNotMatch(text, /relate to each other/);
  });

  it("asks Bob to explain several programs", () => {
    const { text } = buildBobPrompt(
      "explain",
      [
        { library: "prodsrc", sourceFile: "qrpglesrc", member: "ordent" },
        { library: "PRODSRC", sourceFile: "QCLSRC", member: "NIGHTLY" },
      ],
      [root]
    );
    assert.match(text, /^Explain what these 2 IBM i members do:/);
    assert.match(text, /^- PRODSRC\/QRPGLESRC\(ORDENT\)$/m);
    assert.match(text, /read_member_source/);
    assert.match(text, /business rules/);
    assert.match(text, /don't edit, rename or overwrite any file/);
  });

  it("lists each member once and at most 25", () => {
    const members = Array.from({ length: MAX_PROMPT_MEMBERS + 3 }, (_, i) => ({ library: "L", sourceFile: "F", member: `M${i}` }));
    const { text, skipped } = buildBobPrompt("relationships", [...members, members[0]], [root]);
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, MAX_PROMPT_MEMBERS);
    assert.deepEqual(skipped, ["L/F(M25)", "L/F(M26)", "L/F(M27)"]);
    assert.match(text, /relate to each other/);
  });
});

describe("mentionFor", () => {
  it("mentions files inside a workspace folder only", () => {
    assert.equal(mentionFor(inside, [root]), "@/checkouts/PUB400/PRODSRC/QRPGLESRC/ORDENT.SQLRPGLE");
    assert.equal(mentionFor(path.join(path.sep, "elsewhere", "X.RPGLE"), [root]), undefined);
    assert.equal(mentionFor(root, [root]), undefined);
    assert.equal(mentionFor(inside, []), undefined);
  });

  it("uses forward slashes for Windows paths", () => {
    assert.equal(
      mentionFor("C:\\work\\project\\src\\ORDENT.RPGLE", ["C:\\work\\project"], path.win32),
      "@/src/ORDENT.RPGLE"
    );
    assert.equal(mentionFor("D:\\other\\X.RPGLE", ["C:\\work\\project"], path.win32), undefined);
  });
});
