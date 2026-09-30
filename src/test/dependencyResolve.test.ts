import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RawReference } from "../dependencyScan";
import {
  SourceMemberRow,
  isIbmLibrary,
  librariesToSearch,
  resolveReferences,
  scopeReferences,
  searchScopeFrom,
} from "../dependencyResolve";

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

  it("looks for a COBOL copybook without a source file in the file the scan names first", () => {
    const cobolRows = [
      row("PRODLIB", "QCPYSRC", "ORDCOPY", "CBLLE"),
      row("PRODLIB", "QCBLLESRC", "ORDCOPY", "CBLLE"),
      row("PRODLIB", "QRPGLESRC", "ORDCOPY", "RPGLEINC"),
    ];
    const result = resolveReferences(
      [ref({ kind: "copybook", member: "ORDCOPY", defaultSourceFile: "QCBLLESRC" })],
      cobolRows,
      ["PRODLIB"]
    );
    assert.equal(result.resolved[0].candidates[0].sourceFile, "QCBLLESRC");
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
  it("searches exactly the scope's libraries, never ones references name", () => {
    assert.deepEqual(librariesToSearch({ kind: "libraryList", libraries: ["prodlib", "devlib"] }), ["PRODLIB", "DEVLIB"]);
    assert.deepEqual(librariesToSearch({ kind: "specific", libraries: ["PRODSRC"] }), ["PRODSRC"]);
  });

  it("searches every user library everywhere", () => {
    assert.equal(librariesToSearch({ kind: "everywhere", libraries: ["DEVLIB"] }), undefined);
  });
});

describe("searchScopeFrom", () => {
  const libraryList = ["devlib", "prodlib"];

  it("follows earlier versions without a scope setting: search libraries if any, else the library list", () => {
    assert.deepEqual(searchScopeFrom({ setting: undefined, searchLibraries: [], libraryList }), {
      scope: { kind: "libraryList", libraries: ["DEVLIB", "PRODLIB"] },
    });
    assert.deepEqual(searchScopeFrom({ setting: undefined, searchLibraries: [" prodsrc ", "PRODSRC", ""], libraryList }), {
      scope: { kind: "specific", libraries: ["PRODSRC"] },
    });
  });

  it("uses the scope setting when it is set", () => {
    assert.deepEqual(searchScopeFrom({ setting: "libraryList", searchLibraries: ["PRODSRC"], libraryList }).scope, {
      kind: "libraryList",
      libraries: ["DEVLIB", "PRODLIB"],
    });
    assert.deepEqual(searchScopeFrom({ setting: "everywhere", searchLibraries: ["PRODSRC"], libraryList }).scope, {
      kind: "everywhere",
      libraries: ["DEVLIB", "PRODLIB"],
    });
  });

  it("falls back to the library list, with a note, for specific libraries without any", () => {
    const { scope, note } = searchScopeFrom({ setting: "specific", searchLibraries: [], libraryList });
    assert.deepEqual(scope, { kind: "libraryList", libraries: ["DEVLIB", "PRODLIB"] });
    assert.match(note ?? "", /searchLibraries is empty/);
  });

  it("ignores an unknown scope value", () => {
    assert.equal(searchScopeFrom({ setting: "anywhere", searchLibraries: [], libraryList }).scope.kind, "libraryList");
  });
});

describe("scopeReferences", () => {
  const refs = [
    ref({ kind: "copybook", library: "DEVLIB", sourceFile: "QCPYSRC", member: "IN" }),
    ref({ kind: "program", library: "OLDPROD", sourceFile: "QRPGLESRC", member: "ORD200" }),
    ref({ kind: "file", member: "CUSTMAST" }),
  ];

  it("looks for a reference to a library outside the scope by name inside it, keeping its source file", () => {
    const { references, outside } = scopeReferences(refs, { kind: "libraryList", libraries: ["DEVLIB", "PRODLIB"] });
    assert.deepEqual(references[0], refs[0]);
    assert.equal(references[1].library, undefined);
    assert.equal(references[1].sourceFile, "QRPGLESRC");
    assert.equal("library" in references[1], false);
    assert.deepEqual(references[2], refs[2]);
    assert.deepEqual(outside, [{ reference: refs[1], library: "OLDPROD" }]);
    assert.equal(refs[1].library, "OLDPROD", "the original reference is unchanged");
  });

  it("keeps every reference as it is when searching everywhere", () => {
    const { references, outside } = scopeReferences(refs, { kind: "everywhere", libraries: ["DEVLIB"] });
    assert.deepEqual(references, refs);
    assert.deepEqual(outside, []);
  });

  it("then resolves the outside reference to the copy inside the scope", () => {
    const scope = { kind: "specific" as const, libraries: ["PRODLIB"] };
    const { references } = scopeReferences(
      [ref({ kind: "program", library: "OLDPROD", sourceFile: "QRPGLESRC", member: "ORD001" })],
      scope
    );
    const result = resolveReferences(references, rows, scope.libraries);
    assert.deepEqual(result.resolved[0].candidates, [rows[4]]);
  });
});

describe("resolveReferences ranking outside the order", () => {
  it("puts libraries outside the order after it, alphabetically", () => {
    const found = [
      row("ZLIB", "QRPGLESRC", "X", "RPGLEINC"),
      row("ALIB", "QRPGLESRC", "X", "RPGLEINC"),
      row("DEVLIB", "QRPGLESRC", "X", "RPGLEINC"),
    ];
    const result = resolveReferences([ref({ kind: "copybook", member: "X" })], found, ["DEVLIB"]);
    assert.deepEqual(result.resolved[0].candidates.map((c) => c.library), ["DEVLIB", "ALIB", "ZLIB"]);
  });
});

describe("isIbmLibrary", () => {
  it("leaves out IBM's libraries but keeps QGPL, QUSR… and user libraries", () => {
    for (const library of ["QSYS", "QSYS2", "QSYSINC", "QTEMP", "#LIBRARY", "QRPG"]) {
      assert.equal(isIbmLibrary(library), true, library);
    }
    for (const library of ["QGPL", "QUSRSYS", "qusrbrm", "MYLIB", "PRODLIB", "AQLIB"]) {
      assert.equal(isIbmLibrary(library), false, library);
    }
  });
});
