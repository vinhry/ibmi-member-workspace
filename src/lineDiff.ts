import { canonicalMemberText } from "./sync";

/**
 * A line-by-line comparison of two source texts as a unified diff, for the research tools to show
 * an agent how a checkout differs from the IBM i. Myers' O(ND) algorithm with the common beginning
 * and end trimmed first; beyond `maxEdits` differing lines the middle is shown as one replacement
 * instead. Kept free of the `vscode` module, and of any dependency, so it can be unit tested.
 */

export interface DiffOptions {
  /** Labels of the two texts in the `---`/`+++` header, e.g. "local" and "IBM i". */
  aLabel?: string;
  bLabel?: string;
  /** Unchanged lines shown around each change. */
  context?: number;
  /** Differing lines beyond which the middle is reported as one replacement, with `truncated` set. */
  maxEdits?: number;
}

export interface LineDiff {
  identical: boolean;
  /** Lines only in the second text. */
  added: number;
  /** Lines only in the first text. */
  removed: number;
  /** The unified diff, empty when identical. */
  text: string;
  truncated: boolean;
}

type Op = { kind: "=" | "-" | "+"; line: string };

/** The unified diff of `a` and `b`, compared as the IBM i stores them (no BOM, CRLF or trailing blanks). */
export function unifiedDiff(a: string, b: string, options: DiffOptions = {}): LineDiff {
  const { aLabel = "a", bLabel = "b", context = 3, maxEdits = 2000 } = options;
  const aLines = splitLines(canonicalMemberText(a));
  const bLines = splitLines(canonicalMemberText(b));

  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aMiddle = aLines.slice(prefix, aLines.length - suffix);
  const bMiddle = bLines.slice(prefix, bLines.length - suffix);
  if (aMiddle.length === 0 && bMiddle.length === 0) {
    return { identical: true, added: 0, removed: 0, text: "", truncated: false };
  }

  const middle = myers(aMiddle, bMiddle, maxEdits);
  const truncated = middle === undefined;
  const middleOps: Op[] = middle ?? [
    ...aMiddle.map((line): Op => ({ kind: "-", line })),
    ...bMiddle.map((line): Op => ({ kind: "+", line })),
  ];
  const ops: Op[] = [
    ...aLines.slice(0, prefix).map((line): Op => ({ kind: "=", line })),
    ...middleOps,
    ...aLines.slice(aLines.length - suffix).map((line): Op => ({ kind: "=", line })),
  ];
  const added = ops.filter((op) => op.kind === "+").length;
  const removed = ops.filter((op) => op.kind === "-").length;
  return {
    identical: false,
    added,
    removed,
    text: [`--- ${aLabel}`, `+++ ${bLabel}`, ...hunks(ops, context)].join("\n"),
    truncated,
  };
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * The edit script turning `a` into `b` (Myers, forward, with the trace kept for the backtrack), or
 * undefined when it would take more than `maxEdits` edits.
 */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  for (let d = 0; d <= max; d++) {
    const current = new Int32Array(v);
    trace.push(current);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(a, b, trace, d, offset);
      }
    }
    v = new Int32Array(v);
  }
  return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[], dFinal: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "=", line: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ kind: "+", line: b[y - 1] });
      y--;
    } else {
      ops.push({ kind: "-", line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "=", line: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

/** The ops as unified-diff hunks, each change with `context` unchanged lines around it. */
function hunks(ops: readonly Op[], context: number): string[] {
  const changed = ops.map((op) => op.kind !== "=");
  const lines: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    // A hunk runs from `context` lines before this change to `context` lines after the last change
    // that is within 2 * context of the previous one.
    const start = Math.max(0, i - context);
    let end = i;
    let last = i;
    while (end < ops.length) {
      if (changed[end]) {
        last = end;
      } else if (end - last > 2 * context) {
        break;
      }
      end++;
    }
    end = Math.min(ops.length, last + context + 1);
    let aLine = 1;
    let bLine = 1;
    for (let j = 0; j < start; j++) {
      if (ops[j].kind !== "+") {
        aLine++;
      }
      if (ops[j].kind !== "-") {
        bLine++;
      }
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${range(aLine, aCount)} +${range(bLine, bCount)} @@`);
    for (const op of slice) {
      lines.push(`${op.kind === "=" ? " " : op.kind}${op.line}`);
    }
    i = end;
  }
  return lines;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${count === 0 ? start - 1 : start},${count}`;
}
