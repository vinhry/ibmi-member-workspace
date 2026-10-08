import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RawReference, scanDefinedProcedures, scanReferences } from "../dependencyScan";

/** The parts of a reference that matter to resolution. */
function brief(refs: RawReference[]) {
  return refs.map(({ kind, library, sourceFile, member, unresolvable }) =>
    [kind, library ?? "", sourceFile ?? "", member, unresolvable ?? ""].join("|")
  );
}

/** A fixed-format COBOL line: sequence number, indicator, code in columns 8-72, identification area. */
function cbl(code: string, indicator = " ", ident = "CHG0001"): string {
  return `000100${indicator}${code.padEnd(65).slice(0, 65)}${ident}`;
}

describe("scanReferences: COBOL", () => {
  it("reads every COPY form, with OF or IN", () => {
    const source = [
      cbl("       WORKING-STORAGE SECTION."),
      cbl("       COPY DATEUTIL."),
      cbl("       COPY PROTOS OF QCPYSRC."),
      cbl("       COPY ERRDS IN QCPYSRC IN MYLIB."),
      cbl("       COPY CONSTS OF MYLIB/QCBLLESRC."),
      cbl("       COPY \"QUOTED\"."),
    ].join("\n");
    const refs = scanReferences(source, "cblle");
    assert.deepEqual(brief(refs), [
      "copybook|||DATEUTIL|",
      "copybook||QCPYSRC|PROTOS|",
      "copybook|MYLIB|QCPYSRC|ERRDS|",
      "copybook|MYLIB|QCBLLESRC|CONSTS|",
      "copybook|||QUOTED|",
    ]);
    assert.deepEqual(refs.map((ref) => ref.defaultSourceFile), ["QCBLLESRC", undefined, undefined, undefined, "QCBLLESRC"]);
    assert.deepEqual(refs.map((ref) => ref.line), [2, 3, 4, 5, 6]);
  });

  it("reads a COPY statement split over lines, and REPLACING doesn't hide it", () => {
    const source = [
      cbl("       COPY PROTOS"),
      cbl("            OF QCPYSRC"),
      cbl("            REPLACING ==:PFX:== BY ==WS==."),
      cbl("       COPY ERRDS SUPPRESS."),
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlcblle")), [
      "copybook||QCPYSRC|PROTOS|",
      "copybook|||ERRDS|",
    ]);
  });

  it("ignores comments, literals, data names and the identification area", () => {
    const source = [
      cbl("       COPY OLDCOPY.", "*"),
      cbl("       COPY PAGED.", "/"),
      cbl("           DISPLAY 'COPY FAILED'."),
      cbl("           MOVE 1 TO WS-COPY-COUNT."),
      cbl("           ADD 1 TO COPY-TOTAL. *> COPY NOTME."),
      cbl("           MOVE A TO B.", " ", "COPY X"),
    ].join("\n");
    assert.deepEqual(scanReferences(source, "cblle"), []);
  });

  it("reads COPY DDS as a reference to the file whose formats it copies", () => {
    const source = [
      cbl("       COPY DDS-ALL-FORMATS OF CUSTMAST."),
      cbl("       COPY DDS-ORDREC-I OF MYLIB-ORDHDR."),
      cbl("       COPY DDSR-ALL-FORMATS OF PRODLIB/ITEMS."),
      cbl("       COPY DD-DSPREC OF ORDDSP IN APPLIB."),
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "cblle")), [
      "file|||CUSTMAST|",
      "file|MYLIB||ORDHDR|",
      "file|PRODLIB||ITEMS|",
      "file|APPLIB||ORDDSP|",
    ]);
  });

  it("records a quoted IFS path as unresolvable", () => {
    const source = cbl("       COPY '/home/dev/copy/dates.cpy'.");
    assert.deepEqual(brief(scanReferences(source, "cblle")), ["copybook|||/home/dev/copy/dates.cpy|IFS path"]);
  });

  it("reads embedded SQL: INCLUDE as a copybook, tables and CALLs", () => {
    const source = [
      cbl("           EXEC SQL INCLUDE SQLCA END-EXEC."),
      cbl("           EXEC SQL INCLUDE ORDSQL END-EXEC."),
      cbl("           EXEC SQL"),
      cbl("             SELECT NAME INTO :WS-NAME"),
      cbl("               FROM MYLIB.CUSTOMER C JOIN ORDERS O"),
      cbl("               ON C.ID = O.CUSTID"),
      cbl("           END-EXEC."),
      cbl("           EXEC SQL CALL PRCLIB.RECALC END-EXEC."),
    ].join("\n");
    const refs = scanReferences(source, "sqlcblle");
    assert.deepEqual(brief(refs), [
      "copybook|||ORDSQL|",
      "table|MYLIB||CUSTOMER|",
      "table|||ORDERS|",
      "procedure|PRCLIB||RECALC|",
    ]);
    assert.equal(refs[0].defaultSourceFile, "QCBLLESRC");
    assert.equal(refs[1].line, 3);
  });
});

