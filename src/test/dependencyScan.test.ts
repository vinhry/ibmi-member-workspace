import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RawReference, scanReferences } from "../dependencyScan";

/** The parts of a reference that matter to resolution. */
function brief(refs: RawReference[]) {
  return refs.map(({ kind, library, sourceFile, member, unresolvable }) =>
    [kind, library ?? "", sourceFile ?? "", member, unresolvable ?? ""].join("|")
  );
}

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

  it("skips dynamic calls, CALLPRC, comments, and quoted text", () => {
    const source = [
      "  CALL PGM(&PGMNAME)",
      "  CALL &PGM",
      "  CALLPRC PRC(MYPROC)",
      "  /* CALL PGM(OLDPGM) */",
      "  SNDPGMMSG MSG('CALL failed')",
    ].join("\n");
    assert.deepEqual(scanReferences(source, "clp"), []);
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

describe("scanReferences: other types", () => {
  it("finds nothing in source types it does not scan", () => {
    assert.deepEqual(scanReferences("CALL PGM(X)\n/COPY A", "txt"), []);
  });
});
