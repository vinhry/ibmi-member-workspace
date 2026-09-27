import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertNoLinkBelow } from "../localPath";

/** A checkout folder and a folder outside it, removed afterwards. */
function folders(): { root: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-links-"));
  const root = join(base, "checkouts");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A directory link; a junction on Windows, which needs no special rights. */
function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("assertNoLinkBelow", () => {
  it("accepts a member path, including parts not created yet", () => {
    const { root, cleanup } = folders();
    try {
      mkdirSync(join(root, "PUB400", "MYLIB"), { recursive: true });
      assert.doesNotThrow(() => assertNoLinkBelow(root, join(root, "PUB400", "MYLIB", "QRPGLESRC", "PAYROLL.RPGLE")));
    } finally {
      cleanup();
    }
  });

  it("refuses a linked folder that leads outside the checkout folder", () => {
    const { root, outside, cleanup } = folders();
    try {
      mkdirSync(join(root, "PUB400"));
      linkDirectory(outside, join(root, "PUB400", "MYLIB"));
      assert.throws(
        () => assertNoLinkBelow(root, join(root, "PUB400", "MYLIB", "QRPGLESRC", "PAYROLL.RPGLE")),
        /is a link/
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a member file that is a link", (t) => {
    const { root, outside, cleanup } = folders();
    try {
      const secret = join(outside, "id_ed25519");
      writeFileSync(secret, "secret\n");
      mkdirSync(join(root, "PUB400", "MYLIB", "QRPGLESRC"), { recursive: true });
      const member = join(root, "PUB400", "MYLIB", "QRPGLESRC", "PAYROLL.RPGLE");
      try {
        symlinkSync(secret, member, "file");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("creating file links needs Developer Mode on Windows");
          return;
        }
        throw err;
      }
      assert.throws(() => assertNoLinkBelow(root, member), /is a link/);
    } finally {
      cleanup();
    }
  });

  it("allows the checkout folder itself to be a link", () => {
    const { root, outside, cleanup } = folders();
    try {
      const linkedRoot = join(outside, "..", "linked-checkouts");
      linkDirectory(root, linkedRoot);
      assert.doesNotThrow(() => assertNoLinkBelow(linkedRoot, join(linkedRoot, "PUB400", "MYLIB", "QRPGLESRC", "X.RPGLE")));
    } finally {
      cleanup();
    }
  });

  it("refuses paths outside the checkout folder, and the folder itself", () => {
    const { root, outside, cleanup } = folders();
    try {
      assert.throws(() => assertNoLinkBelow(root, join(outside, "X.RPGLE")), /outside/);
      assert.throws(() => assertNoLinkBelow(root, join(root, "..", "X.RPGLE")), /outside/);
      assert.throws(() => assertNoLinkBelow(root, join(root, "PUB400", "..", "..", "X.RPGLE")), /outside/);
      assert.throws(() => assertNoLinkBelow(root, root), /outside/);
    } finally {
      cleanup();
    }
  });
});