describe("scanReferences: RPG", () => {
  it("reads every /COPY form in fixed-form source", () => {
    const source = [
      "     H DFTACTGRP(*NO)",
      "      /COPY QCPYSRC,DATEUTIL",
      "      /COPY MYLIB/QCPYSRC,PROTOS",
      "      /INCLUDE ERRDS",
      "      /COPY *LIBL/QRPGLESRC,CONSTS",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), [
      "copybook||QCPYSRC|DATEUTIL|",
      "copybook|MYLIB|QCPYSRC|PROTOS|",
      "copybook|||ERRDS|",
      "copybook||QRPGLESRC|CONSTS|",
    ]);
  });

  it("reads directives in **FREE source, in any case", () => {
    const source = ["**free", "/copy qcpysrc,dateutil", "  /include protos", "dcl-s x int(10);"].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "copybook||QCPYSRC|DATEUTIL|",
      "copybook|||PROTOS|",
    ]);
  });

  it("ignores comment lines", () => {
    const source = [
      "     A*   /COPY QCPYSRC,OLD",
      "      *   /COPY QCPYSRC,OLDER",
      "       // /COPY QCPYSRC,OLDEST",
      "      /COPY QCPYSRC,CURRENT",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["copybook||QCPYSRC|CURRENT|"]);
  });

  it("records IFS paths as unresolvable", () => {
    const source = [
      "**FREE",
      "/COPY '/home/dev/src/utils.rpgleinc'",
      "/INCLUDE /home/dev/src/other.rpgleinc",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), [
      "copybook|||/home/dev/src/utils.rpgleinc|IFS path",
      "copybook|||/home/dev/src/other.rpgleinc|IFS path",
    ]);
  });

  it("reads EXEC SQL INCLUDE, skipping SQLCA and SQLDA", () => {
    const source = [
      "**FREE",
      "exec sql include sqlca;",
      "EXEC SQL INCLUDE CUSTDS;",
      "     C/EXEC SQL INCLUDE ORDDS",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "copybook|||CUSTDS|",
      "copybook|||ORDDS|",
    ]);
  });

  it("lists each copybook once, at its first line", () => {
    const refs = scanReferences(["      /COPY QCPYSRC,A", "      /COPY QCPYSRC,A"].join("\n"), "rpgle");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].line, 1);
    assert.equal(refs[0].text, "/COPY QCPYSRC,A");
  });
});

