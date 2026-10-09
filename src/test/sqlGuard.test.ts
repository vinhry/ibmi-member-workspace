import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_QUERY_LENGTH, blankSql, guardReadOnlyQuery } from "../sqlGuard";

describe("blankSql", () => {
  it("removes comments and the contents of string literals", () => {
    assert.equal(blankSql("select a -- delete me\n, 'it''s; a delete' /* drop */ from t"), "SELECT A \n, ''   FROM T");
    assert.equal(blankSql("select 'x' from t"), "SELECT '' FROM T");
    assert.equal(blankSql("select 1 /* multi\nline */ from t"), "SELECT 1   FROM T");
    assert.equal(blankSql("select 'unterminated"), "SELECT ''");
    assert.equal(blankSql("select 1 /* open"), "SELECT 1 /*");
  });
});

describe("guardReadOnlyQuery", () => {
  const ok = (sql: string) => {
    const result = guardReadOnlyQuery(sql, 50);
    assert.ok(result.ok, `${sql}: ${result.ok ? "" : result.reason}`);
    return result.ok ? result.sql : "";
  };
  const refused = (sql: string, reason: RegExp) => {
    const result = guardReadOnlyQuery(sql, 50);
    assert.ok(!result.ok, `${sql} should be refused`);
    if (!result.ok) {
      assert.match(result.reason, reason);
    }
  };

  it("wraps a SELECT, WITH or VALUES with a row limit, allowing a trailing semicolon", () => {
    assert.equal(ok("select * from mylib.custmast;"), "SELECT * FROM (select * from mylib.custmast) AS IMW_QUERY FETCH FIRST 50 ROWS ONLY");
    ok("WITH c AS (SELECT 1 AS n FROM sysibm.sysdummy1) SELECT n FROM c ORDER BY n FETCH FIRST 5 ROWS ONLY");
    ok("values current timestamp");
    ok("  -- a comment first\nselect count(*) from q where status = 'DELETED'");
  });

  it("ignores forbidden words inside comments and literals", () => {
    ok("select 'INSERT INTO x' as note, 1 from sysibm.sysdummy1 -- delete");
  });

  it("refuses anything that isn't a single query", () => {
    refused("", /empty/);
    refused("insert into t values (1)", /SELECT, WITH or VALUES/);
    refused("select 1 from t; drop table t", /one statement/);
    refused("select * from final table (insert into t values (1))", /INSERT/);
    refused("select * from new table (update t set a = 1)", /UPDATE|SET/);
    refused("select qsys2.qcmdexc('DLTLIB X') from sysibm.sysdummy1", /QCMDEXC/);
    refused("select * from table(qsys2.http_get('http://x')) x", /HTTP_GET/);
    refused("select * from table(systools.httpgetclob('http://x', '')) x", /HTTPGETCLOB/);
    refused("call qsys2.qcmdexc('x')", /SELECT, WITH or VALUES/);
    refused("select 1 into :v from t", /INTO/);
    refused("select 1 /* open comment", /comment/);
    refused(`select '${"x".repeat(MAX_QUERY_LENGTH)}' from t`, /longer than/);
  });

  it("clamps the row limit to a whole number of at least one", () => {
    const result = guardReadOnlyQuery("select 1 from t", 0.4);
    assert.ok(result.ok && result.sql.endsWith("FETCH FIRST 1 ROWS ONLY"));
  });
});
