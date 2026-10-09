import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BaselineFiles, BaselineStore, baselineFileName, referencedBaselineHashes } from "../baselineStore";
import { hashContent } from "../sync";
import type { CheckedOutMember, CheckoutIndex } from "../types";

class MemoryFiles implements BaselineFiles {
  readonly files = new Map<string, string>();
  readonly log: string[] = [];
  failWrites = false;

  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }
  async read(name: string): Promise<Uint8Array> {
    const text = this.files.get(name);
    if (text === undefined) {
      throw new Error(`ENOENT: ${name}`);
    }
    return Buffer.from(text, "utf-8");
  }
  async write(name: string, data: Uint8Array): Promise<void> {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.log.push(`write ${name}`);
    this.files.set(name, Buffer.from(data).toString("utf-8"));
  }
  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename ${from} -> ${to}`);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async delete(name: string): Promise<void> {
    this.log.push(`delete ${name}`);
    this.files.delete(name);
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

function store(files?: MemoryFiles): { store: BaselineStore; messages: string[] } {
  const messages: string[] = [];
  return { store: new BaselineStore(files, (message) => messages.push(message)), messages };
}

const text = "     H DFTACTGRP(*NO)\r\n     C                   RETURN   \r\n";
const hash = hashContent(text);

function entry(remoteHashAtCheckout: string): CheckedOutMember {
  return {
    id: "x", system: "S", library: "L", sourceFile: "F", memberName: "M", extension: "rpgle", localPath: "/x",
    checkedOutAt: "", remoteHashAtCheckout, status: "in-sync",
  };
}

describe("baselineFileName", () => {
  it("is the hash, and refuses anything else", () => {
    assert.equal(baselineFileName(hash), hash);
    for (const bad of ["", "..", "abc", hash.toUpperCase(), `${hash}/x`, "../" + hash.substring(3)]) {
      assert.throws(() => baselineFileName(bad), /Not a baseline hash/);
    }
  });
});

describe("referencedBaselineHashes", () => {
  it("collects every work item of every system and the unassigned ones, ignoring legacy baselines", () => {
    const other = hashContent("other");
    const index: CheckoutIndex = {
      version: 3,
      systems: {
        A: { system: "A", directory: "A", activeWorkItem: "w1", workItems: { w1: [entry(hash)], w2: [entry("legacy")] } },
        B: { system: "B", directory: "B", activeWorkItem: "x", workItems: { x: [entry(other), entry(hash)] } },
      },
      unassignedWorkItems: { old: [entry(hashContent("unassigned"))] },
    };
    assert.deepEqual([...referencedBaselineHashes(index)].sort(), [hash, other, hashContent("unassigned")].sort());
  });
});

describe("BaselineStore", () => {
  it("keeps nothing and reads nothing without storage", async () => {
    const { store: s } = store(undefined);
    assert.equal(await s.write(hash, text), false);
    assert.equal(await s.read(hash), undefined);
    assert.equal(await s.ensure(hash, [text]), false);
    assert.equal(await s.prune(new Set()), 0);
  });

  it("writes through a temporary file renamed over the name, once", async () => {
    const files = new MemoryFiles();
    const { store: s } = store(files);
    assert.equal(await s.write(hash, text), true);
    assert.deepEqual(files.log, [`write ${hash}.tmp`, `rename ${hash}.tmp -> ${hash}`]);
    assert.equal(await s.write(hash, text), true);
    assert.equal(files.log.length, 2, "an existing baseline isn't rewritten");
    assert.equal(await s.read(hash), text);
  });

  it("refuses text that doesn't hash to the baseline, and logs instead of throwing", async () => {
    const files = new MemoryFiles();
    const { store: s, messages } = store(files);
    assert.equal(await s.write(hash, "something else"), false);
    assert.equal(files.files.size, 0);
    assert.match(messages[0], /doesn't hash/);
    assert.equal(await s.write("nothash", text), false);
    files.failWrites = true;
    assert.equal(await s.write(hash, text), false);
    assert.match(messages.at(-1) ?? "", /disk full/);
  });

  it("reads undefined for a missing or damaged baseline", async () => {
    const files = new MemoryFiles();
    const { store: s, messages } = store(files);
    assert.equal(await s.read(hash), undefined);
    files.files.set(hash, "damaged");
    assert.equal(await s.read(hash), undefined);
    assert.match(messages[0], /damaged/);
    assert.equal(await s.read("not a hash"), undefined);
  });

  it("ensures a baseline from the candidate that hashes to it", async () => {
    const files = new MemoryFiles();
    const { store: s } = store(files);
    assert.equal(await s.ensure(hash, ["other", "x"]), false);
    assert.equal(files.files.size, 0);
    // Line endings and trailing blanks don't matter: the candidate is kept as given.
    const candidate = text.replace(/\r\n/g, "\n");
    assert.equal(await s.ensure(hash, ["other", candidate]), true);
    assert.equal(files.files.get(hash), candidate);
    files.log.length = 0;
    assert.equal(await s.ensure(hash, [text]), true);
    assert.deepEqual(files.log, [], "already kept: nothing written");
  });

  it("prunes unreferenced baselines but leaves temporary files alone", async () => {
    const files = new MemoryFiles();
    const other = hashContent("other");
    files.files.set(hash, text);
    files.files.set(other, "other");
    files.files.set(`${other}.tmp`, "other");
    const { store: s } = store(files);
    assert.equal(await s.prune(new Set([hash])), 1);
    assert.deepEqual([...files.files.keys()].sort(), [hash, `${other}.tmp`].sort());
  });
});