describe("scanReferences: RPG file declarations", () => {
  /** A fixed-form F-spec with the name in columns 7-16 and external (E) or program (F) description in column 22. */
  function fspec(name: string, described: "E" | "F", keywords = ""): string {
    return `     F${name.padEnd(10)}IF   ${described}           K DISK    ${keywords}`;
  }

  it("reads externally described F-specs and skips program-described ones", () => {
    const source = [
      fspec("CUSTMAST", "E"),
      fspec("PRINTOUT", "F"),
      "     F*ORDHDR   IF   E           K DISK",
      fspec("ORDHDR", "E"),
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["file|||CUSTMAST|", "file|||ORDHDR|"]);
  });

  it("uses EXTDESC, also on a continuation line, and ignores EXTFILE", () => {
    const source = [
      fspec("CUST", "E", "EXTDESC('PRODLIB/CUSTMAST')"),
      fspec("ORD", "E"),
      "     F                                     EXTFILE('RUNLIB/ORDX') EXTDESC('ORDHDRP')",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["file|PRODLIB||CUSTMAST|", "file|||ORDHDRP|"]);
  });

  it("reads dcl-f, skipping program-described files and LIKEFILE", () => {
    const source = [
      "**FREE",
      "dcl-f custmast keyed;",
      "dcl-f report printer(132);",
      "dcl-f screen workstn;",
      "dcl-f ordhdr disk(*ext) usage(*input) extdesc('PRODLIB/ORDHDRP')",
      "     extfile(*extdesc);",
      "dcl-f custcopy likefile(custmast);",
      "dcl-f flat disk(100);",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "file|||CUSTMAST|",
      "file|||SCREEN|",
      "file|PRODLIB||ORDHDRP|",
    ]);
  });

  it("reads EXTNAME data structures in free and fixed form, once per file", () => {
    const source = [
      "     D CUST          E DS                  EXTNAME(CUSTMAST)",
      "       dcl-ds cust2 extname('CUSTMAST' : *all) end-ds;",
      "       dcl-ds ord extname('PRODLIB/ORDDTL') qualified end-ds;",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["file|||CUSTMAST|", "file|PRODLIB||ORDDTL|"]);
  });
});

/**
 * A fixed-form D- or P-spec: the name in columns 7-21, the type (PR, or B/E for a procedure)
 * from column 24, and keywords from column 44. A name starting with "*" makes a comment line.
 */
function spec(form: "D" | "P", name: string, type: string, keywords: string): string {
  return `     ${form}${name.padEnd(15)}  ${type.padEnd(2)}${" ".repeat(18)}${keywords}`;
}

describe("scanReferences: RPG prototypes", () => {
  it("reads EXTPGM as a called program and EXTPROC as a bound procedure", () => {
    const source = [
      "**FREE",
      "dcl-pr qcmdexc extpgm('QCMDEXC');",
      "  cmd char(3000) const;",
      "end-pr;",
      "dcl-pr getCust extproc('CUST_get');",
      "dcl-pr ordTotal extproc(*dclcase);",
      "dcl-pr ORDENT extpgm;",
      "dcl-pr dateUtil;",
      "dcl-pr strlen extproc(*cwiden : 'strlen');",
      "dcl-pr dynamic extpgm(pgmName);",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "program|||QCMDEXC|",
      "procedure|||CUST_get|",
      "procedure|||ordTotal|",
      "program|||ORDENT|",
      "procedure|||DATEUTIL|",
      "procedure|||strlen|",
    ]);
  });

  it("reads fixed-form PR specs, with long names and keyword continuation lines", () => {
    const source = [
      spec("D", "Cmd", "PR", "ExtPgm('QCMDEXC')"),
      spec("D", "command", "", "const"),
      "     DgetCustomerName...",
      spec("D", "", "PR", ""),
      spec("D", "", "", "ExtProc('CUST_name')"),
      spec("D", "*Old", "PR", "ExtPgm('OLDPGM')"),
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), [
      "program|||QCMDEXC|",
      "procedure|||CUST_name|",
    ]);
  });

  it("leaves out prototypes of procedures the member defines", () => {
    const source = [
      "**FREE",
      "dcl-pr localProc;",
      "end-pr;",
      "dcl-pr external extproc('EXT');",
      "dcl-proc localProc;",
      "end-proc;",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["procedure|||EXT|"]);
  });
});

