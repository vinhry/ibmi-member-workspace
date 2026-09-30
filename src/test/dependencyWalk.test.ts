import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SourceMemberRow } from "../dependencyResolve";
import type { RawReference, ReferenceKind } from "../dependencyScan";
import type { DependencySubject } from "../dependencySources";
import { WalkIo, WalkLimitReached, WalkLookup, mergeOutcomes, walkDependencies } from "../dependencyWalk";

const root: DependencySubject = { library: "DEVLIB", sourceFile: "QRPGLESRC", memberName: "ORD100", extension: "rpgle" };

type Use = [kind: ReferenceKind, member: string, sourceType?: string];

/**
 * A fake system: what each member uses, by member name. A used member resolves to the root
 * when it has the root's name, is unresolved when its name starts with "MISSING", and
 * otherwise resolves to PRODLIB/QSRC.
 */
function system(uses: Record<string, Use[]>, options: { fail?: string[] } = {}) {
  const looked: DependencySubject[] = [];
  const lookup = async (subject: DependencySubject): Promise<WalkLookup> => {
    looked.push(subject);
    if (options.fail?.includes(subject.memberName)) {
      throw new Error("connection reset");
    }
    const resolved: WalkLookup["resolution"]["resolved"] = [];
    const unresolved: RawReference[] = [];
    for (const [kind, member, sourceType = "RPGLE"] of uses[subject.memberName] ?? []) {
      const reference: RawReference = { kind, member, text: `uses ${member}` };
      if (member.startsWith("MISSING")) {
        unresolved.push(reference);
      } else {
        const candidate: SourceMemberRow = member === root.memberName
          ? { library: root.library, sourceFile: root.sourceFile, member, sourceType }
          : { library: "PRODLIB", sourceFile: "QSRC", member, sourceType };
        resolved.push({ reference, candidates: [candidate] });
      }
    }
    return {
      resolution: { resolved, unresolved },
      outcomes: [{ label: "source scan", status: "ran", count: resolved.length + unresolved.length }],
    };
  };
  return { looked, lookup };
}

function io(lookup: WalkIo["lookup"], overrides: Partial<WalkIo> = {}): WalkIo {
  return { lookup, onLimit: async () => assert.fail("no limit expected"), cancelled: () => false, ...overrides };
}

const wide = { maxDepth: 10, maxMembers: 100 };
const names = (nodes: Array<{ subject: DependencySubject }>) => nodes.map((node) => node.subject.memberName);

