import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  hashContent,
  nextBaseline,
  statusAfterLocalSave,
  statusAfterUpload,
} from "../sync";

describe("classifyStatus", () => {
  it("is in-sync when local matches remote", () => {
    assert.equal(classifyStatus("a", "a", "base"), "in-sync");
  });

  it("is modified when only the local copy changed", () => {
    assert.equal(classifyStatus("local", "base", "base"), "modified");
  });

  it("is remote-changed when only the remote member changed", () => {
    assert.equal(classifyStatus("base", "remote", "base"), "remote-changed");
  });

  it("is conflict when both sides changed differently", () => {
    assert.equal(classifyStatus("local", "remote", "base"), "conflict");
  });
});

describe("hashContent", () => {
  it("treats CRLF and LF line endings as equal", () => {
    assert.equal(hashContent("A\r\nB\r\n", false), hashContent("A\nB\n", false));
  });

  it("ignores trailing blank lines", () => {
    assert.equal(hashContent("A\nB\n\n\n", false), hashContent("A\nB", false));
  });

  it("keeps leading and embedded blank lines significant", () => {
    assert.notEqual(hashContent("\nA\nB", false), hashContent("A\nB", false));
    assert.notEqual(hashContent("A\n\nB", false), hashContent("A\nB", false));
  });

  it("ignores trailing whitespace only when trimTrailingWhitespace is on", () => {
    assert.equal(hashContent("A  \nB\t\n", true), hashContent("A\nB\n", true));
    assert.notEqual(hashContent("A  \nB\t\n", false), hashContent("A\nB\n", false));
  });
});

describe("nextBaseline", () => {
  it("adopts the shared content when local and remote match", () => {
    assert.equal(nextBaseline("merged", "merged", "old"), "merged");
  });

  it("keeps the existing baseline when the sides differ", () => {
    assert.equal(nextBaseline("local", "remote", "old"), "old");
  });

  it("prevents a false conflict after a Merge Back followed by a local edit", () => {
    const baseline = nextBaseline("merged", "merged", "old");
    assert.equal(classifyStatus("edited", "merged", baseline), "modified");
  });
});

describe("statusAfterLocalSave", () => {
  it("marks clean checkouts as modified when local diverges", () => {
    assert.equal(statusAfterLocalSave("checked-out", true), "modified");
    assert.equal(statusAfterLocalSave("in-sync", true), "modified");
    assert.equal(statusAfterLocalSave("merged", true), "modified");
  });

  it("escalates remote-changed to conflict when local diverges", () => {
    assert.equal(statusAfterLocalSave("remote-changed", true), "conflict");
  });

  it("reverts when local edits are undone", () => {
    assert.equal(statusAfterLocalSave("modified", false), "in-sync");
    assert.equal(statusAfterLocalSave("conflict", false), "remote-changed");
    assert.equal(statusAfterLocalSave("checked-out", false), "checked-out");
  });
});

describe("statusAfterUpload", () => {
  it("is merged when the IBM i stored exactly the local content", () => {
    assert.deepEqual(statusAfterUpload("same", "same"), {
      baseline: "same",
      status: "merged",
      altered: false,
    });
  });

  it("uses the stored remote content as the baseline when the IBM i altered it", () => {
    const after = statusAfterUpload("local", "truncated");
    assert.deepEqual(after, { baseline: "truncated", status: "modified", altered: true });
    // The next refresh must not report a false remote change.
    assert.equal(classifyStatus("local", "truncated", after.baseline), "modified");
  });
});