describe("scanDefinedProcedures", () => {
  it("lists free and fixed-form procedures with their EXPORT flag", () => {
    const source = [
      spec("P", "getName", "B", "Export"),
      spec("P", "getName", "E", ""),
      "     PveryLongProcedureName...",
      spec("P", "", "B", ""),
      spec("P", "", "E", ""),
      "       dcl-proc calcTotal export;",
      "       end-proc;",
      "       dcl-proc helper;",
      "       end-proc;",
    ].join("\n");
    assert.deepEqual(scanDefinedProcedures(source, "rpgle"), [
      { name: "GETNAME", exported: true, line: 1 },
      { name: "VERYLONGPROCEDURENAME", exported: false, line: 4 },
      { name: "CALCTOTAL", exported: true, line: 6 },
      { name: "HELPER", exported: false, line: 8 },
    ]);
  });

  it("finds nothing in other source types", () => {
    assert.deepEqual(scanDefinedProcedures("dcl-proc x;", "clle"), []);
  });
});

describe("scanReferences: embedded SQL", () => {
  it("reads the tables a free-form statement uses, over several lines", () => {
    const source = [
      "**FREE",
      "exec sql select c.name, o.total into :name, :total",
      "  from prodlib.custmast c",
      "  join orders o on o.cust = c.cust -- comment with FROM x",
      "  where c.cust = :cust;",
      "exec sql insert into audit_log values(:msg);",
      "exec sql update prodlib/ordhdr set status = 'FROM Y' where id = :id;",
      "exec sql delete from session.work;",
      "exec sql call prodlib.post_order(:id);",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "table|PRODLIB||CUSTMAST|",
      "table|||ORDERS|",
      "table|||AUDIT_LOG|",
      "table|PRODLIB||ORDHDR|",
      "procedure|PRODLIB||POST_ORDER|",
    ]);
  });

  it("reads comma-separated FROM lists and skips CTE names and table functions", () => {
    const source = [
      "**FREE",
      "exec sql declare c1 cursor for",
      "  with recent (id) as (select id from orders where dt > current date - 7 days),",
      "       big as (select id from recent)",
      "  select * from big, custmast as c, itemmast i, table(qsys2.object_statistics('X', '*PGM')) x",
      "  for read only;",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), [
      "table|||ORDERS|",
      "table|||CUSTMAST|",
      "table|||ITEMMAST|",
    ]);
  });

  it("reads fixed-form C/EXEC SQL blocks and skips INCLUDE", () => {
    const source = [
      "     C/EXEC SQL",
      "     C+ SELECT COUNT(*) INTO :CNT",
      "     C*  FROM COMMENTED",
      "     C+   FROM ORDDTL",
      "     C/END-EXEC",
      "     C/EXEC SQL INCLUDE SQLCA",
      "     C/END-EXEC",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "sqlrpgle")), ["table|||ORDDTL|"]);
  });

  it("scans statements full of ', name (' quickly", () => {
    const statement = ["exec sql select 1 from t", ...Array(199).fill(",a(".repeat(26))];
    const source = ["**FREE", ...Array(100).fill(statement).flat()].join("\n");
    const started = Date.now();
    scanReferences(source, "sqlrpgle");
    assert.ok(Date.now() - started < 2000);
  });

  it("scans a long run of unterminated statements quickly", () => {
    const started = Date.now();
    scanReferences(["**FREE", ...Array(50000).fill("exec sql select a from t,")].join("\n"), "sqlrpgle");
    assert.ok(Date.now() - started < 2000);
  });
});

