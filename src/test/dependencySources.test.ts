import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RawReference } from "../dependencyScan";
import {
  CompiledObject,
  DependencyProvider,
  ProviderAvailabilityCache,
  ProviderGroup,
  createCrossReferenceProvider,
  createProgramReferencesProvider,
  crossReferenceKind,
  crossReferenceStatement,
  mergeReferences,
  objectKey,
  parseCrossReferenceConfigs,
  pgmRefRowsToObjects,
  runProviders,
  selectProviders,
  summarizeRun,
  xrefRowsToReferences,
} from "../dependencySources";
import type { CheckedOutMember } from "../types";

const entry: CheckedOutMember = {
  id: "SYS|DEVLIB|QRPGLESRC|ORD001",
  system: "SYS",
  library: "DEVLIB",
  sourceFile: "QRPGLESRC",
  memberName: "ORD001",
  extension: "rpgle",
  localPath: "/tmp/ORD001.RPGLE",
  checkedOutAt: "2026-01-01T00:00:00.000Z",
  remoteHashAtCheckout: "abc",
  status: "checked-out",
};

const context = { system: "SYS", libraries: ["PRODOBJ", "PRODSRC"] };

function fakeProvider(overrides: Partial<DependencyProvider> & Pick<DependencyProvider, "id">): DependencyProvider {
  return {
    label: overrides.id,
    group: "crossReferences",
    applies: () => true,
    available: async () => ({ ok: true }),
    find: async () => ({ references: [] }),
    ...overrides,
  };
}

describe("pgmRefRowsToObjects", () => {
  it("keeps files, programs and service programs, once each", () => {
    const objects = pgmRefRowsToObjects([
      { WHFNAM: "CUSTMAST  ", WHLNAM: "PRODLIB   ", WHOTYP: "*FILE" },
      { WHFNAM: "ORD002", WHLNAM: "*LIBL", WHOTYP: "*PGM" },
      { WHFNAM: "UTILS", WHLNAM: "PRODLIB", WHOTYP: "*SRVPGM" },
      { WHFNAM: "CTLDTA", WHLNAM: "PRODLIB", WHOTYP: "*DTAARA" },
      { WHFNAM: "CUSTMAST", WHLNAM: "PRODLIB", WHOTYP: "*FILE" },
      { WHFNAM: "", WHLNAM: "", WHOTYP: "*PGM" },
    ]);
    assert.deepEqual(objects, [
      { library: "PRODLIB", name: "CUSTMAST", type: "*FILE", kind: "file" },
      { library: undefined, name: "ORD002", type: "*PGM", kind: "program" },
      { library: "PRODLIB", name: "UTILS", type: "*SRVPGM", kind: "program" },
    ]);
  });
});

describe("createProgramReferencesProvider", () => {
  const object: CompiledObject = { library: "PRODOBJ", name: "ORD001", type: "*PGM" };

  it("applies only to source that compiles to a program", () => {
    const provider = createProgramReferencesProvider({
      sqlServicesAvailable: async () => true,
      findCompiledObject: async () => undefined,
      programReferences: async () => [],
      objectSources: async () => new Map(),
    });
    assert.equal(provider.applies(entry), true);
    assert.equal(provider.applies({ ...entry, extension: "dspf" }), false);
  });

  it("is unavailable without the IBM i SQL services", async () => {
    const provider = createProgramReferencesProvider({
      sqlServicesAvailable: async () => false,
      findCompiledObject: async () => undefined,
      programReferences: async () => [],
      objectSources: async () => new Map(),
    });
    assert.deepEqual(await provider.available(context), { ok: false, reason: "IBM i SQL services not available" });
  });

  it("notes a member that has no compiled program", async () => {
    const provider = createProgramReferencesProvider({
      sqlServicesAvailable: async () => true,
      findCompiledObject: async () => undefined,
      programReferences: async () => assert.fail("not called"),
      objectSources: async () => new Map(),
    });
    const result = await provider.find(entry, context);
    assert.deepEqual(result.references, []);
    assert.match(result.note ?? "", /no compiled program ORD001 in PRODOBJ, PRODSRC/);
  });

  it("points at the member each object was built from, or matches by name", async () => {
    const provider = createProgramReferencesProvider({
      sqlServicesAvailable: async () => true,
      findCompiledObject: async () => object,
      programReferences: async () => [
        { WHFNAM: "CUSTMAST", WHLNAM: "PRODOBJ", WHOTYP: "*FILE" },
        { WHFNAM: "ORD002", WHLNAM: "*LIBL", WHOTYP: "*PGM" },
      ],
      objectSources: async (objects) => new Map(objects.map((o) => [
        objectKey(o),
        { library: "PRODSRC", sourceFile: "QDDSSRC", member: "CUSTMAST" },
      ])),
    });
    const { references } = await provider.find(entry, context);
    assert.deepEqual(references, [
      { kind: "file", library: "PRODSRC", sourceFile: "QDDSSRC", member: "CUSTMAST", text: "DSPPGMREF of PRODOBJ/ORD001" },
      { kind: "program", member: "ORD002", text: "DSPPGMREF of PRODOBJ/ORD001" },
    ]);
  });
});

