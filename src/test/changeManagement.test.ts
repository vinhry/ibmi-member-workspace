import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeCheckinDeps,
  ChangeCheckoutDeps,
  ChangeMember,
  CheckinMember,
  checkinMemberOf,
  checkinRefusal,
  checkoutTemplateProblem,
  commandFailureMessages,
  commandTemplateProblem,
  releaseProblem,
  expandCheckinCommand,
  expandCheckoutCommand,
  runChangeManagementCheckin,
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

const CHECKIN_TEMPLATE = "ACMSLIB/ACMSCHKIN OBJ((&OPENSPF (&OPENMBR))) PROJECT(&PROJECT) DVP(&USER) REL(&RELEASE)";

function checkout(memberName: string, origin: Partial<Pick<CheckinMember, "openLibrary" | "project" | "release">> = {}): CheckinMember {
  return { library: "DEVLIB", sourceFile: "QRPGLESRC", memberName, extension: "rpgle", ...origin };
}

function checkinDeps(overrides: Partial<ChangeCheckinDeps> = {}) {
  const ran: string[] = [];
  const logs: string[] = [];
  const confirmed: string[][] = [];
  const asked: Array<{ what: string; suggested: string | undefined }> = [];
  const value: ChangeCheckinDeps = {
    askOpenLibrary: async () => {
      asked.push({ what: "openLibrary", suggested: undefined });
      return "prodlib";
    },
    askProject: async (suggested) => {
      asked.push({ what: "project", suggested });
      return suggested ?? "prj009999";
    },
    askRelease: async (suggested) => {
      asked.push({ what: "release", suggested });
      return suggested ?? "mygroup/myapp/base";
    },
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
  return { deps: value, ran, logs, confirmed, asked };
}

describe("expandCheckinCommand", () => {
  it("fills Rocket LMI's check-in with the checkout's names and what its checkout recorded", () => {
    assert.equal(
      expandCheckinCommand(CHECKIN_TEMPLATE, checkout("ord100", { openLibrary: "PRODLIB", project: "PRJ001234", release: "MYGROUP/MYAPP/BASE" }), { user: "devuser" }),
      "ACMSLIB/ACMSCHKIN OBJ((QRPGLESRC (ORD100))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/BASE)"
    );
  });

  it("fills &DEVLIB with the library the member is checked out in, and &OPENLIB with the one it came from", () => {
    assert.equal(
      expandCheckinCommand("MYCHKIN SRCF(&DEVLIB/&OPENSPF) MBR(&OPENMBR) TYPE(&EXT) TOLIB(&OPENLIB)", checkout("ord100", { openLibrary: "prodlib" })),
      "MYCHKIN SRCF(DEVLIB/QRPGLESRC) MBR(ORD100) TYPE(RPGLE) TOLIB(PRODLIB)"
    );
    assert.equal(
      expandCheckinCommand("MYCHKIN MBR(&OPENMBR) TOLIB(&OPENLIB)", checkout("ord100"), { openLibrary: "otherlib" }),
      "MYCHKIN MBR(ORD100) TOLIB(OTHERLIB)"
    );
  });

  it("refuses &OPENLIB, &PROJECT or &RELEASE when nothing is known for them", () => {
    assert.throws(() => expandCheckinCommand("MYCHKIN TOLIB(&OPENLIB)", checkout("ord100")), /uses &OPENLIB, but no production library is known/);
    assert.throws(() => expandCheckinCommand("MYCHKIN PROJECT(&PROJECT)", checkout("ord100")), /uses &PROJECT, but no project is known/);
    assert.throws(() => expandCheckinCommand("MYCHKIN REL(&RELEASE)", checkout("ord100")), /uses &RELEASE, but no release is known/);
    assert.throws(() => expandCheckinCommand("MYCHKIN TOLIB(&OPENLIB)", checkout("ord100", { openLibrary: "bad lib" })), /not a valid production library/);
  });

  it("names the check-in command in its messages", () => {
    assert.equal(commandTemplateProblem("", "checkin"), "The change-management check-in command is empty.");
    assert.match(commandTemplateProblem("CHKIN &NOPE", "checkin")!, /^The change-management check-in command uses unknown placeholders: &NOPE\./);
    assert.throws(() => expandCheckinCommand("", checkout("ord100")), /check-in command is empty/);
    assert.equal(checkoutTemplateProblem(""), "The change-management checkout command is empty.");
  });
});

describe("checkinMemberOf and checkinRefusal", () => {
  it("takes the checkout's names and what change management recorded", () => {
    const base = { library: "DEVLIB", sourceFile: "QRPGLESRC", memberName: "ORD100", extension: "rpgle" };
    assert.deepEqual(checkinMemberOf(base), base);
    assert.deepEqual(
      checkinMemberOf({ ...base, changeManagement: { openLibrary: "PRODLIB", project: "PRJ001234", checkedOutAt: "2026-10-06T10:00:00.000Z" } }),
      { ...base, openLibrary: "PRODLIB", project: "PRJ001234" }
    );
  });

  it("refuses reference copies and members with changes not yet uploaded", () => {
    assert.match(checkinRefusal({ kind: "reference", status: "in-sync" })!, /reference copy/);
    assert.match(checkinRefusal({ status: "modified" })!, /upload it first/);
    assert.match(checkinRefusal({ status: "conflict" })!, /upload it first/);
    for (const status of ["in-sync", "merged", "checked-out", "remote-changed"] as const) {
      assert.equal(checkinRefusal({ status }), undefined, status);
    }
  });
});

describe("runChangeManagementCheckin", () => {
  it("suggests the project and release recorded at checkout, shows the commands, then runs them", async () => {
    const d = checkinDeps();
    const members = [
      checkout("ord100", { openLibrary: "PRODLIB", project: "PRJ001234", release: "MYGROUP/MYAPP/BASE" }),
      checkout("ord200", { openLibrary: "PRODLIB", project: "PRJ001234", release: "MYGROUP/MYAPP/BASE" }),
    ];
    const result = await runChangeManagementCheckin(members, "PUB400", CHECKIN_TEMPLATE, d.deps);
    assert.deepEqual(d.asked, [
      { what: "project", suggested: "PRJ001234" },
      { what: "release", suggested: "MYGROUP/MYAPP/BASE" },
    ]);
    const expected = [
      "ACMSLIB/ACMSCHKIN OBJ((QRPGLESRC (ORD100))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/BASE)",
      "ACMSLIB/ACMSCHKIN OBJ((QRPGLESRC (ORD200))) PROJECT(PRJ001234) DVP(DEVUSER) REL(MYGROUP/MYAPP/BASE)",
    ];
    assert.deepEqual(d.confirmed, [expected]);
    assert.deepEqual(d.ran, expected);
    assert.deepEqual(result, { project: "PRJ001234", release: "MYGROUP/MYAPP/BASE", succeeded: members, failed: [] });
  });

  it("asks for the production library only when the command uses it and a member's isn't known", async () => {
    const known = checkinDeps();
    await runChangeManagementCheckin([checkout("ord100", { openLibrary: "PRODLIB" })], "PUB400", "MYCHKIN MBR(&OPENMBR) TOLIB(&OPENLIB)", known.deps);
    assert.deepEqual(known.asked, []);
    assert.deepEqual(known.ran, ["MYCHKIN MBR(ORD100) TOLIB(PRODLIB)"]);

    const unknown = checkinDeps();
    await runChangeManagementCheckin([checkout("ord100", { openLibrary: "PRODLIB" }), checkout("ord200")], "PUB400", "MYCHKIN MBR(&OPENMBR) TOLIB(&OPENLIB)", unknown.deps);
    assert.deepEqual(unknown.asked, [{ what: "openLibrary", suggested: undefined }]);
    assert.deepEqual(unknown.ran, ["MYCHKIN MBR(ORD100) TOLIB(PRODLIB)", "MYCHKIN MBR(ORD200) TOLIB(PRODLIB)"]);

    const unused = checkinDeps();
    await runChangeManagementCheckin([checkout("ord200")], "PUB400", "MYCHKIN MBR(&OPENMBR)", unused.deps);
    assert.deepEqual(unused.asked, []);
  });

  it("runs nothing when a prompt is cancelled or the commands are declined", async () => {
    for (const overrides of [
      { askOpenLibrary: async () => undefined },
      { askProject: async () => "" },
      { askRelease: async () => undefined },
      { confirm: async () => false },
    ] as Partial<ChangeCheckinDeps>[]) {
      const d = checkinDeps(overrides);
      const result = await runChangeManagementCheckin([checkout("ord100")], "PUB400", "CHKIN &OPENMBR &OPENLIB &PROJECT &RELEASE", d.deps);
      assert.equal(result, undefined);
      assert.deepEqual(d.ran, []);
    }
  });

  it("refuses a bad template before asking anything", async () => {
    const d = checkinDeps();
    await assert.rejects(runChangeManagementCheckin([checkout("ord100")], "PUB400", "CHKIN &NOPE", d.deps), /check-in command uses unknown placeholders: &NOPE/);
    assert.deepEqual(d.asked, []);
    assert.deepEqual(d.confirmed, []);
  });

  it("goes on after a failed member and reports it with the IBM i's message", async () => {
    const d = checkinDeps({
      runCommand: async (command) => {
        if (command.includes("ORD100")) {
          throw new Error("CMS9913 ACMSCHKIN ended ABNORMALLY");
        }
      },
    });
    const members = [checkout("ord100"), checkout("ord200")];
    const result = await runChangeManagementCheckin(members, "PUB400", "CHKIN &OPENMBR", d.deps);
    assert.deepEqual(result?.succeeded, [members[1]]);
    assert.deepEqual(result?.failed, [{ member: members[0], command: "CHKIN ORD100", error: "CMS9913 ACMSCHKIN ended ABNORMALLY" }]);
  });

  it("refuses to start while another system is connected, and the rest when it changes afterwards", async () => {
    const other = checkinDeps({ connectedSystem: () => "OTHER" });
    await assert.rejects(runChangeManagementCheckin([checkout("ord100")], "PUB400", "CHKIN &OPENMBR", other.deps), /Connected to OTHER, not PUB400/);
    assert.deepEqual(other.ran, []);

    let connected = "PUB400";
    const d = checkinDeps({
      connectedSystem: () => connected,
      runCommand: async () => {
        connected = "OTHER";
      },
    });
    const result = await runChangeManagementCheckin([checkout("ord100"), checkout("ord200")], "PUB400", "CHKIN &OPENMBR", d.deps);
    assert.equal(result?.succeeded.length, 1);
    assert.equal(result?.failed[0].error, "Connected to OTHER, not PUB400.");
  });
});

describe("runChangeManagementCheckout reports the project", () => {
  it("returns the project the commands used, for the checkouts that follow", async () => {
    const d = deps();
    const result = await runChangeManagementCheckout([member("ord100")], "PUB400", "CHKOUT &OPENMBR PROJECT(&PROJECT)", d.deps);
    assert.equal(result?.project, "PRJ001234");
    const without = await runChangeManagementCheckout([member("ord100")], "PUB400", TEMPLATE, deps().deps);
    assert.equal(without?.project, undefined);
  });
});
