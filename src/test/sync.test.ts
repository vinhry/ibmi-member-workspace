import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, hashContent } from "../sync";

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