describe("crossReferenceStatement", () => {
  it("turns placeholders into parameters in order, including repeats", () => {
    const { sql, bindings } = crossReferenceStatement(
      "SELECT KIND, MEMBER FROM XREF WHERE LIB = {library} AND (MBR = {member} OR OBJ = {object}) AND SRCF = {sourceFile} AND M2 = {member};",
      entry
    );
    assert.equal(sql, "SELECT KIND, MEMBER FROM XREF WHERE LIB = ? AND (MBR = ? OR OBJ = ?) AND SRCF = ? AND M2 = ?");
    assert.deepEqual(bindings, ["DEVLIB", "ORD001", "ORD001", "QRPGLESRC", "ORD001"]);
  });

  it("accepts WITH queries", () => {
    assert.match(crossReferenceStatement("with x as (select 1 from sysibm.sysdummy1) select * from x", entry).sql, /^with/);
  });

  it("rejects anything but a single SELECT", () => {
    assert.throws(() => crossReferenceStatement("DELETE FROM XREF", entry), /SELECT/);
    assert.throws(() => crossReferenceStatement("SELECT 1 FROM X; DROP TABLE Y", entry), /single statement/);
  });
});

describe("xrefRowsToReferences", () => {
  it("reads columns in any case and keeps exact source locations", () => {
    const { references, dropped } = xrefRowsToReferences([
      { KIND: "*FILE", OBJECT: "custmast" },
      { kind: "copy", member: "dateutil", library: "prodsrc", source_file: "qcpysrc", line: 12, text: "/COPY QCPYSRC,DATEUTIL" },
      { KIND: "widget", MEMBER: "X" },
      { KIND: "*PGM" },
      { KIND: "*PGM", MEMBER: "ORD002", SOURCE_FILE: "QRPGLESRC" },
    ], "Abstract");
    assert.equal(dropped, 2);
    assert.deepEqual(references, [
      { kind: "file", library: undefined, sourceFile: undefined, member: "CUSTMAST", line: undefined, text: "Abstract" },
      { kind: "copybook", library: "PRODSRC", sourceFile: "QCPYSRC", member: "DATEUTIL", line: 12, text: "/COPY QCPYSRC,DATEUTIL" },
      { kind: "program", library: undefined, sourceFile: undefined, member: "ORD002", line: undefined, text: "Abstract" },
    ]);
  });

  it("maps tool wording and object types to kinds", () => {
    assert.equal(crossReferenceKind("/COPY"), "copybook");
    assert.equal(crossReferenceKind("*SRVPGM"), "program");
    assert.equal(crossReferenceKind("LF"), "file");
    assert.equal(crossReferenceKind(""), undefined);
  });
});

describe("parseCrossReferenceConfigs", () => {
  it("keeps valid entries and explains the others", () => {
    const { configs, problems } = parseCrossReferenceConfigs([
      { name: "Abstract", query: "SELECT 1 FROM X", requiresLibrary: "abstract", systems: ["prod400"] },
      { name: "", query: "SELECT 1 FROM X" },
      "nonsense",
    ]);
    assert.deepEqual(configs, [{ name: "Abstract", query: "SELECT 1 FROM X", requiresLibrary: "ABSTRACT", systems: ["prod400"] }]);
    assert.equal(problems.length, 2);
    assert.deepEqual(parseCrossReferenceConfigs(undefined), { configs: [], problems: [] });
  });
});

describe("createCrossReferenceProvider", () => {
  it("is unavailable where its required library doesn't exist", async () => {
    const provider = createCrossReferenceProvider(
      { name: "Abstract", query: "SELECT 1 FROM X", requiresLibrary: "ABSTRACT" },
      { libraryExists: async () => false, runQuery: async () => [], log: () => undefined }
    );
    assert.deepEqual(await provider.available(context), { ok: false, reason: "library ABSTRACT is not on this system" });
  });

  it("runs its query with the member's values and logs rows it can't use", async () => {
    const logs: string[] = [];
    const calls: Array<{ sql: string; bindings: string[] }> = [];
    const provider = createCrossReferenceProvider(
      { name: "Abstract", query: "SELECT KIND, MEMBER FROM XREF WHERE MBR = {member}" },
      {
        libraryExists: async () => true,
        runQuery: async (sql, bindings) => {
          calls.push({ sql, bindings });
          return [{ KIND: "*FILE", MEMBER: "CUSTMAST" }, { KIND: "?", MEMBER: "X" }];
        },
        log: (message) => logs.push(message),
      }
    );
    const { references } = await provider.find(entry, context);
    assert.deepEqual(calls, [{ sql: "SELECT KIND, MEMBER FROM XREF WHERE MBR = ?", bindings: ["ORD001"] }]);
    assert.deepEqual(references.map((ref) => ref.member), ["CUSTMAST"]);
    assert.match(logs.join("\n"), /skipped 1 row/);
  });
});

