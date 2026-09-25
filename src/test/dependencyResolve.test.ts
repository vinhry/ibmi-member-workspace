import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RawReference } from "../dependencyScan";
import { SourceMemberRow, librariesToSearch, resolveReferences } from "../dependencyResolve";

function ref(partial: Partial<RawReference> & Pick<RawReference, "kind" | "member">): RawReference {
  return { line: 1, text: "", ...partial };
}

function row(library: string, sourceFile: string, member: string, sourceType: string): SourceMemberRow {
  return { library, sourceFile, member, sourceType };
}

const rows = [
  row("DEVLIB", "QRPGLESRC", "DATEUTIL", "RPGLEINC"),
  row("PRODLIB", "QRPGLESRC", "DATEUTIL", "RPGLEINC"),
  row("PRODLIB", "QCPYSRC", "PROTOS", "RPGLEINC"),
  row("PRODLIB", "QRPGLESRC", "PROTOS", "RPGLEINC"),
  row("PRODLIB", "QRPGLESRC", "ORD001", "RPGLE"),
  row("PRODLIB", "QDDSSRC", "ORD001", "DSPF"),
  row("PRODLIB", "QDDSSRC", "CUSTMAST", "PF"),
];

describe("resolveReferences", () => {
  it("prefers the library that comes first in the search order", () => {
    const result = resolveReferences([ref({ kind: "copybook", member: "DATEUTIL" })], rows, ["PRODLIB", "DEVLIB"]);
    assert.deepEqual(result.resolved[0].candidates.map((c) => c.library), ["PRODLIB", "DEVLIB"]);
  });

  it("requires an explicit library and source file to match", () => {
    const result = resolveReferences(
      [ref({ kind: "copybook", library: "DEVLIB", sourceFile: "QRPGLESRC", member: "DATEUTIL" })],
      rows,
      ["PRODLIB", "DEVLIB"]
    );
    assert.deepEqual(result.resolved[0].candidates, [rows[0]]);
  });

  it("looks for a copybook without a source file in QRPGLESRC first", () => {
    const result = resolveReferences([ref({ kind: "copybook", member: "PROTOS" })], rows, ["PRODLIB"]);
    assert.deepEqual(result.resolved[0].candidates.map((c) => c.sourceFile), ["QRPGLESRC", "QCPYSRC"]);
  });

  it("matches a called program only to program source, not a display file of the same name", () => {
    const result = resolveReferences([ref({ kind: "program", member: "ORD001" })], rows, ["PRODLIB"]);
    assert.deepEqual(result.resolved[0].candidates, [rows[4]]);
  });

  it("matches a referenced file only to file source", () => {
    const result = resolveReferences(
      [ref({ kind: "file", member: "CUSTMAST" }), ref({ kind: "file", member: "ORD001" })],
      rows,
      ["PRODLIB"]
    );
    assert.deepEqual(result.resolved.map((r) => r.candidates[0].member), ["CUSTMAST", "ORD001"]);
    assert.equal(result.resolved[1].candidates[0].sourceType, "DSPF");
  });

  it("reports references without source, and IFS paths, as unresolved", () => {
    const missing = ref({ kind: "program", member: "NOSUCH" });
    const ifs = ref({ kind: "copybook", member: "/home/x.rpgleinc", unresolvable: "IFS path" });
    const result = resolveReferences([missing, ifs], rows, ["PRODLIB"]);
    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.unresolved, [missing, ifs]);
  });
});

describe("librariesToSearch", () => {
  it("adds libraries named in the source after the configured order", () => {
    assert.deepEqual(
      librariesToSearch([ref({ kind: "copybook", library: "OTHERLIB", member: "X" })], ["prodlib", "devlib"]),
      ["PRODLIB", "DEVLIB", "OTHERLIB"]
    );
  });
});
