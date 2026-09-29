import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { PackageManager, listFiles } from "@vscode/vsce";

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
const srcPath = join(root, "src");

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
}

/** Every non-test TypeScript source file under src/. */
function runtimeSourceFiles(): string[] {
  return readdirSync(srcPath, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.startsWith(`test${sep}`))
    .map((file) => join(srcPath, file));
}

describe("extension manifest", () => {
  it("uses the standalone product identity", () => {
    const manifest = readManifest();

    assert.equal(manifest.name, "ibmi-member-workspace");
    assert.equal(manifest.publisher, "vinhry");
    assert.equal(manifest.version, "1.6.0");
  });

  it("contributes exactly the commands registered by the extension", () => {
    const manifest = readManifest();
    const source = runtimeSourceFiles().map((file) => readFileSync(file, "utf8")).join("\n");
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

    const runtimeFiles = [manifestPath, ...runtimeSourceFiles()];

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

  it("stays off in untrusted workspaces", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      capabilities?: { untrustedWorkspaces?: { supported?: unknown } };
    };

    assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
  });

  it("reads settings that send code to the IBM i or run queries from user settings only", () => {
    const properties = readManifest().contributes.configuration.properties as Record<string, { scope?: string }>;

    for (const setting of ["autoUploadOnSave", "dependencies.crossReferences", "bob.researchTools"]) {
      assert.equal(properties[`ibmi-member-workspace.${setting}`].scope, "application", setting);
    }
  });

  it("shows the Bob commands only in IBM Bob", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contributes: { commands: Array<{ command: string }>; menus: Record<string, Array<{ command: string; when?: string }>> };
    };
    const bobCommands = manifest.contributes.commands
      .map(({ command }) => command)
      .filter((command) => command.startsWith("ibmi-member-workspace.bob."));
    assert.ok(bobCommands.length > 0);
    for (const command of bobCommands) {
      const palette = manifest.contributes.menus.commandPalette.find((item) => item.command === command);
      assert.equal(palette?.when, "ibmi-member-workspace:isBobIde", command);
      for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
        if (menu !== "commandPalette") {
          assert.ok(!items.some((item) => item.command === command), `${command} in ${menu}`);
        }
      }
    }
    // The server and its commands are only set up behind the Bob check.
    const extension = readFileSync(join(srcPath, "extension.ts"), "utf8");
    assert.match(extension, /if \(inBob\) \{[\s\S]{0,200}?registerBobCommands\(ctx\);/);
    assert.equal(extension.match(/registerBobCommands\(/g)?.length, 1);
  });

  it("packages only the files the extension needs", async () => {
    // Anything else (handoff notes, plans, old .vsix files, .claude/, tests) must not ship.
    const allowed = [
      /^package\.json$/,
      /^readme\.md$/,
      /^CHANGELOG\.md$/,
      /^LICENSE$/,
      /^NOTICE$/,
      /^images\/icon\.png$/,
      /^resources\/[^/]+\.svg$/,
      /^out\/(?!test\/)[^/]+(?:\/[^/]+)*\.js$/,
    ];
    const files = await listFiles({ cwd: root, packageManager: PackageManager.None });

    assert.deepEqual(files.filter((file) => !allowed.some((pattern) => pattern.test(file))), []);
    assert.ok(files.includes("out/extension.js"));
  });
});