describe("scanReferences: CL", () => {
  it("takes the program name, never the library", () => {
    const source = [
      "PGM",
      "  CALL PGM(PRODLIB/ORD001)",
      "  CALL PGM(ORD002) PARM(&A)",
      "  CALL ORD003",
      "  CALL *LIBL/ORD004",
      "  TFRCTL PGM(ORD005)",
      "ENDPGM",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "clle")), [
      "program|PRODLIB||ORD001|",
      "program|||ORD002|",
      "program|||ORD003|",
      "program|||ORD004|",
      "program|||ORD005|",
    ]);
  });

  it("skips dynamic calls, comments, and quoted text", () => {
    const source = [
      "  CALL PGM(&PGMNAME)",
      "  CALL &PGM",
      "  CALLPRC PRC(&PROC)",
      "  /* CALL PGM(OLDPGM) */",
      "  SNDPGMMSG MSG('CALL failed')",
    ].join("\n");
    assert.deepEqual(scanReferences(source, "clp"), []);
  });

  it("reads CALLPRC as a bound procedure, keeping a quoted name's case", () => {
    const source = [
      "  CALLPRC PRC(MYPROC)",
      "  CALLPRC PRC('getCustomer') PARM(&CUST)",
      "  CALLPRC 'Other'",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "clle")), [
      "procedure|||MYPROC|",
      "procedure|||getCustomer|",
      "procedure|||Other|",
    ]);
  });

  it("follows continuation lines and calls inside SBMJOB", () => {
    const source = [
      "  SBMJOB CMD(CALL PGM(NIGHTLY)) +",
      "         JOB(NIGHT)",
      "  CALL PGM(MYLIB/+",
      "           SPLIT)",
    ].join("\n");
    const refs = scanReferences(source, "clle");
    assert.deepEqual(brief(refs), ["program|||NIGHTLY|", "program|MYLIB||SPLIT|"]);
    assert.deepEqual(refs.map((ref) => ref.line), [1, 3]);
  });
});

describe("scanReferences: CL files, scripts and quoted commands", () => {
  it("declares files with DCLF, positional or FILE(), skipping variables", () => {
    const source = [
      "  DCLF FILE(PRODLIB/CUSTMAST)",
      "  DCLF ORDHDR OPNID(HDR)",
      "  DCLF FILE(*LIBL/ORDDTL)",
      "  DCLF FILE(&FILE)",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "clle")), [
      "file|PRODLIB||CUSTMAST|",
      "file|||ORDHDR|",
      "file|||ORDDTL|",
    ]);
  });

  it("finds the SQL script RUNSQLSTM runs, as a member with its source file", () => {
    const source = [
      "  RUNSQLSTM SRCFILE(PRODLIB/QSQLSRC) SRCMBR(CRTTABLES) COMMIT(*NONE)",
      "  RUNSQLSTM SRCMBR(nightly) SRCFILE(QSQLSRC)",
      "  RUNSQLSTM SRCFILE(QSQLSRC) SRCMBR(&MBR)",
      "  RUNSQLSTM SRCSTMF('/home/dev/x.sql')",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "clle")), [
      "copybook|PRODLIB|QSQLSRC|CRTTABLES|",
      "copybook||QSQLSRC|NIGHTLY|",
    ]);
  });

  it("finds calls quoted inside SBMJOB CMD and RQSDTA, but not in messages", () => {
    const source = [
      "  SBMJOB CMD('CALL PGM(PRODLIB/NIGHTLY) PARM(''X'')') JOB(NIGHT)",
      "  SBMJOB RQSDTA('CALL WEEKLY')",
      "  ADDJOBSCDE JOB(EOM) CMD('CALL PGM(MONTHEND)') FRQ(*MONTHLY)",
      "  SNDPGMMSG MSG('CALL PGM(NOTME)')",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "clle")), [
      "program|PRODLIB||NIGHTLY|",
      "program|||WEEKLY|",
      "program|||MONTHEND|",
    ]);
  });
});

