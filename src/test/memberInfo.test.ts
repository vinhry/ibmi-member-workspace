import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMemberInfo, extractSourceFileInfo } from "../memberInfo";

describe("extractMemberInfo", () => {
  it("parses a member: URI of LIB/FILE/MEMBER.EXT", () => {
    assert.deepEqual(
      extractMemberInfo({}, { scheme: "member", path: "/MYLIB/QRPGLESRC/MYPROG.RPGLE" }),
      { library: "MYLIB", sourceFile: "QRPGLESRC", memberName: "MYPROG", extension: "rpgle" }
    );
  });

  it("uses the last three segments of a prefixed member: URI", () => {
    assert.deepEqual(
      extractMemberInfo({}, { scheme: "member", path: "/IASP1/MYLIB/QRPGLESRC/MYPROG.RPGLE" }),
      { library: "MYLIB", sourceFile: "QRPGLESRC", memberName: "MYPROG", extension: "rpgle" }
    );
  });

  it("defaults the extension to mbr when the member has none", () => {
    assert.deepEqual(
      extractMemberInfo({}, { scheme: "member", path: "/MYLIB/QCLSRC/MYCL" }),
      { library: "MYLIB", sourceFile: "QCLSRC", memberName: "MYCL", extension: "mbr" }
    );
  });

  it("parses a QSYS.LIB path", () => {
    assert.deepEqual(
      extractMemberInfo({ path: "/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE/MYPROG.MBR" }),
      { library: "MYLIB", sourceFile: "QRPGLESRC", memberName: "MYPROG", extension: "mbr" }
    );
  });

  it("reads direct library/file/name properties", () => {
    assert.deepEqual(
      extractMemberInfo({ library: "MYLIB", file: "QSRC", name: "PGM", extension: "SQLRPGLE" }),
      { library: "MYLIB", sourceFile: "QSRC", memberName: "PGM", extension: "sqlrpgle" }
    );
  });

  it("reads a nested member property", () => {
    assert.deepEqual(
      extractMemberInfo({ member: { library: "MYLIB", sourceFile: "QSRC", member: "PGM" } }),
      { library: "MYLIB", sourceFile: "QSRC", memberName: "PGM", extension: "mbr" }
    );
  });

  it("reads a _filter-based member item, including a TreeItemLabel label", () => {
    assert.deepEqual(
      extractMemberInfo({ _filter: { library: "MYLIB", object: "QSRC" }, label: { label: "PGM" }, extension: "CLLE" }),
      { library: "MYLIB", sourceFile: "QSRC", memberName: "PGM", extension: "clle" }
    );
  });

  it("returns undefined for nodes without enough detail", () => {
    assert.equal(extractMemberInfo(undefined), undefined);
    assert.equal(extractMemberInfo({ library: "MYLIB" }), undefined);
    assert.equal(extractMemberInfo({}, { scheme: "member", path: "/MYLIB/QSRC" }), undefined);
    assert.equal(extractMemberInfo({}, { scheme: "streamfile", path: "/home/me/a/b.rpgle" }), undefined);
  });
});

describe("extractSourceFileInfo", () => {
  it("reads node.object", () => {
    assert.deepEqual(
      extractSourceFileInfo({ object: { library: "MYLIB", name: "QRPGLESRC" } }),
      { library: "MYLIB", sourceFile: "QRPGLESRC" }
    );
  });

  it("parses a LIBRARY/FILE path", () => {
    assert.deepEqual(extractSourceFileInfo({ path: "MYLIB/QCLSRC" }), { library: "MYLIB", sourceFile: "QCLSRC" });
  });

  it("parses an object: URI, dropping the object type", () => {
    assert.deepEqual(
      extractSourceFileInfo({}, { scheme: "object", path: "/MYLIB/QRPGLESRC.FILE" }),
      { library: "MYLIB", sourceFile: "QRPGLESRC" }
    );
  });

  it("uses the last two segments of a prefixed object: URI", () => {
    assert.deepEqual(
      extractSourceFileInfo({}, { scheme: "object", path: "/IASP1/MYLIB/QRPGLESRC.FILE" }),
      { library: "MYLIB", sourceFile: "QRPGLESRC" }
    );
  });

  it("falls back to direct library/name properties", () => {
    assert.deepEqual(extractSourceFileInfo({ library: "MYLIB", name: "QSRC" }), { library: "MYLIB", sourceFile: "QSRC" });
  });

  it("returns undefined for nodes without enough detail", () => {
    assert.equal(extractSourceFileInfo(undefined), undefined);
    assert.equal(extractSourceFileInfo({ library: "MYLIB" }), undefined);
  });
});
