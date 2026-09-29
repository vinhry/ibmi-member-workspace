import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpTool } from "../bobMcpServer";
import { MAX_REFERENCE_COPIES, MAX_WHERE_USED_LIBRARIES, ResearchIo, createResearchTools } from "../bobMcpTools";
import type { MemberInfo } from "../memberInfo";
import { ReferenceCheckoutOptions, bringReferenceCopies } from "../referenceCopies";
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
    whereUsed: async () => [],
    searchSourceMembers: async () => [],
    describeFile: async () => undefined,
    serviceProgramExports: async () => undefined,
    ...overrides,
  };
  return { io, checkouts, brought };
}

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
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

  it("limits where-used to the first search libraries and reports libraries it couldn't read", async () => {
    const libraries = Array.from({ length: MAX_WHERE_USED_LIBRARIES + 2 }, (_, i) => `LIB${i}`);
    const { io } = fakeIo({
      searchLibraries: () => libraries,
      whereUsed: async (_name, library) => {
        if (library === "LIB1") {
          throw new Error("CPF3033");
        }
        return library === "LIB0" ? [{ library: "LIB0", program: "CALLER", text: "", objectLibrary: "*LIBL", objectType: "*PGM" }] : [];
      },
    });
    const result = await tool(createResearchTools(io), "find_where_used").call({ object: "ORDENT" }) as {
      librariesSearched: string[]; note?: string; usedBy: Array<{ program: string }>; librariesNotRead: Array<{ library: string }>;
    };
    assert.equal(result.librariesSearched.length, MAX_WHERE_USED_LIBRARIES);
    assert.ok(result.note);
    assert.deepEqual(result.usedBy.map((u) => u.program), ["CALLER"]);
    assert.deepEqual(result.librariesNotRead.map((l) => l.library), ["LIB1"]);
  });

  it("says so when not connected", async () => {
    const { io } = fakeIo({ connectedSystem: () => undefined });
    await assert.rejects(tool(createResearchTools(io), "list_checkouts").call({}), /Not connected/);
  });
});
