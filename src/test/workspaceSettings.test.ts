import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitIntegrationState } from "../workspaceSettings";

describe("gitIntegrationState", () => {
  it("is off by default", () => {
    assert.equal(gitIntegrationState({ defaultValue: false }, false), "off");
    assert.equal(gitIntegrationState(undefined, false), "off");
  });

  it("follows user settings without asking", () => {
    assert.equal(gitIntegrationState({ defaultValue: false, globalValue: true }, false), "on");
    assert.equal(gitIntegrationState({ defaultValue: false, globalValue: false }, true), "off");
  });

  it("needs confirmation before a workspace or folder setting turns it on", () => {
    assert.equal(gitIntegrationState({ defaultValue: false, workspaceValue: true }, false), "needsConfirmation");
    assert.equal(gitIntegrationState({ defaultValue: false, workspaceFolderValue: true }, false), "needsConfirmation");
    assert.equal(gitIntegrationState({ defaultValue: false, workspaceValue: true }, true), "on");
  });

  it("lets a workspace or folder setting turn it off", () => {
    assert.equal(gitIntegrationState({ defaultValue: false, globalValue: true, workspaceValue: false }, false), "off");
    assert.equal(gitIntegrationState({ defaultValue: false, workspaceValue: true, workspaceFolderValue: false }, true), "off");
  });
});