describe("selectProviders", () => {
  const all = [
    fakeProvider({ id: "source", group: "source" }),
    fakeProvider({ id: "programReferences", group: "programReferences" }),
    fakeProvider({ id: "xref:Abstract", group: "crossReferences", systems: ["prod400"] }),
    fakeProvider({ id: "xref:Everywhere", group: "crossReferences" }),
  ];
  const ids = (providers: DependencyProvider[]) => providers.map((p) => p.id);

  it("leaves out groups turned off in settings", () => {
    const enabled = new Set<ProviderGroup>(["source", "crossReferences"]);
    assert.deepEqual(ids(selectProviders(all, { enabled, system: "PROD400" })), ["source", "xref:Abstract", "xref:Everywhere"]);
  });

  it("uses a provider limited to some systems only on those systems", () => {
    const enabled = new Set<ProviderGroup>(["crossReferences"]);
    assert.deepEqual(ids(selectProviders(all, { enabled, system: "DEV400" })), ["xref:Everywhere"]);
  });
});

describe("runProviders", () => {
  it("merges what the available providers find and reports the others", async () => {
    const copybook: RawReference = { kind: "copybook", member: "DATEUTIL", line: 3, text: "/COPY DATEUTIL" };
    const providers = [
      fakeProvider({ id: "a", label: "source scan", find: async () => ({ references: [copybook] }) }),
      fakeProvider({ id: "b", label: "Abstract", available: async () => ({ ok: false, reason: "library ABSTRACT is not on this system" }) }),
      fakeProvider({ id: "c", label: "never", applies: () => false, find: async () => assert.fail("not applicable") }),
      fakeProvider({ id: "d", label: "DSPPGMREF", find: async () => { throw new Error("CPF9820 Not authorized to library PRODOBJ"); } }),
      fakeProvider({ id: "e", label: "Other", find: async () => { throw new Error("connection reset"); } }),
    ];
    const cache = new ProviderAvailabilityCache();
    const { references, outcomes } = await runProviders(providers, entry, context, cache);
    assert.deepEqual(references, [{ ...copybook, foundBy: ["source scan"] }]);
    assert.deepEqual(outcomes.map((o) => `${o.label}:${o.status}`), [
      "source scan:ran",
      "Abstract:unavailable",
      "DSPPGMREF:unavailable",
      "Other:failed",
    ]);
    assert.equal(cache.known("SYS", "d")?.ok, false, "a missing object or authority isn't retried this session");
    assert.equal(cache.known("SYS", "e")?.ok, true, "a one-off failure is retried next time");
  });

  it("probes each provider once per system until the connection changes", async () => {
    let probes = 0;
    const provider = fakeProvider({ id: "x", available: async () => { probes++; return { ok: true }; } });
    const cache = new ProviderAvailabilityCache();
    await runProviders([provider], entry, context, cache);
    await runProviders([provider], entry, context, cache);
    assert.equal(probes, 1);
    await runProviders([provider], entry, { ...context, system: "OTHER" }, cache);
    assert.equal(probes, 2);
    cache.reset();
    await runProviders([provider], entry, context, cache);
    assert.equal(probes, 3);
  });
});

describe("mergeReferences", () => {
  it("lists a member found by several providers once, with every provider", () => {
    const merged = mergeReferences([
      { kind: "copybook", member: "DATEUTIL", line: 3, text: "/COPY DATEUTIL", foundBy: ["source scan"] },
      { kind: "file", member: "CUSTMAST", text: "DSPPGMREF", foundBy: ["DSPPGMREF"] },
      { kind: "copybook", library: "PRODSRC", sourceFile: "QCPYSRC", member: "DATEUTIL", text: "Abstract", foundBy: ["Abstract"] },
      { kind: "file", member: "CUSTMAST", text: "Abstract", foundBy: ["Abstract"] },
    ]);
    assert.deepEqual(merged, [
      {
        kind: "copybook", library: "PRODSRC", sourceFile: "QCPYSRC", member: "DATEUTIL",
        line: 3, text: "/COPY DATEUTIL", foundBy: ["Abstract", "source scan"],
      },
      { kind: "file", member: "CUSTMAST", text: "DSPPGMREF", foundBy: ["DSPPGMREF", "Abstract"] },
    ]);
  });
});

describe("summarizeRun", () => {
  it("says which providers ran and which were not available", () => {
    assert.equal(
      summarizeRun([
        { label: "source scan", status: "ran", count: 3 },
        { label: "DSPPGMREF", status: "ran", count: 0, note: "no compiled program ORD001 in PRODOBJ" },
        { label: "Abstract", status: "unavailable", reason: "library ABSTRACT is not on this system" },
        { label: "Other", status: "failed", error: "boom" },
      ]),
      "Found by source scan (3), DSPPGMREF (0) · DSPPGMREF: no compiled program ORD001 in PRODOBJ · Abstract: not available · Other: failed"
    );
    assert.equal(summarizeRun([]), "No provider ran");
  });
});