describe("scanReferences: RPG fixed-form calls", () => {
  /** A fixed-form RPG IV C-spec with the operation in columns 26-35 and factor 2 from column 36. */
  const calc = (opcode: string, factor2: string) => `     C${" ".repeat(19)}${opcode.padEnd(10)}${factor2}`;

  it("reads CALL with a quoted program name, with or without a library", () => {
    const source = [calc("CALL", "'ORD200'"), calc("CALL(E)", "'MYLIB/ORD300'")].join("\n");
    assert.deepEqual(brief(scanReferences(source, "rpgle")), ["program|||ORD200|", "program|MYLIB||ORD300|"]);
  });

  it("reads CALLB as a bound procedure, keeping its case", () => {
    assert.deepEqual(brief(scanReferences(calc("CALLB", "'getCust'"), "rpgle")), ["procedure|||getCust|"]);
  });

  it("skips a CALL through a field, CALLP, and comment lines", () => {
    const source = [
      calc("CALL", "PGMNAME"),
      calc("CALLP", "'ORD400'"),
      `     C*${" ".repeat(18)}${"CALL".padEnd(10)}'OLDPGM'`,
    ].join("\n");
    assert.deepEqual(scanReferences(source, "rpgle"), []);
  });

  it("reads RPG III's columns too", () => {
    // RPG/400: operation in columns 28-32, factor 2 in 33-42.
    const source = `     C${" ".repeat(21)}CALL 'ORD500'`;
    assert.deepEqual(brief(scanReferences(source, "rpg")), ["program|||ORD500|"]);
  });
});

describe("scanReferences: DDS", () => {
  it("reads REF, REFFLD, PFILE and JFILE", () => {
    const source = [
      "     A                                      REF(PRODLIB/FLDREF)",
      "     A          R CUSTR                     PFILE(CUSTMAST)",
      "     A            CUSTNO    R               REFFLD(CUSNUM CUSTREF)",
      "     A            CUSTNM    R               REFFLD(CUSNAM)",
      "     A          R JOINR                     JFILE(ORDHDR ORDDTL)",
      "     A*                                     REF(COMMENTED)",
    ].join("\n");
    assert.deepEqual(brief(scanReferences(source, "lf")), [
      "file|PRODLIB||FLDREF|",
      "file|||CUSTMAST|",
      "file|||CUSTREF|",
      "file|||ORDHDR|",
      "file|||ORDDTL|",
    ]);
  });

  it("skips REFFLD pointing at the source being compiled", () => {
    const source = "     A            X         R               REFFLD(FLD *SRC)";
    assert.deepEqual(scanReferences(source, "dspf"), []);
  });
});

describe("scanReferences: hostile source", () => {
  // Before 1.5.2 each of these blocked the extension host for seconds to minutes.
  const LIMIT_MS = 2000;
  const time = (text: string, type: string) => {
    const started = Date.now();
    scanReferences(text, type);
    return Date.now() - started;
  };
  const ddsLine = (keywords: string) => "     A".padEnd(44) + keywords;

  it("scans a DDS line of repeated REF( quickly", () => {
    assert.ok(time(ddsLine("REF(".repeat(8000)), "pf") < LIMIT_MS);
  });

  it("scans a DDS REF( with a long unterminated name quickly", () => {
    assert.ok(time(ddsLine(`REF(${"A".repeat(32000)}`), "pf") < LIMIT_MS);
    assert.ok(time(ddsLine(`REF(A ${"B ".repeat(16000)}`), "pf") < LIMIT_MS);
  });

  it("scans a DDS line of repeated PFILE( quickly", () => {
    assert.ok(time(ddsLine("PFILE(A ".repeat(4000)), "lf") < LIMIT_MS);
  });

  it("joins a long run of CL continuation lines quickly", () => {
    assert.ok(time(Array(300000).fill("a+").join("\n"), "clle") < LIMIT_MS);
  });

  it("still reads REF with a record format after the file name", () => {
    assert.deepEqual(brief(scanReferences(ddsLine("REF(PRODLIB/FLDREF FLDREFR)"), "pf")), ["file|PRODLIB||FLDREF|"]);
  });
});

describe("scanReferences: other types", () => {
  it("finds nothing in source types it does not scan", () => {
    assert.deepEqual(scanReferences("CALL PGM(X)\n/COPY A", "txt"), []);
  });
});
