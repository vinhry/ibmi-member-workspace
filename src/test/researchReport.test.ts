import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeUsage,
  fileDescriptionReport,
  jobLogReport,
  objectDescriptionReport,
  objectTypeForSourceType,
  serviceProgramExportsReport,
  textTable,
  whereUsedReport,
} from "../researchReport";

describe("textTable", () => {
  it("aligns columns to their widest value and cuts long values short", () => {
    const lines = textTable(["A", "Long header"], [["xx", "y"], ["x", "z".repeat(80)]]);
    assert.equal(lines[0], "A   Long header");
    assert.equal(lines[1], `--  ${"-".repeat(60)}`);
    assert.equal(lines[2], "xx  y");
    assert.equal(lines[3], `x   ${"z".repeat(59)}…`);
    assert.ok(lines.every((line) => line === line.trimEnd()));
  });

  it("copes with a missing cell and collapses line breaks in values", () => {
    assert.deepEqual(textTable(["A", "B"], [["only a"], ["multi\nline", "b"]]), ["A           B", "----------  -", "only a", "multi line  b"]);
  });
});

describe("whereUsedReport", () => {
  it("lists the programs by library, with the usage in words", () => {
    const report = whereUsedReport({
      object: "CUSTMAST", objectType: "*FILE", system: "DEV", librariesSearched: ["PRODOBJ", "DEVOBJ"], librariesLeftOut: ["OLDOBJ"],
      librariesNotRead: [{ library: "DEVOBJ", error: "not authorized" }],
      rows: [
        { library: "PRODOBJ", program: "ORD200", text: "Order update", objectLibrary: "*LIBL", objectType: "*FILE", usage: "5" },
        { library: "PRODOBJ", program: "CUSTINQ", text: "Customer inquiry", objectLibrary: "PRODDTA", objectType: "*FILE", usage: "1" },
      ],
    });
    assert.match(report, /^Where Used: CUSTMAST \(\*FILE\) on DEV\n/);
    assert.match(report, /Not searched \(over the limit\): OLDOBJ/);
    assert.match(report, /Could not read DEVOBJ: not authorized/);
    assert.match(report, /2 program\(s\) refer to it/);
    assert.ok(report.indexOf("CUSTINQ") < report.indexOf("ORD200"), "sorted by program within a library");
    assert.match(report, /ORD200 +\*LIBL\/CUSTMAST \*FILE +input, update +Order update/);
  });

  it("says when nothing refers to the object", () => {
    assert.match(whereUsedReport({ object: "X", system: "S", librariesSearched: [], rows: [] }), /No program or service program/);
  });
});

describe("describeUsage", () => {
  it("reads DSPPGMREF's usage bits", () => {
    assert.equal(describeUsage("1"), "input");
    assert.equal(describeUsage("2"), "output");
    assert.equal(describeUsage("7"), "input, output, update");
    assert.equal(describeUsage(undefined), "");
    assert.equal(describeUsage("?"), "?");
  });
});

describe("fileDescriptionReport", () => {
  it("shows the columns, with precision and scale for numbers, and what is built over the file", () => {
    const report = fileDescriptionReport({
      library: "PRODDTA", systemName: "CUSTMAST", sqlName: "CUSTOMER_MASTER", type: "P", text: "Customers",
      columns: [
        { name: "CUSTOMER_NUMBER", systemName: "CUSTNO", type: "DECIMAL", length: 7, scale: 0, nullable: false, text: "Customer" },
        { name: "BALANCE", systemName: "CUSTBAL", type: "DECIMAL", length: 11, scale: 2, nullable: true, text: "" },
      ],
      dependents: [{ library: "PRODDTA", name: "CUSTMASTL1", type: "LF" }],
      notes: ["DSPDBR could not be run."],
    }, "DEV");
    assert.match(report, /^File: PRODDTA\/CUSTMAST \(SQL name CUSTOMER_MASTER\) on DEV\nType: physical file\nText: Customers\n/);
    assert.match(report, /CUSTOMER_NUMBER +CUSTNO +DECIMAL +7 +Customer/);
    assert.match(report, /BALANCE +CUSTBAL +DECIMAL +11,2 +yes/);
    assert.match(report, /1 object\(s\) built over it:/);
    assert.match(report, /CUSTMASTL1 +LF/);
    assert.match(report, /Note: DSPDBR could not be run\./);
  });
});

describe("objectDescriptionReport", () => {
  it("lists attributes, program information and the bound modules", () => {
    const report = objectDescriptionReport({
      library: "PRODOBJ", name: "ORDENT", type: "*PGM",
      object: { attribute: "RPGLE", text: "Order entry" },
      program: { programType: "ILE", activationGroup: "QILE" },
      modules: [{ library: "PRODOBJ", name: "ORDENT" }, { library: "PRODOBJ", name: "ORDUTIL", attribute: "RPGLE" }],
      boundServicePrograms: [],
      notes: [],
    }, "DEV");
    assert.match(report, /^Program: PRODOBJ\/ORDENT on DEV\n\nattribute {2}RPGLE\ntext {7}Order entry\n/);
    assert.match(report, /Program information:\nprogramType +ILE\nactivationGroup +QILE/);
    assert.match(report, /Modules:\n\nlibrary +name +attribute\n/);
    assert.match(report, /Bound service programs: none/);
  });
});

describe("serviceProgramExportsReport and jobLogReport", () => {
  it("format their rows", () => {
    assert.match(serviceProgramExportsReport({ library: "L", name: "S", exports: [{ symbol: "CUST_get", usage: "*PROCEXP" }] }, "DEV"), /exports 1 symbol\(s\):\n\nSymbol +Usage\n[- ]+\nCUST_get +\*PROCEXP/);
    const log = jobLogReport({ job: "*", messages: [
      { position: 1, id: "CPF9898", type: "ESCAPE", severity: 40, sent: "2026-10-09 10:00:00", fromProgram: "QCMD", text: "It failed.", help: "Line one\nLine two" },
    ] }, "DEV");
    assert.match(log, /^Job log of this connection's job on DEV: 1 message\(s\), oldest first\n\n2026-10-09 10:00:00 {2}CPF9898 {2}ESCAPE {2}severity 40 {2}from QCMD\n {2}It failed\.\n {4}Line one\n {4}Line two\n/);
  });
});

describe("objectTypeForSourceType", () => {
  it("knows which source types compile to files", () => {
    assert.equal(objectTypeForSourceType("pf"), "*FILE");
    assert.equal(objectTypeForSourceType("DSPF"), "*FILE");
    assert.equal(objectTypeForSourceType("rpgle"), undefined);
  });
});
