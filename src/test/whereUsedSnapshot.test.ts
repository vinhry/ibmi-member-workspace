import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_WHERE_USED_SNAPSHOTS, SnapshotStore } from "../whereUsedSnapshot";

describe("SnapshotStore", () => {
  it("reuses a snapshot until it is too old", () => {
    const store = new SnapshotStore(10, 1000);
    const file = store.fileFor("SYS|A");
    store.record("SYS|A", { file, takenAt: 0 });
    assert.equal(store.fresh("SYS|A", 999)?.file, file);
    assert.equal(store.fresh("SYS|A", 1000), undefined);
    // Taken again: the library keeps its file.
    assert.equal(store.fileFor("SYS|A"), file);
  });

  it("names files as valid 10-character system names", () => {
    const store = new SnapshotStore();
    const file = store.fileFor("SYS|A");
    assert.match(file, /^[A-Z][A-Z0-9]{0,9}$/);
    assert.equal(file.length, 10);
  });

  it(`keeps at most ${MAX_WHERE_USED_SNAPSHOTS} snapshots, giving the least recently used one's file to the next`, () => {
    const store = new SnapshotStore(3, 60_000);
    const files = ["A", "B", "C"].map((lib) => {
      const file = store.fileFor(lib);
      store.record(lib, { file, takenAt: 0 });
      return file;
    });
    assert.equal(new Set(files).size, 3);
    store.fresh("A", 1); // A is now the most recently used; B is the oldest.
    const next = store.fileFor("D");
    assert.equal(next, files[1]);
    store.record("D", { file: next, takenAt: 1 });
    assert.equal(store.size, 3);
    assert.equal(store.fresh("B", 2), undefined);
    assert.equal(store.fresh("A", 2)?.file, files[0]);
  });

  it("forgets snapshots", () => {
    const store = new SnapshotStore();
    store.record("A", { file: store.fileFor("A"), takenAt: 0 });
    store.forget("A");
    assert.equal(store.fresh("A", 1), undefined);
    store.record("B", { file: store.fileFor("B"), takenAt: 0 });
    store.clear();
    assert.equal(store.size, 0);
  });

  it("doesn't count a snapshot as fresh while it is being taken again", () => {
    const store = new SnapshotStore(10, 60_000);
    const file = store.fileFor("A");
    store.record("A", { file, takenAt: 0 });
    // A refresh starts replacing the file's contents, then fails before recording.
    assert.equal(store.fileFor("A"), file);
    assert.equal(store.fresh("A", 1), undefined);
    // The next take reuses the same file.
    assert.equal(store.fileFor("A"), file);
  });

  it("never makes more files than the limit, even when takes fail", () => {
    const store = new SnapshotStore(3, 60_000);
    for (const lib of ["A", "B", "C"]) {
      store.record(lib, { file: store.fileFor(lib), takenAt: 0 });
    }
    const made = new Set<string>();
    for (const lib of ["D", "E", "F", "G", "H"]) {
      made.add(store.fileFor(lib)); // Each take fails: nothing is recorded.
      assert.ok(store.files <= 3, `${store.files} files`);
    }
    assert.equal(made.size, 1);
    store.record("I", { file: store.fileFor("I"), takenAt: 1 });
    assert.equal(store.files, 3);
    assert.equal(store.size, 3);
  });

  it("reuses a forgotten snapshot's file", () => {
    const store = new SnapshotStore(3, 60_000);
    const file = store.fileFor("A");
    store.record("A", { file, takenAt: 0 });
    store.forget("A");
    assert.equal(store.fileFor("A"), file);
    assert.equal(store.files, 1);
  });
});
