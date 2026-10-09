/**
 * Keeps the `run_sql_query` research tool to reading: one SELECT (or WITH, or VALUES), no
 * statement that changes data or objects, runs a command or reaches out of the system. Kept free
 * of the `vscode` module so it can be unit tested. User-defined functions can do anything their
 * author wrote, so this is a guard against mistakes and the obvious, not a sandbox: the tool is
 * also behind the user's data-samples setting.
 */

export type GuardedQuery = { ok: true; sql: string } | { ok: false; reason: string };

/** Statements and clauses that change something, or that run something. */
const FORBIDDEN_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
  "CREATE", "ALTER", "DROP", "RENAME", "LABEL", "COMMENT", "GRANT", "REVOKE", "TRANSFER", "REFRESH",
  "CALL", "EXECUTE", "PREPARE", "DECLARE", "SET", "LOCK", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
  "CONNECT", "DISCONNECT", "BEGIN", "END", "INTO",
  // Scalar functions with side effects: a command, or a request to another system.
  "QCMDEXC", "IFS_WRITE", "IFS_WRITE_UTF8", "IFS_WRITE_BINARY", "SEND_EMAIL", "LPRINTF",
]);

/** Longest statement a tool may run: a report-sized query, not a script. */
export const MAX_QUERY_LENGTH = 10_000;

/** The statement with its comments and string literals blanked, upper-cased, for inspection only. */
export function blankSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.substring(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        // Left in, so the guard sees the comment was never closed.
        out += "/*";
        i = sql.length;
      } else {
        i = end + 2;
        out += " ";
      }
    } else if (sql[i] === "'") {
      // '' inside a literal is a quote; the loop just leaves it in the literal.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      out += "''";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out.toUpperCase();
}

/**
 * Checks a statement and returns the one to run: `sql` wrapped so it returns at most `maxRows`
 * rows. A trailing semicolon is allowed; a second statement is not.
 */
export function guardReadOnlyQuery(sql: string, maxRows: number): GuardedQuery {
  const trimmed = sql.trim().replace(/;\s*$/, "").trim();
  if (trimmed === "") {
    return { ok: false, reason: "The statement is empty." };
  }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { ok: false, reason: `The statement is longer than ${MAX_QUERY_LENGTH} characters.` };
  }
  const blanked = blankSql(trimmed);
  if (blanked.includes(";")) {
    return { ok: false, reason: "Only one statement can be run." };
  }
  if (blanked.includes("/*")) {
    return { ok: false, reason: "A comment isn't closed." };
  }
  const words = blanked.match(/[A-Z_][A-Z0-9_$#@]*/g) ?? [];
  const first = words[0];
  if (first !== "SELECT" && first !== "WITH" && first !== "VALUES") {
    return { ok: false, reason: "Only a SELECT, WITH or VALUES statement can be run." };
  }
  for (const word of words) {
    if (FORBIDDEN_WORDS.has(word)) {
      return { ok: false, reason: `${word} isn't allowed: the tool only reads.` };
    }
    if (word.startsWith("HTTP")) {
      return { ok: false, reason: `${word} isn't allowed: the tool doesn't reach other systems.` };
    }
  }
  const limit = Math.max(1, Math.floor(maxRows));
  return { ok: true, sql: `SELECT * FROM (${trimmed}) AS IMW_QUERY FETCH FIRST ${limit} ROWS ONLY` };
}
