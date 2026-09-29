import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Throws unless `target` is below `root` without passing through a symbolic link or junction, so a
 * link planted in the checkout folder (for example by a cloned or shared folder) can't redirect a
 * member's write, upload or delete to a file outside it. `root` itself may be a link, and parts of
 * `target` that don't exist yet are fine: they are about to be created.
 */
export function assertNoLinkBelow(root: string, target: string): void {
  const base = path.resolve(root);
  const relative = path.relative(base, path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${target} is outside the checkout folder.`);
  }
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${current} is a link, and checkouts never follow links inside the checkout folder.`);
    }
  }
}

/**
 * Reads a checkout's text without following a link below the checkout folder (see
 * {@link assertNoLinkBelow}), so a link planted at a checkout path can't hand its target's text
 * to Find Dependencies or Bob's research tools.
 */
export function readCheckoutText(root: string | undefined, localPath: string): string {
  if (!root) {
    throw new Error("No checkout folder is set for this workspace.");
  }
  assertNoLinkBelow(root, localPath);
  return fs.readFileSync(localPath, "utf-8");
}
