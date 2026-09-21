import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  contributes: {
    commands: Array<{ command: string }>;
    configuration: { properties: Record<string, unknown> };
    viewsWelcome: Array<{ view: string; contents: string; when: string }>;
  };
}

const root = join(__dirname, "..", "..");
const manifestPath = join(root, "package.json");
const extensionPath = join(root, "src", "extension.ts");

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
}

describe("extension manifest", () => {
  it("uses the standalone product identity", () => {
    const manifest = readManifest();

    assert.equal(manifest.name, "ibmi-member-workspace");
    assert.equal(manifest.publisher, "vinhry");
    assert.equal(manifest.version, "1.0.1");
  });

  it("contributes exactly the commands registered by the extension", () => {
    const manifest = readManifest();
    const source = readFileSync(extensionPath, "utf8");
    const registered = [...source.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)]
      .map((match) => match[1])
      .sort();
    const contributed = manifest.contributes.commands
      .map(({ command }) => command)
      .sort();

    assert.deepEqual(registered, contributed);
  });

  it("keeps all owned commands and settings in the new namespace", () => {
    const manifest = readManifest();
    const commands = manifest.contributes.commands.map(({ command }) => command);
    const settings = Object.keys(manifest.contributes.configuration.properties);

    assert.ok(commands.every((command) => command.startsWith("ibmi-member-workspace.")));
    assert.ok(settings.every((setting) => setting.startsWith("ibmi-member-workspace.")));
    assert.ok(commands.includes("ibmi-member-workspace.configureCheckoutFolder"));
    assert.ok(!settings.includes("ibmi-member-workspace.localFolder"));
    assert.ok(
      manifest.contributes.viewsWelcome.some(
        ({ when }) => when === "!ibmi-member-workspace:checkoutFolderConfigured"
      )
    );

    const runtimeFiles = [manifestPath, ...[
      "checkoutService.ts",
      "checkoutTreeProvider.ts",
      "extension.ts",
      "mergeHandler.ts",
    ].map((file) => join(root, "src", file))];

    for (const file of runtimeFiles) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /ibmi-checkout/);
    }
  });

  it("does not fall back to extension-global storage for member files", () => {
    const serviceSource = readFileSync(join(root, "src", "checkoutService.ts"), "utf8");

    assert.doesNotMatch(serviceSource, /globalStorageUri/);
    assert.doesNotMatch(serviceSource, /get<string>\("localFolder"/);
    assert.match(serviceSource, /context\.storageUri/);
    assert.match(serviceSource, /workspaceState\.get<string>\("checkoutRoot"\)/);
  });
});
