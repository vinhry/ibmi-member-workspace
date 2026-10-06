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
    assert.equal(manifest.version, "1.8.2");
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

    for (const setting of [
      "autoUploadOnSave",
      "dependencies.crossReferences",
      "bob.researchTools",
      "changeManagement.checkoutCommand",
      "backgroundRefresh.onConnect",
      "backgroundRefresh.intervalMinutes",
      "agents.researchTools",
      "changeManagement.release",
    ]) {
      assert.equal(properties[`ibmi-member-workspace.${setting}`].scope, "application", setting);
    }
  });

  it("shows the Bob commands only in IBM Bob", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>>;
      };
    };
    const { menus } = manifest.contributes;
    const investigateMenu = "ibmi-member-workspace.bobInvestigate";
    const investigate = (menus[investigateMenu] ?? []).map((item) => item.command);
    assert.deepEqual(investigate, [
      "ibmi-member-workspace.bob.analyzeRelationships",
      "ibmi-member-workspace.bob.explainProgram",
      "ibmi-member-workspace.bob.deepDive",
    ]);
    const bobCommands = manifest.contributes.commands
      .map(({ command }) => command)
      .filter((command) => command.startsWith("ibmi-member-workspace.bob."));
    // Right-click prompts need a selection, and Refresh belongs to the Bob view, so neither is in the palette.
    const notInPalette = [...investigate, "ibmi-member-workspace.bob.refreshStatus"];
    const inBobView = /^view == ibmi-member-workspace\.bobView && (.+ && )?ibmi-member-workspace:isBobIde$/;
    for (const command of bobCommands) {
      const palette = menus.commandPalette.find((item) => item.command === command);
      assert.equal(palette?.when, notInPalette.includes(command) ? "false" : "ibmi-member-workspace:isBobIde", command);
      for (const [menu, items] of Object.entries(menus)) {
        if (menu !== "commandPalette" && menu !== investigateMenu) {
          // Outside the palette and the submenu, only the Bob view's own menus hold Bob commands.
          const elsewhere = items.filter((item) => item.command === command && !inBobView.test(item.when ?? ""));
          assert.deepEqual(elsewhere, [], `${command} in ${menu}`);
        }
      }
    }
    // The submenu, and everything in it, shows only in Bob.
    const placements = Object.entries(menus).flatMap(([menu, items]) =>
      items.filter((item) => item.submenu === investigateMenu).map((item) => ({ menu, ...item }))
    );
    assert.deepEqual(placements.map((item) => item.menu).sort(), ["explorer/context", "view/item/context", "view/item/context"]);
    for (const item of [...placements, ...menus[investigateMenu]]) {
      assert.match(item.when ?? "", /(^|&& )ibmi-member-workspace:isBobIde( &&|$)/, JSON.stringify(item));
    }
    const properties = manifest.contributes as unknown as {
      configuration: { properties: Record<string, { default?: unknown; minimum?: unknown; maximum?: unknown }> };
    };
    const limit = properties.configuration.properties["ibmi-member-workspace.bob.whereUsedMaxLibraries"];
    assert.deepEqual([limit?.default, limit?.minimum, limit?.maximum], [10, 1, 25]);
    // The server and its commands are only set up behind the Bob check.
    const extension = readFileSync(join(srcPath, "extension.ts"), "utf8");
    assert.match(extension, /if \(inBob\) \{[\s\S]{0,200}?registerBobCommands\(ctx\);/);
    assert.equal(extension.match(/registerBobCommands\(/g)?.length, 1);
  });

  it("puts the Bob Research Tools view, shown only in IBM Bob, above Checked Out Members", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contributes: {
        commands: Array<{ command: string }>;
        views: Record<string, Array<{ id: string; when?: string; initialSize?: number }>>;
        viewsWelcome: Array<{ view: string; contents: string; when: string }>;
      };
    };
    const views = manifest.contributes.views["ibmi-member-workspace"].map((view) => view.id);
    assert.deepEqual(views, [
      "ibmi-member-workspace.bobView",
      "ibmi-member-workspace.agentsView",
      "ibmi-member-workspace.checkoutView",
      "ibmi-member-workspace.findMemberView",
    ]);
    const [bobView, , checkoutView] = manifest.contributes.views["ibmi-member-workspace"];
    assert.equal(bobView.when, "ibmi-member-workspace:isBobIde");
    // The status needs a few rows: the Bob section starts at its minimum height, not half the side bar.
    assert.ok((bobView.initialSize ?? 0) > 0 && (bobView.initialSize ?? 0) < (checkoutView.initialSize ?? 0));

    const welcome = manifest.contributes.viewsWelcome.filter((item) => item.view === "ibmi-member-workspace.bobView");
    assert.deepEqual(welcome.map((item) => item.when), [
      "ibmi-member-workspace:isBobIde && config.ibmi-member-workspace.bob.researchTools",
      "ibmi-member-workspace:isBobIde && !config.ibmi-member-workspace.bob.researchTools",
    ]);
    assert.match(welcome[0].contents, /\[Connect Bob to IBM i Research Tools\]\(command:ibmi-member-workspace\.bob\.connectResearchTools\)/);
    const commands = manifest.contributes.commands.map(({ command }) => command);
    for (const { contents } of welcome) {
      for (const [, command] of contents.matchAll(/\(command:([^)?]+)/g)) {
        assert.ok(command.startsWith("workbench.") || commands.includes(command), command);
      }
    }
  });

  it("puts the AI Research Tools view, shown with an agent installed (in VS Code and IBM Bob), above Checked Out Members", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contributes: {
        commands: Array<{ command: string }>;
        views: Record<string, Array<{ id: string; when?: string; initialSize?: number }>>;
        viewsWelcome: Array<{ view: string; contents: string; when: string }>;
        mcpServerDefinitionProviders?: Array<{ id: string; label: string }>;
      };
    };
    const views = manifest.contributes.views["ibmi-member-workspace"];
    const agentsView = views.find((view) => view.id === "ibmi-member-workspace.agentsView");
    const checkoutView = views.find((view) => view.id === "ibmi-member-workspace.checkoutView");
    assert.equal(agentsView?.when, "ibmi-member-workspace:agentAvailable");
    assert.ok((agentsView?.initialSize ?? 0) > 0 && (agentsView?.initialSize ?? 0) < (checkoutView?.initialSize ?? 0));

    const welcome = manifest.contributes.viewsWelcome.filter((item) => item.view === "ibmi-member-workspace.agentsView");
    assert.deepEqual(welcome.map((item) => item.when), [
      "config.ibmi-member-workspace.agents.researchTools",
      "!config.ibmi-member-workspace.agents.researchTools",
    ]);
    const commands = manifest.contributes.commands.map(({ command }) => command);
    for (const { contents } of welcome) {
      for (const [, command] of contents.matchAll(/\(command:([^)?]+)/g)) {
        assert.ok(command.startsWith("workbench.") || commands.includes(command), command);
      }
    }
    // The id the extension registers its Copilot MCP server provider under (src/commands/agents.ts).
    assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [
      { id: "ibmi-member-workspace.researchTools", label: "IBM i Member Workspace" },
    ]);
  });

  it("offers Find All Dependencies right below Find Dependencies, with bounded limits", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contributes: {
        menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
        configuration: { properties: Record<string, { default?: unknown; minimum?: unknown; maximum?: unknown }> };
      };
    };
    const { menus, configuration } = manifest.contributes;
    const inCheckoutView = (command: string) =>
      menus["view/item/context"].find((item) => item.command === command && item.when?.includes("checkoutView"));
    const direct = inCheckoutView("ibmi-member-workspace.findDependencies");
    const all = inCheckoutView("ibmi-member-workspace.findAllDependencies");
    assert.equal(direct?.group, "0_bob@2");
    assert.equal(all?.group, "0_bob@3");
    assert.equal(all?.when, direct?.when);
    // It needs a checked-out member, so it isn't in the Command Palette.
    assert.equal(menus.commandPalette.find((item) => item.command === "ibmi-member-workspace.findAllDependencies")?.when, "false");

    const limits = (name: string) => {
      const setting = configuration.properties[`ibmi-member-workspace.dependencies.transitive.${name}`];
      return [setting?.default, setting?.minimum, setting?.maximum];
    };
    // The scope has a named default, so Settings never shows an empty choice.
    const scope = configuration.properties["ibmi-member-workspace.dependencies.searchScope"] as unknown as {
      default?: string; enum?: string[]; enumItemLabels?: string[]; enumDescriptions?: string[];
    };
    assert.equal(scope.default, "auto");
    assert.equal(scope.enum?.[0], "auto");
    assert.equal(scope.enumItemLabels?.length, scope.enum?.length);
    assert.equal(scope.enumDescriptions?.length, scope.enum?.length);
    assert.deepEqual(limits("maxDepth"), [3, 1, 10]);
    assert.deepEqual(limits("maxMembers"), [50, 5, 500]);
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