describe("walkDependencies", () => {
  it("walks breadth-first, recording each member's depth and the members it was reached through", async () => {
    const { lookup } = system({
      ORD100: [["copybook", "ORDCPY", "RPGLEINC"], ["program", "ORD200"]],
      ORDCPY: [["copybook", "DATECPY", "RPGLEINC"]],
      ORD200: [["file", "ORDHDR", "PF"]],
      ORDHDR: [["file", "FLDREF", "PF"]],
    });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(names(result.nodes), ["ORDCPY", "ORD200", "DATECPY", "ORDHDR", "FLDREF"]);
    assert.deepEqual(result.nodes.map((node) => node.depth), [1, 1, 2, 2, 3]);
    assert.deepEqual(result.nodes.map((node) => node.via), [[], [], ["ORDCPY"], ["ORD200"], ["ORD200", "ORDHDR"]]);
    assert.equal(result.stopped, false);
    assert.equal(result.cancelled, false);
  });

  it("looks into each member once, so a cycle ends and the root is never listed", async () => {
    const { lookup, looked } = system({
      ORD100: [["program", "ORD200"]],
      ORD200: [["program", "ORD100"], ["program", "ORD300"]],
      ORD300: [["program", "ORD200"]],
    });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(names(result.nodes), ["ORD200", "ORD300"]);
    assert.deepEqual(looked.map((s) => s.memberName), ["ORD100", "ORD200", "ORD300"]);
  });

  it("lists a member reached two ways once, through the shortest path", async () => {
    const { lookup, looked } = system({
      ORD100: [["copybook", "A", "RPGLEINC"], ["copybook", "B", "RPGLEINC"], ["copybook", "SHARED", "RPGLEINC"]],
      A: [["copybook", "SHARED", "RPGLEINC"]],
      B: [["copybook", "SHARED", "RPGLEINC"]],
    });
    const result = await walkDependencies(root, io(lookup), wide);
    const shared = result.nodes.filter((node) => node.subject.memberName === "SHARED");
    assert.equal(shared.length, 1);
    assert.deepEqual([shared[0].depth, shared[0].via], [1, []]);
    assert.equal(looked.filter((s) => s.memberName === "SHARED").length, 1);
  });

  it("lists the last level without looking into it, and asks before going deeper", async () => {
    const uses: Record<string, Use[]> = { ORD100: [["program", "L1"]], L1: [["program", "L2"]], L2: [["program", "L3"]] };
    const asked: WalkLimitReached[] = [];

    const stop = system(uses);
    const stopped = await walkDependencies(root, io(stop.lookup, {
      onLimit: async (reached) => { asked.push(reached); return false; },
    }), { maxDepth: 2, maxMembers: 100 });
    assert.deepEqual(names(stopped.nodes), ["L1", "L2"]);
    assert.deepEqual(stop.looked.map((s) => s.memberName), ["ORD100", "L1"]);
    assert.deepEqual(asked, [{ reason: "depth", members: 2, depth: 2 }]);
    assert.equal(stopped.stopped, true);

    const go = system(uses);
    const continued = await walkDependencies(root, io(go.lookup, { onLimit: async () => true }), { maxDepth: 2, maxMembers: 100 });
    assert.deepEqual(names(continued.nodes), ["L1", "L2", "L3"]);
    assert.equal(continued.stopped, false);
  });

  it("doesn't ask about depth when the walk ends before the last level", async () => {
    const { lookup } = system({ ORD100: [["program", "L1"]] });
    const result = await walkDependencies(root, io(lookup), { maxDepth: 2, maxMembers: 100 });
    assert.deepEqual(names(result.nodes), ["L1"]);
  });

  it("asks when the member limit is reached, and raises it by the same amount to go on", async () => {
    const uses: Record<string, Use[]> = {
      ORD100: ["A", "B", "C", "D", "E"].map((member): Use => ["copybook", member, "RPGLEINC"]),
    };
    const asked: WalkLimitReached[] = [];
    const stop = system(uses);
    const stopped = await walkDependencies(root, io(stop.lookup, {
      onLimit: async (reached) => { asked.push(reached); return false; },
    }), { maxDepth: 5, maxMembers: 2 });
    assert.deepEqual(names(stopped.nodes), ["A", "B"]);
    assert.deepEqual(asked, [{ reason: "members", members: 2, depth: 1 }]);
    assert.equal(stopped.stopped, true);

    let prompts = 0;
    const go = system(uses);
    const continued = await walkDependencies(root, io(go.lookup, { onLimit: async () => { prompts++; return true; } }), {
      maxDepth: 5,
      maxMembers: 2,
    });
    assert.deepEqual(names(continued.nodes), ["A", "B", "C", "D", "E"]);
    assert.equal(prompts, 2, "asked at 2 and at 4 members");
  });

  it("records a member it couldn't look into and goes on with the others", async () => {
    const { lookup } = system({
      ORD100: [["program", "BROKEN"], ["program", "ORD200"]],
      BROKEN: [["program", "NEVER"]],
      ORD200: [["copybook", "ORDCPY", "RPGLEINC"]],
    }, { fail: ["BROKEN"] });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(names(result.nodes), ["BROKEN", "ORD200", "ORDCPY"]);
    assert.deepEqual(result.failed, [{ member: "PRODLIB/QSRC(BROKEN)", via: [], error: "connection reset" }]);
  });

  it("fails the root lookup without listing anything", async () => {
    const { lookup } = system({}, { fail: ["ORD100"] });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.outcomes, []);
    assert.equal(result.failed[0].member, "DEVLIB/QRPGLESRC(ORD100)");
  });

  it("keeps what it found when cancelled", async () => {
    const { lookup } = system({
      ORD100: [["program", "ORD200"]],
      ORD200: [["program", "ORD300"]],
    });
    let calls = 0;
    const result = await walkDependencies(root, io(lookup, { cancelled: () => ++calls > 2 }), wide);
    assert.deepEqual(names(result.nodes), ["ORD200", "ORD300"]);
    assert.equal(result.cancelled, true);
    assert.equal(result.outcomes.length, 2, "ORD300 was listed but not looked into");
  });

  it("never follows bound procedures", async () => {
    const { lookup, looked } = system({ ORD100: [["procedure", "GETDATE"]] });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(result.nodes, []);
    assert.equal(looked.length, 1);
  });

  it("scans a member as its source type, and a copybook without one as the member that copies it", async () => {
    const { lookup, looked } = system({
      ORD100: [["copybook", "NOTYPE", ""], ["file", "CUSTMAST", "PF"], ["program", "UNTYPED", ""]],
    });
    await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(looked.slice(1).map((s) => `${s.memberName}.${s.extension}`), ["NOTYPE.rpgle", "CUSTMAST.pf", "UNTYPED.mbr"]);
  });

  it("collects unresolved references with the member they were found in", async () => {
    const { lookup } = system({
      ORD100: [["copybook", "MISSING1"], ["program", "ORD200"]],
      ORD200: [["file", "MISSING2"]],
    });
    const result = await walkDependencies(root, io(lookup), wide);
    assert.deepEqual(result.unresolved.map((u) => [u.reference.member, u.via]), [["MISSING1", []], ["MISSING2", ["ORD200"]]]);
  });
});

describe("mergeOutcomes", () => {
  it("adds up what each provider found and keeps a provider that never ran once", () => {
    const merged = mergeOutcomes([
      { member: "A", outcomes: [
        { label: "source scan", status: "ran", count: 2 },
        { label: "DSPPGMREF", status: "ran", count: 0, note: "no compiled program A" },
        { label: "Abstract", status: "unavailable", reason: "library ABSTRACT is not on this system" },
      ] },
      { member: "B", outcomes: [
        { label: "source scan", status: "ran", count: 3 },
        { label: "DSPPGMREF", status: "ran", count: 4 },
        { label: "Abstract", status: "unavailable", reason: "library ABSTRACT is not on this system" },
      ] },
    ]);
    assert.deepEqual(merged, [
      { label: "source scan", status: "ran", count: 5 },
      { label: "DSPPGMREF", status: "ran", count: 4, note: "no compiled program A" },
      { label: "Abstract", status: "unavailable", reason: "library ABSTRACT is not on this system" },
    ]);
  });

  it("reports a provider as run when it failed for one member but ran for another", () => {
    const merged = mergeOutcomes([
      { member: "A", outcomes: [{ label: "DSPPGMREF", status: "failed", error: "timeout" }] },
      { member: "B", outcomes: [{ label: "DSPPGMREF", status: "ran", count: 1 }] },
    ]);
    assert.deepEqual(merged, [{ label: "DSPPGMREF", status: "ran", count: 1 }]);
  });
});
