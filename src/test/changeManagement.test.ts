import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeCheckoutDeps,
  ChangeMember,
  checkoutTemplateProblem,
  commandFailureMessages,
  releaseProblem,
  expandCheckoutCommand,
  runChangeManagementCheckout,
} from "../changeManagement";

function member(memberName: string, extension = "rpgle"): ChangeMember {
  return { library: "PRODLIB", sourceFile: "QRPGLESRC", memberName, extension };
}

const TEMPLATE = "LMICHKOUT MBR(&OPENMBR) SRCF(&OPENLIB/&OPENSPF) TYPE(&EXT) TOLIB(&DEVLIB)";

function deps(overrides: Partial<ChangeCheckoutDeps> = {}) {
  const ran: string[] = [];
  const logs: string[] = [];
  const confirmed: string[][] = [];
  const value: ChangeCheckoutDeps = {
    askDevLibrary: async () => "devlib",
    askProject: async () => "prj001234",
    askRelease: async () => "mygroup/myapp/base",
    confirm: async (commands) => {
      confirmed.push(commands);
      return true;
    },
    connectedSystem: () => "PUB400",
    currentUser: () => "devuser",
    runCommand: async (command) => {
      ran.push(command);
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps: value, ran, logs, confirmed };
}

describe("expandCheckoutCommand", () => {
  it("fills every placeholder, uppercase and unquoted", () => {
    assert.equal(
      expandCheckoutCommand(TEMPLATE, member("ord100"), "devlib"),
      "LMICHKOUT MBR(ORD100) SRCF(PRODLIB/QRPGLESRC) TYPE(RPGLE) TOLIB(DEVLIB)"
    );
  });

  it("reads placeholders in any case, and a placeholder more than once", () => {
    assert.equal(
      expandCheckoutCommand("X A(&openmbr) B(&OpenMbr) C(&ext)", member("ORD100", "sqlrpgle"), "DEVLIB"),
      "X A(ORD100) B(ORD100) C(SQLRPGLE)"
    );
  });

  it("keeps names with $, # and @", () => {
    assert.equal(
      expandCheckoutCommand("X MBR(&OPENMBR) LIB(&DEVLIB)", { ...member("$ORD#1"), library: "@LIB" }, "DEV$"),
      "X MBR($ORD#1) LIB(DEV$)"
    );
  });

  it("refuses a name that isn't an IBM i system name", () => {
    assert.throws(() => expandCheckoutCommand(TEMPLATE, member("ORD100) SRCF(X"), "DEVLIB"), /not a valid IBM i member name/);
    assert.throws(() => expandCheckoutCommand(TEMPLATE, member("ORD100"), "DEV LIB"), /not a valid IBM i library name/);
    assert.throws(() => expandCheckoutCommand(TEMPLATE, member("ORD100"), "TOOLONGLIBRARY"), /library name/);
  });

  it("refuses an unknown placeholder instead of leaving it in the command", () => {
    assert.throws(() => expandCheckoutCommand("X MBR(&MEMBER) T(&TASK)", member("ORD100"), "DEVLIB"), /&MEMBER, &TASK/);
  });
});

describe("checkoutTemplateProblem", () => {
  it("accepts a template with known placeholders or none", () => {
    assert.equal(checkoutTemplateProblem(TEMPLATE), undefined);
    assert.equal(checkoutTemplateProblem("DSPLIBL"), undefined);
  });

  it("names an empty template and unknown placeholders once each", () => {
    assert.match(checkoutTemplateProblem("  ") ?? "", /empty/);
    assert.match(checkoutTemplateProblem("X A(&LIB) B(&LIB)") ?? "", /unknown placeholders: &LIB\. Use &OPENLIB/);
  });
});

describe("runChangeManagementCheckout", () => {
  it("shows the exact commands, then runs each one and reports the development library", async () => {
    const h = deps();
    const result = await runChangeManagementCheckout([member("ORD100"), member("ORD200")], "PUB400", TEMPLATE, h.deps);
    const commands = [
      "LMICHKOUT MBR(ORD100) SRCF(PRODLIB/QRPGLESRC) TYPE(RPGLE) TOLIB(DEVLIB)",
      "LMICHKOUT MBR(ORD200) SRCF(PRODLIB/QRPGLESRC) TYPE(RPGLE) TOLIB(DEVLIB)",
    ];
    assert.deepEqual(h.confirmed, [commands]);
    assert.deepEqual(h.ran, commands);
    assert.equal(result?.devLibrary, "DEVLIB");
    assert.deepEqual(result?.succeeded.map((m) => m.memberName), ["ORD100", "ORD200"]);
    assert.deepEqual(result?.failed, []);
  });

  it("runs nothing when the development library is not given or the commands are declined", async () => {
    const noLibrary = deps({ askDevLibrary: async () => undefined });
    assert.equal(await runChangeManagementCheckout([member("ORD100")], "PUB400", TEMPLATE, noLibrary.deps), undefined);
    assert.deepEqual(noLibrary.ran, []);

    const declined = deps({ confirm: async () => false });
    assert.equal(await runChangeManagementCheckout([member("ORD100")], "PUB400", TEMPLATE, declined.deps), undefined);
    assert.deepEqual(declined.ran, []);
  });

  it("refuses a bad template before asking anything", async () => {
    let asked = false;
    const h = deps({
      askDevLibrary: async () => {
        asked = true;
        return "DEVLIB";
      },
    });
    await assert.rejects(runChangeManagementCheckout([member("ORD100")], "PUB400", "X(&NOPE)", h.deps), /&NOPE/);
    assert.equal(asked, false);
  });

  it("goes on after a failed member and reports it with the IBM i's message", async () => {
    const h = deps({
      runCommand: async (command) => {
        h.ran.push(command);
        if (command.includes("ORD200")) {
          throw new Error("LMI1234 Member is already checked out.");
        }
      },
    });
    const result = await runChangeManagementCheckout(
      [member("ORD100"), member("ORD200"), member("ORD300")],
      "PUB400",
      TEMPLATE,
      h.deps
    );
    assert.equal(h.ran.length, 3);
    assert.deepEqual(result?.succeeded.map((m) => m.memberName), ["ORD100", "ORD300"]);
    assert.equal(result?.failed.length, 1);
    assert.equal(result?.failed[0].member.memberName, "ORD200");
    assert.equal(result?.failed[0].error, "LMI1234 Member is already checked out.");
    assert.ok(h.logs.some((line) => line.includes("Failed") && line.includes("ORD200")));
  });

  it("refuses to start while another system is connected", async () => {
    const h = deps({ connectedSystem: () => "OTHER" });
    await assert.rejects(
      runChangeManagementCheckout([member("ORD100")], "PUB400", TEMPLATE, h.deps),
      /Connected to OTHER, not PUB400/
    );
    assert.deepEqual(h.confirmed, []);
    assert.deepEqual(h.ran, []);
  });

  it("refuses the rest when the connection changes to another system after confirming", async () => {
    let connected = "PUB400";
    const h = deps({
      connectedSystem: () => connected,
      runCommand: async (command) => {
        h.ran.push(command);
        connected = "OTHER";
      },
    });
    const result = await runChangeManagementCheckout([member("ORD100"), member("ORD200")], "PUB400", TEMPLATE, h.deps);
    assert.equal(h.ran.length, 1);
    assert.deepEqual(result?.succeeded.map((m) => m.memberName), ["ORD100"]);
    assert.equal(result?.failed[0].error, "Connected to OTHER, not PUB400.");
  });
});

describe("&PROJECT and &USER", () => {
  const LMI = "ACMSLIB/ACMSCHKOUT OBJ((&OPENSPF (&OPENMBR))) PROJECT(&PROJECT) DVP(&USER) REL(MYGROUP/MYAPP/BASE)";

  it("fills in Rocket LMI's ACMSCHKOUT with the project asked for and the connection's user", async () => {
    let asked = 0;
    const { deps: d, ran, confirmed } = deps({ askProject: async () => { asked++; return " prj001234 "; } });
    const result = await runChangeManagementCheckout([member("ORD100C", "clle")], "PUB400", LMI, d);
    assert.equal(asked, 1);
    assert.deepEqual(confirmed, [["ACMSLIB/ACMSCHKOUT OBJ((QRPGLESRC (ORD100C))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/BASE)"]]);
    assert.deepEqual(ran, confirmed[0]);
    assert.equal(result?.succeeded.length, 1);
  });

  it("asks for a project only when the command uses it", async () => {
    let asked = 0;
    const { deps: d } = deps({ askProject: async () => { asked++; return "X"; } });
    await runChangeManagementCheckout([member("ORD100")], "PUB400", TEMPLATE, d);
    assert.equal(asked, 0);
  });

  it("runs nothing when the project prompt is cancelled", async () => {
    const { deps: d, ran, confirmed } = deps({ askProject: async () => undefined });
    assert.equal(await runChangeManagementCheckout([member("ORD100")], "PUB400", LMI, d), undefined);
    assert.deepEqual(confirmed, []);
    assert.deepEqual(ran, []);
  });

  it("refuses a project or user that isn't a valid IBM i name, or a user that isn't known", async () => {
    await assert.rejects(
      runChangeManagementCheckout([member("ORD100")], "PUB400", LMI, deps({ askProject: async () => "MOD1) DLTLIB(PROD" }).deps),
      /not a valid project/
    );
    await assert.rejects(
      runChangeManagementCheckout([member("ORD100")], "PUB400", LMI, deps({ currentUser: () => undefined }).deps),
      /uses &USER, but no user profile is known/
    );
    assert.throws(() => expandCheckoutCommand(LMI, member("ORD100"), "DEVLIB", { project: "TOO-LONG-PROJECT", user: "ME" }), /not a valid project/);
  });

  it("still refuses placeholders it doesn't know", () => {
    assert.match(checkoutTemplateProblem("X P(&TASK) D(&DEVELOPER)") ?? "", /&TASK, &DEVELOPER/);
    assert.equal(checkoutTemplateProblem(LMI), undefined);
  });
});

describe("commandFailureMessages", () => {
  it("puts the cause before the messages that only say the command failed, each once", () => {
    const output = [
      "CMS1234: Project PRJ001234 is not open for release MYGROUP/MYAPP/BASE.",
      "CMS9913: Program ACMSCHKOUT ended ABNORMALLY.  The highest CMSnnnn message severity was 30.",
      "SQL0443: Trigger program or external routine detected an error.",
      "SQL0443: Trigger program or external routine detected an error.",
      "",
    ].join("\r\n");
    assert.deepEqual(commandFailureMessages(output), [
      "CMS1234: Project PRJ001234 is not open for release MYGROUP/MYAPP/BASE.",
      "CMS9913: Program ACMSCHKOUT ended ABNORMALLY.  The highest CMSnnnn message severity was 30.",
      "SQL0443: Trigger program or external routine detected an error.",
    ]);
  });

  it("keeps at most 10 messages", () => {
    const output = Array.from({ length: 15 }, (_, i) => `CMS10${String(i).padStart(2, "0")}: message ${i}`).join("\n");
    assert.equal(commandFailureMessages(output).length, 10);
  });
});

describe("a command split over lines", () => {
  it("is run as one line, its line breaks joined with spaces", () => {
    const template = "ACMSLIB/ACMSCHKOUT OBJ((&OPENSPF (&OPENMBR)))\r\n   PROJECT(&PROJECT) DVP(&USER)\n REL(MYGROUP/MYAPP/BASE)\n";
    assert.equal(
      expandCheckoutCommand(template, member("ORDENT"), "DEVLIB", { project: "PRJ001234", user: "DEVUSER" }),
      "ACMSLIB/ACMSCHKOUT OBJ((QRPGLESRC (ORDENT))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/BASE)"
    );
  });
});

describe("&RELEASE", () => {
  const LMI = "ACMSLIB/ACMSCHKOUT OBJ((&OPENSPF (&OPENMBR))) PROJECT(&PROJECT) DVP(&USER) REL(&RELEASE)";

  it("fills in the release given for this checkout, and reports it", async () => {
    const { deps: d, confirmed } = deps({ askRelease: async () => " mygroup/myapp/next " });
    const result = await runChangeManagementCheckout([member("ORDENT")], "PUB400", LMI, d);
    assert.deepEqual(confirmed, [["ACMSLIB/ACMSCHKOUT OBJ((QRPGLESRC (ORDENT))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/NEXT)"]]);
    assert.equal(result?.release, "MYGROUP/MYAPP/NEXT");
  });

  it("asks for a release only when the command uses it", async () => {
    let asked = 0;
    const { deps: d } = deps({ askRelease: async () => { asked++; return "BASE"; } });
    const result = await runChangeManagementCheckout([member("ORD100")], "PUB400", TEMPLATE, d);
    assert.equal(asked, 0);
    assert.equal(result?.release, undefined);
  });

  it("runs nothing when the release prompt is cancelled", async () => {
    const { deps: d, ran } = deps({ askRelease: async () => undefined });
    assert.equal(await runChangeManagementCheckout([member("ORD100")], "PUB400", LMI, d), undefined);
    assert.deepEqual(ran, []);
  });

  it("accepts one to three IBM i names joined by /", () => {
    for (const value of ["MYGROUP/MYAPP/BASE", "BASE", "A/B"]) {
      assert.equal(releaseProblem(value), undefined, value);
    }
    for (const value of ["A/B/C/D", "A//B", "A B", "A)", "", "/BASE"]) {
      assert.ok(releaseProblem(value), value);
    }
  });
});
