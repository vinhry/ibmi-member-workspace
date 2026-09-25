import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMemberText,
  classifyStatus,
  hashContent,
  legacyHashContent,
  migrateLegacyBaseline,
  nextBaseline,
  normalizeForMemberUpload,
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
    assert.equal(hashContent("A\r\nB\r\n"), hashContent("A\nB\n"));
  });

  it("ignores a leading BOM", () => {
    assert.equal(hashContent("\uFEFFA\nB\n"), hashContent("A\nB\n"));
  });

  it("ignores trailing blank lines", () => {
    assert.equal(hashContent("A\nB\n\n\n"), hashContent("A\nB"));
    assert.equal(hashContent("A\nB\n  \n\t\n"), hashContent("A\nB"));
  });

  it("ignores trailing blanks on every line, regardless of editor settings", () => {
    assert.equal(hashContent("A  \nB\t\n"), hashContent("A\nB\n"));
  });

  it("keeps leading and embedded blank lines significant", () => {
    assert.notEqual(hashContent("\nA\nB"), hashContent("A\nB"));
    assert.notEqual(hashContent("A\n\nB"), hashContent("A\nB"));
  });

  it("keeps leading blanks significant", () => {
    assert.notEqual(hashContent("  A\nB"), hashContent("A\nB"));
  });

  it("hashes exactly the text that is uploaded", () => {
    const local = "\uFEFFA  \r\n\r\n  B\r\n\r\n";
    assert.equal(normalizeForMemberUpload(local), canonicalMemberText(local));
    assert.equal(hashContent(local), hashContent(normalizeForMemberUpload(local)));
  });
});

describe("migrateLegacyBaseline", () => {
  const base = "A  \nB\n";

  it("converts a baseline stored with trimTrailingWhitespace off", () => {
    assert.equal(migrateLegacyBaseline(legacyHashContent(base, false), [base]), hashContent(base));
  });

  it("converts a baseline stored with trimTrailingWhitespace on", () => {
    assert.equal(migrateLegacyBaseline(legacyHashContent(base, true), [base]), hashContent(base));
  });

  it("converts a baseline whose content had a BOM", () => {
    const withBom = "\uFEFFA\nB\n";
    assert.equal(migrateLegacyBaseline(legacyHashContent(withBom, false), [withBom]), hashContent(withBom));
  });

  it("uses whichever candidate is unchanged since checkout", () => {
    const baseline = legacyHashContent(base, false);
    assert.equal(migrateLegacyBaseline(baseline, ["changed remotely", base]), hashContent(base));
  });

  it("is undefined when every candidate changed since checkout", () => {
    assert.equal(migrateLegacyBaseline(legacyHashContent(base, false), ["X", "Y"]), undefined);
  });

  it("keeps an unchanged member in sync after the upgrade", () => {
    const local = "\uFEFFA  \r\nB\r\n";
    const remote = "A\nB\n";
    const baseline = migrateLegacyBaseline(legacyHashContent(remote, false), [remote, local]);
    assert.ok(baseline);
    assert.equal(classifyStatus(hashContent(local), hashContent(remote), baseline), "in-sync");
  });

  it("lets a local-only edit show as modified after the upgrade", () => {
    const remote = "A\nB\n";
    const baseline = migrateLegacyBaseline(legacyHashContent(remote, false), [remote, "A\nC\n"]);
    assert.ok(baseline);
    assert.equal(classifyStatus(hashContent("A\nC\n"), hashContent(remote), baseline), "modified");
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

describe("normalizeForMemberUpload", () => {
  it("converts CRLF endings to LF", () => {
    assert.equal(normalizeForMemberUpload("A\r\nB\r\nC"), "A\nB\nC");
  });

  it("removes one trailing newline", () => {
    assert.equal(normalizeForMemberUpload("A\nB\n"), "A\nB");
    assert.equal(normalizeForMemberUpload("A\r\nB\r\n"), "A\nB");
  });

  it("removes every trailing blank line", () => {
    assert.equal(normalizeForMemberUpload("A\nB\n\n\n"), "A\nB");
    assert.equal(normalizeForMemberUpload("A\r\nB\r\n\r\n"), "A\nB");
  });

  it("removes trailing whitespace-only lines", () => {
    assert.equal(normalizeForMemberUpload("A\nB\n   \n\t\n"), "A\nB");
  });

  it("keeps leading and embedded blank lines", () => {
    assert.equal(normalizeForMemberUpload("\nA\n\nB\n"), "\nA\n\nB");
  });

  it("strips a leading BOM", () => {
    assert.equal(normalizeForMemberUpload("\uFEFFA\nB\n"), "A\nB");
  });

  it("leaves content without a trailing newline unchanged", () => {
    assert.equal(normalizeForMemberUpload("A\n\nB"), "A\n\nB");
    assert.equal(normalizeForMemberUpload(""), "");
  });
});
