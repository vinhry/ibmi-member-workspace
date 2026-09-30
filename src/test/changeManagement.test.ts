import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeCheckoutDeps,
  ChangeMember,
  checkoutTemplateProblem,
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
    confirm: async (commands) => {
      confirmed.push(commands);
      return true;
    },
    connectedSystem: () => "PUB400",
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
