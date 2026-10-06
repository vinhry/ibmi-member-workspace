import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpTool } from "../bobMcpServer";
import {
  DEFAULT_WHERE_USED_LIBRARIES,
  MAX_LIBRARIES,
  MAX_REFERENCE_COPIES,
  MAX_WHERE_USED_LIBRARIES,
  ResearchIo,
  clampLibraryLimit,
  createResearchTools,
} from "../bobMcpTools";
import type { MemberInfo } from "../memberInfo";
import { ReferenceCheckoutOptions, bringReferenceCopies } from "../referenceCopies";
import { hashContent } from "../sync";
import type { CheckedOutMember } from "../types";

function entry(library: string, sourceFile: string, member: string, extension: string, reference: boolean): CheckedOutMember {
  return {
    id: `SYS|${library}|${sourceFile}|${member}`,
    system: "SYS",
    library,
    sourceFile,
    memberName: member,
    extension,
    localPath: `/work/${library}/${sourceFile}/${member}.${extension.toUpperCase()}`,
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "abc",
    status: "in-sync",
    ...(reference ? { kind: "reference" as const } : {}),
  };
}

describe("bringReferenceCopies", () => {
  it("checks out every new member as a read-only reference copy and never touches existing checkouts", async () => {
    const forChange = entry("DEVSRC", "QRPGLESRC", "ORDENT", "rpgle", false);
    const reference = entry("PRODSRC", "QCPYSRC", "PROTOS", "rpgleinc", true);
    const calls: ReferenceCheckoutOptions[] = [];
    const results = await bringReferenceCopies(
      {
        findEntry: (library, _file, member) => [forChange, reference].find((e) => e.library === library && e.memberName === member),
        checkoutMember: async (library, sourceFile, member, extension, options) => {
          calls.push(options);
          if (member === "BROKEN") {
            throw new Error("CPF9815");
          }
          return entry(library, sourceFile, member, extension, options.reference);
        },
        log: () => undefined,
      },
      [
        { library: "DEVSRC", sourceFile: "QRPGLESRC", memberName: "ORDENT", extension: "rpgle" },
        { library: "PRODSRC", sourceFile: "QCPYSRC", memberName: "PROTOS", extension: "rpgleinc" },
        { library: "PRODSRC", sourceFile: "QRPGLESRC", memberName: "CUSTINQ", extension: "sqlrpgle" },
        { library: "PRODSRC", sourceFile: "QRPGLESRC", memberName: "BROKEN", extension: "rpgle" },
      ],
      []
    );
    assert.deepEqual(results.map((r) => [r.status, r.readOnly]), [
      ["checkedOutForChange", false],
      ["alreadyReference", true],
      ["brought", true],
      ["failed", undefined],
    ]);
    // Only the two members not checked out were downloaded, both as reference copies.
    assert.equal(calls.length, 2);
    assert.ok(calls.every((options) => options.reference === true && options.redownloadBehavior === "skip"));
    assert.ok(calls.every((options) => options.discardLocalChanges === false));
  });
});

describe("bringReferenceCopies when abandoned", () => {
  it("brings nothing more once the signal is aborted", async () => {
    const abandoned = new AbortController();
    const brought: string[] = [];
    const results = await bringReferenceCopies(
      {
        findEntry: () => undefined,
        checkoutMember: async (library, sourceFile, member, extension, options) => {
          brought.push(member);
          abandoned.abort();
          return entry(library, sourceFile, member, extension, options.reference);
        },
        log: () => undefined,
      },
      ["A", "B", "C"].map((memberName) => ({ library: "L", sourceFile: "F", memberName, extension: "rpgle" })),
      [],
      abandoned.signal,
      { limit: 1 }
    );
    assert.deepEqual(brought, ["A"]);
    assert.deepEqual(results.map((r) => r.status), ["brought", "cancelled", "cancelled"]);
  });
});

describe("bringReferenceCopies several at once", () => {
  it("downloads a few members at the same time and keeps the members' order", async () => {
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const names = ["A", "B", "C", "D", "E", "F"];
    const run = bringReferenceCopies(
      {
        findEntry: () => undefined,
        checkoutMember: async (library, sourceFile, member, extension, options) => {
          inFlight++;
          most = Math.max(most, inFlight);
          await new Promise<void>((resolve) => waiting.push(resolve));
          inFlight--;
          return entry(library, sourceFile, member, extension, options.reference);
        },
        log: () => undefined,
      },
      names.map((memberName) => ({ library: "L", sourceFile: "F", memberName, extension: "rpgle" })),
      []
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(waiting.length, 4);
    // Finish them in reverse order; the results still follow the members.
    while (waiting.length > 0) {
      waiting.pop()!();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const results = await run;
    assert.equal(most, 4);
    assert.deepEqual(results.map((r) => r.member), names.map((name) => `L/F(${name})`));
    assert.ok(results.every((r) => r.status === "brought"));
  });
});

/** A fake IBM i with one program, its copybook and a file; records every reference copy asked for. */
function fakeIo(overrides: Partial<ResearchIo> = {}) {
  const checkouts: CheckedOutMember[] = [];
  const brought: MemberInfo[][] = [];
  const io: ResearchIo = {
    connectedSystem: () => "SYS",
    entries: () => checkouts,
    findEntry: (_system, library, sourceFile, member) =>
      checkouts.find((e) => e.library === library && e.sourceFile === sourceFile && e.memberName === member),
    findMembers: async (members, libraries) =>
      [
        { library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT", sourceType: "SQLRPGLE" },
        { library: "PRODSRC", sourceFile: "QCPYSRC", member: "PROTOS", sourceType: "RPGLEINC" },
      ].filter((row) => members.includes(row.member) && libraries.includes(row.library)),
    bringReferenceCopies: async (_system, members) => {
      brought.push(members);
      return members.map((m) => {
        const copy = entry(m.library, m.sourceFile, m.memberName, m.extension, true);
        checkouts.push(copy);
        return { member: `${m.library}/${m.sourceFile}(${m.memberName})`, status: "brought" as const, localPath: copy.localPath, readOnly: true };
      });
    },
    readLocal: () => ["**FREE", "/copy qcpysrc,protos", "dcl-proc main export;", "end-proc;", "line 5"].join("\n"),
    lookupDependencies: async () => ({
      references: [],
      outcomes: [{ label: "source scan", status: "ran", count: 2 }],
      resolution: {
        resolved: [{
          reference: { kind: "copybook", sourceFile: "QCPYSRC", member: "PROTOS", line: 2, text: "/copy qcpysrc,protos", foundBy: ["source scan"] },
          candidates: [{ library: "PRODSRC", sourceFile: "QCPYSRC", member: "PROTOS", sourceType: "RPGLEINC" }],
        }],
        unresolved: [{ kind: "table", member: "CUSTOMER_MASTER", line: 9, text: "exec sql …" }],
      },
      procedures: [{ kind: "procedure", member: "CUST_get", line: 3, text: "dcl-pr", foundBy: ["source scan"] }],
      libraries: ["PRODSRC"],
    }),
    searchLibraries: () => ["PRODSRC"],
    whereUsedLibraryLimit: () => undefined,
    whereUsed: async () => ({ rows: [], snapshotTakenAt: "2026-01-01T00:00:00.000Z", reusedSnapshot: false }),
    searchSourceMembers: async () => [],
    describeFile: async () => undefined,
    serviceProgramExports: async () => undefined,
    downloadMember: async () => ["**FREE", "/copy qcpysrc,protos", "dcl-proc main export;", "end-proc;", "line 5"].join("\n"),
    describeObject: async (name, libraries) => libraries.includes("PRODOBJ") && name === "ORDENT"
      ? {
        library: "PRODOBJ", name: "ORDENT", type: "*PGM",
        object: { attribute: "RPGLE", text: "Order entry", owner: "PRODOWN" },
        program: { programType: "ILE", activationGroup: "QILE", moduleCount: "2", serviceProgramCount: "1" },
        modules: [{ library: "PRODOBJ", name: "ORDENT" }, { library: "PRODOBJ", name: "ORDUTIL" }],
        boundServicePrograms: [{ library: "PRODOBJ", name: "CUSTSRV", signature: "CUSTSRV_V1" }],
        notes: [],
      }
      : undefined,
    jobLogMessages: async ({ job, maxMessages, minSeverity }) => ({
      job: job ?? "*",
      messages: [{ position: 1, id: "CPF9898", type: "ESCAPE", severity: 40, sent: "2026-10-06 10:00:00", fromProgram: "QCMD", text: `${maxMessages}/${minSeverity}`, help: "" }],
    }),
    sampleFileRows: async (name, libraries, { member, maxRows }) => libraries.includes("PRODDTA") && name === "CUSTMAST"
      ? {
        library: "PRODDTA", systemName: "CUSTMAST", sqlName: "CUSTOMER_MASTER", ...(member ? { member } : {}),
        columns: ["CUSTNO", "NAME"],
        rows: Array.from({ length: Math.min(maxRows, 3) }, (_, i) => [String(i + 1), `Customer ${i + 1}`]),
        notes: [],
      }
      : undefined,
    allowDataSamples: () => false,
    ...overrides,
  };
  return { io, checkouts, brought };
}

/** A tool, callable without a signal (one that is never aborted) unless the test passes one. */
function tool(tools: McpTool[], name: string): { call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> } {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, name);
  return { call: (args, signal = new AbortController().signal) => found.call(args, signal) };
}

describe("research tools", () => {
  it("offers no tool that could change a member or the IBM i", () => {
    const names = createResearchTools(fakeIo().io).map((t) => t.name);
    assert.deepEqual(names, [
      "list_checkouts",
      "read_member_source",
      "find_member_dependencies",
      "bring_reference_copies",
      "find_where_used",
      "search_source_members",
      "describe_file",
      "list_service_program_exports",
      "compare_checkout",
      "describe_object",
      "read_job_log",
      "sample_file_data",
    ]);
    for (const name of names) {
      assert.doesNotMatch(name, /upload|merge|write|edit|delete|discard|compile|run/);
    }
  });

  it("gives no tool a way to ask for an editable checkout", () => {
    for (const t of createResearchTools(fakeIo().io)) {
      assert.doesNotMatch(JSON.stringify(t.inputSchema), /"reference"|editable|forChange|writable/i, t.name);
    }
    // The only write path hard-codes reference copies.
    const source = readFileSync(join(__dirname, "..", "..", "src", "referenceCopies.ts"), "utf-8");
    assert.match(source, /reference: true,/);
    assert.doesNotMatch(source, /reference: (?!true)/);
  });

  it("reads a member, bringing it as a reference copy first", async () => {
    const { io, brought } = fakeIo();
    const read = tool(createResearchTools(io), "read_member_source");
    const result = await read.call({ library: "prodsrc", sourceFile: "QRPGLESRC", member: "ordent", startLine: 2, endLine: 3 }) as {
      source: string; readOnlyReferenceCopy: boolean; broughtAsReferenceCopy: boolean; totalLines: number; more?: string;
    };
    assert.deepEqual(brought, [[{ library: "PRODSRC", sourceFile: "QRPGLESRC", memberName: "ORDENT", extension: "sqlrpgle" }]]);
    assert.equal(result.readOnlyReferenceCopy, true);
    assert.equal(result.broughtAsReferenceCopy, true);
    assert.equal(result.source, "/copy qcpysrc,protos\ndcl-proc main export;");
    assert.equal(result.totalLines, 5);
    assert.match(result.more ?? "", /startLine 4/);

    // Read again: the copy is used, nothing more is brought.
    await read.call({ library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT" });
    assert.equal(brought.length, 1);
  });

  it("uses a member checked out for change as it is", async () => {
    const { io, checkouts, brought } = fakeIo();
    checkouts.push(entry("PRODSRC", "QRPGLESRC", "ORDENT", "sqlrpgle", false));
    const result = await tool(createResearchTools(io), "read_member_source").call({
      library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT",
    }) as { readOnlyReferenceCopy: boolean };
    assert.equal(result.readOnlyReferenceCopy, false);
    assert.equal(brought.length, 0);
  });

  it("finds dependencies and brings their source as reference copies", async () => {
    const { io, brought } = fakeIo();
    const result = await tool(createResearchTools(io), "find_member_dependencies").call({
      library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT",
    }) as {
      uses: Array<{ kind: string; source: { member: string } }>;
      sourceNotFound: Array<{ name: string }>;
      boundProcedures: Array<{ name: string }>;
      definesProcedures: Array<{ name: string; exported: boolean }>;
      referenceCopies: Array<{ status: string }>;
    };
    assert.deepEqual(result.uses.map((u) => [u.kind, u.source.member]), [["copybook", "PROTOS"]]);
    assert.deepEqual(result.sourceNotFound.map((r) => r.name), ["CUSTOMER_MASTER"]);
    assert.deepEqual(result.boundProcedures.map((r) => r.name), ["CUST_get"]);
    assert.deepEqual(result.definesProcedures, [{ name: "MAIN", exported: true, line: 3 }]);
    // The member itself, then its copybook.
    assert.deepEqual(brought.map((batch) => batch.map((m) => m.memberName)), [["ORDENT"], ["PROTOS"]]);
    assert.deepEqual(result.referenceCopies.map((r) => r.status), ["brought"]);
  });

  it("only lists dependencies when asked not to bring them", async () => {
    const { io, brought } = fakeIo();
    const result = await tool(createResearchTools(io), "find_member_dependencies").call({
      library: "PRODSRC", sourceFile: "QRPGLESRC", member: "ORDENT", bringReferenceCopies: false,
    }) as { referenceCopies?: unknown };
    assert.equal(result.referenceCopies, undefined);
    assert.deepEqual(brought.map((batch) => batch.map((m) => m.memberName)), [["ORDENT"]]);
  });

  it("caps reference copies per call", async () => {
    const { io } = fakeIo();
    const members = Array.from({ length: MAX_REFERENCE_COPIES + 1 }, (_, i) => ({ library: "PRODSRC", sourceFile: "QCPYSRC", member: `M${i}` }));
    await assert.rejects(tool(createResearchTools(io), "bring_reference_copies").call({ members }), /1 to 50/);
  });

  it("reports members that don't exist instead of bringing them", async () => {
    const { io, brought } = fakeIo();
    const result = await tool(createResearchTools(io), "bring_reference_copies").call({
      members: [{ library: "PRODSRC", sourceFile: "QCPYSRC", member: "PROTOS" }, { library: "PRODSRC", sourceFile: "QCPYSRC", member: "GONE" }],
    }) as { referenceCopies: Array<{ member: string; status: string }> };
    assert.deepEqual(result.referenceCopies.map((r) => [r.member, r.status]), [
      ["PRODSRC/QCPYSRC(PROTOS)", "brought"],
      ["PRODSRC/QCPYSRC(GONE)", "failed"],
    ]);
    assert.equal(brought[0].length, 1);
  });

  it("rejects names that aren't IBM i names before calling the IBM i", async () => {
    const { io } = fakeIo();
    const tools = createResearchTools(io);
    await assert.rejects(tool(tools, "read_member_source").call({ library: "A B", sourceFile: "Q", member: "X" }), /library name/);
    await assert.rejects(tool(tools, "find_where_used").call({ object: "X); DLTLIB(PROD" }), /object name/);
    await assert.rejects(tool(tools, "search_source_members").call({ pattern: "'; DROP" }), /pattern/);
    await assert.rejects(tool(tools, "find_where_used").call({ object: "X", libraries: ["OK", "NOT OK"] }), /library name/);
  });

  it(`takes at most ${MAX_LIBRARIES} libraries per call`, async () => {
    const searched: string[][] = [];
    const { io } = fakeIo({ searchSourceMembers: async (_pattern, libraries) => (searched.push(libraries), []) });
    const tools = createResearchTools(io);
    const names = (count: number) => Array.from({ length: count }, (_, i) => `LIB${i}`);
    await assert.rejects(tool(tools, "search_source_members").call({ pattern: "ORD*", libraries: names(MAX_LIBRARIES + 1) }), /1 to 250/);
    await assert.rejects(tool(tools, "describe_file").call({ name: "CUSTMAST", libraries: names(MAX_LIBRARIES + 1) }));
    assert.equal(searched.length, 0);
    await tool(tools, "search_source_members").call({ pattern: "ORD*", libraries: names(MAX_LIBRARIES) });
    assert.equal(searched[0].length, MAX_LIBRARIES);
  });

  it("compares a checked-out member with the IBM i and says how it differs", async () => {
    const { io, checkouts } = fakeIo({
      readLocal: () => ["**FREE", "/copy qcpysrc,protos", "dcl-proc main export;", "  new line;", "end-proc;", "line 5"].join("\n"),
    });
    // The baseline is the IBM i's text: only the local copy changed.
    const remote = await io.downloadMember("SYS", "DEVSRC", "QRPGLESRC", "ORDENT");
    checkouts.push({ ...entry("DEVSRC", "QRPGLESRC", "ORDENT", "rpgle", false), hashVersion: 2, remoteHashAtCheckout: hashContent(remote) });
    const result = await tool(createResearchTools(io), "compare_checkout").call({ library: "DEVSRC", sourceFile: "QRPGLESRC", member: "ORDENT", context: 0 }) as Record<string, unknown>;
    assert.equal(result.identical, false);
    assert.equal(result.linesOnlyLocal, 1);
    assert.equal(result.linesOnlyOnIbmi, 0);
    assert.equal(result.statusNow, "modified");
    assert.match(String(result.diff), /^--- local \/work/m);
    assert.match(String(result.diff), /^- {2}new line;$/m);
    assert.equal(result.note, undefined);
  });

  it("says a checkout is identical to the IBM i, and refuses a member that isn't checked out", async () => {
    const { io, checkouts } = fakeIo();
    checkouts.push({ ...entry("DEVSRC", "QRPGLESRC", "ORDENT", "rpgle", false), hashVersion: 2 });
    const same = await tool(createResearchTools(io), "compare_checkout").call({ library: "DEVSRC", sourceFile: "QRPGLESRC", member: "ORDENT" }) as Record<string, unknown>;
    assert.equal(same.identical, true);
    assert.equal(same.diff, "");
    await assert.rejects(
      tool(createResearchTools(io), "compare_checkout").call({ library: "DEVSRC", sourceFile: "QRPGLESRC", member: "OTHER" }),
      /isn't in the checkout folder; use read_member_source/
    );
  });

  it("describes a program and what is bound into it, in the search libraries or a named one", async () => {
    const { io } = fakeIo({ searchLibraries: () => ["PRODOBJ"] });
    const result = await tool(createResearchTools(io), "describe_object").call({ name: "ordent" }) as Record<string, unknown>;
    assert.equal(result.type, "*PGM");
    assert.equal((result.modules as unknown[]).length, 2);
    await assert.rejects(tool(createResearchTools(io), "describe_object").call({ name: "ORDENT", library: "OTHERLIB" }), /No program or service program named ORDENT in OTHERLIB/);
    await assert.rejects(tool(createResearchTools(io), "describe_object").call({ name: "ORDENT", objectType: "*FILE" }), /must be \*PGM or \*SRVPGM/);
  });

  it("reads the job log with bounded size and a validated job name", async () => {
    const { io } = fakeIo();
    const log = tool(createResearchTools(io), "read_job_log");
    const byDefault = await log.call({}) as { job: string; messages: Array<{ text: string }> };
    assert.equal(byDefault.job, "*");
    assert.equal(byDefault.messages[0].text, "50/0");
    const named = await log.call({ job: "123456/QUSER/QZDASOINIT", maxMessages: 5, minSeverity: 30 }) as { job: string; messages: Array<{ text: string }> };
    assert.equal(named.job, "123456/QUSER/QZDASOINIT");
    assert.equal(named.messages[0].text, "5/30");
    await assert.rejects(log.call({ job: "QZDASOINIT; DROP" }), /must be a job name/);
    await assert.rejects(log.call({ maxMessages: 501 }), /from 1 to 500/);
  });

  it("refuses data samples until the user allows them, naming the setting of the host", async () => {
    const off = fakeIo({ searchLibraries: () => ["PRODDTA"] });
    await assert.rejects(tool(createResearchTools(off.io), "sample_file_data").call({ name: "CUSTMAST" }), /ibmi-member-workspace\.researchTools\.allowDataSamples/);
    const bob = fakeIo({ dataSamplesSetting: "ibmi-member-workspace.researchTools.allowDataSamples" });
    assert.match(createResearchTools(bob.io).find((t) => t.name === "sample_file_data")!.description, /researchTools\.allowDataSamples/);
  });

  it("returns rows as text once allowed, at most 100, from a named member too", async () => {
    const { io } = fakeIo({ allowDataSamples: () => true, searchLibraries: () => ["PRODDTA"] });
    const sample = tool(createResearchTools(io), "sample_file_data");
    const rows = await sample.call({ name: "custmast", maxRows: 2 }) as { rows: unknown[][]; member?: string };
    assert.deepEqual(rows.rows, [["1", "Customer 1"], ["2", "Customer 2"]]);
    assert.equal(rows.member, undefined);
    const member = await sample.call({ name: "CUSTMAST", member: "ARCHIVE" }) as { member?: string };
    assert.equal(member.member, "ARCHIVE");
    await assert.rejects(sample.call({ name: "CUSTMAST", maxRows: 101 }), /from 1 to 100/);
    await assert.rejects(sample.call({ name: "NOPE" }), /No file or table named NOPE in PRODDTA/);
  });

  describe("find_where_used library limit", () => {
    const libraryNames = (count: number) => Array.from({ length: count }, (_, i) => `LIB${i}`);
    type WhereUsedResult = {
      librariesSearched: string[];
      librariesLeftOut?: string[];
      note?: string;
      usedBy: Array<{ program: string }>;
      librariesNotRead?: Array<{ library: string }>;
      elapsedSeconds: number;
    };
    const run = async (limit: unknown, args: Record<string, unknown> = {}, searchLibraries = libraryNames(40)) => {
      const read: string[] = [];
      const refreshes: boolean[] = [];
      const { io } = fakeIo({
        searchLibraries: () => searchLibraries,
        whereUsedLibraryLimit: () => limit,
        whereUsed: async (_name, library, _type, options) => {
          read.push(library);
          refreshes.push(options.refresh === true);
          if (library === "LIB1") {
            throw new Error("CPF3033");
          }
          return {
            rows: library === "LIB0" ? [{ library: "LIB0", program: "CALLER", text: "", objectLibrary: "*LIBL", objectType: "*PGM" }] : [],
            snapshotTakenAt: "2026-01-01T00:00:00.000Z",
            reusedSnapshot: false,
          };
        },
      });
      const result = await tool(createResearchTools(io), "find_where_used").call({ object: "ORDENT", ...args }) as WhereUsedResult;
      return { result, read, refreshes };
    };

    it("reads the first 10 search libraries by default and says which were left out", async () => {
      const { result, read } = await run(undefined);
      assert.equal(read.length, DEFAULT_WHERE_USED_LIBRARIES);
      assert.deepEqual(result.librariesSearched, libraryNames(10));
      assert.deepEqual(result.librariesLeftOut, libraryNames(40).slice(10));
      assert.match(result.note ?? "", /bob\.whereUsedMaxLibraries/);
      assert.deepEqual(result.usedBy.map((u) => u.program), ["CALLER"]);
      assert.deepEqual(result.librariesNotRead?.map((l) => l.library), ["LIB1"]);
      assert.equal(typeof result.elapsedSeconds, "number");
    });

    it("follows the user's setting", async () => {
      assert.equal((await run(20)).read.length, 20);
    });

    it("names the setting of the host it runs in", async () => {
      const { io } = fakeIo({
        searchLibraries: () => libraryNames(40),
        whereUsedSetting: "ibmi-member-workspace.agents.whereUsedMaxLibraries",
      });
      const tools = createResearchTools(io);
      assert.match(tools.find((t) => t.name === "find_where_used")?.description ?? "", /agents\.whereUsedMaxLibraries/);
      const result = await tool(tools, "find_where_used").call({ object: "ORDENT" }) as WhereUsedResult;
      assert.match(result.note ?? "", /ibmi-member-workspace\.agents\.whereUsedMaxLibraries/);
    });

    it("keeps the setting within 1 to 25", async () => {
      assert.equal((await run(0)).read.length, 1);
      assert.equal((await run(99)).read.length, MAX_WHERE_USED_LIBRARIES);
      assert.equal((await run("not a number")).read.length, DEFAULT_WHERE_USED_LIBRARIES);
    });

    it("reads at most 25 of the libraries a call names, whatever the setting", async () => {
      const { result, read } = await run(5, { libraries: libraryNames(30) });
      assert.equal(read.length, MAX_WHERE_USED_LIBRARIES);
      assert.deepEqual(result.librariesLeftOut, libraryNames(30).slice(25));
      assert.match(result.note ?? "", /call again/);
    });

    it("never reads IBM system libraries", async () => {
      const { result, read } = await run(undefined, {}, ["QSYS", "PRODOBJ", "QSYS2", "QTEMP"]);
      assert.deepEqual(read, ["PRODOBJ"]);
      assert.deepEqual((result as unknown as { systemLibrariesSkipped: string[] }).systemLibrariesSkipped, ["QSYS", "QSYS2", "QTEMP"]);
      assert.deepEqual((await run(undefined, { libraries: ["QSYS"] })).read, []);
    });

    it("passes refresh on only when asked", async () => {
      assert.deepEqual((await run(2)).refreshes, [false, false]);
      assert.deepEqual((await run(2, { refresh: true })).refreshes, [true, true]);
    });

    it("stops reading libraries once the client stopped waiting", async () => {
      const abandoned = new AbortController();
      const read: string[] = [];
      const { io } = fakeIo({
        searchLibraries: () => libraryNames(5),
        whereUsed: async (_name, library) => {
          read.push(library);
          abandoned.abort();
          return { rows: [], snapshotTakenAt: "2026-01-01T00:00:00.000Z", reusedSnapshot: false };
        },
      });
      const result = await tool(createResearchTools(io), "find_where_used").call({ object: "ORDENT" }, abandoned.signal) as WhereUsedResult;
      assert.deepEqual(read, ["LIB0"]);
      assert.deepEqual(result.librariesSearched, ["LIB0"]);
    });

    it("adds no note when every library was read", async () => {
      const { result } = await run(undefined, { libraries: ["LIB0", "LIB2"] });
      assert.deepEqual(result.librariesSearched, ["LIB0", "LIB2"]);
      assert.equal(result.note, undefined);
      assert.equal(result.librariesLeftOut, undefined);
    });
  });

  it("clamps the library limit setting", () => {
    assert.equal(clampLibraryLimit(undefined), 10);
    assert.equal(clampLibraryLimit(""), 10);
    assert.equal(clampLibraryLimit(-3), 1);
    assert.equal(clampLibraryLimit(12.7), 12);
    assert.equal(clampLibraryLimit(1000), 25);
  });

  it("says so when not connected", async () => {
    const { io } = fakeIo({ connectedSystem: () => undefined });
    await assert.rejects(tool(createResearchTools(io), "list_checkouts").call({}), /Not connected/);
  });
});
