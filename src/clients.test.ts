import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverConfigPaths, __testing } from "./discover.js";
import { isClaudeSettingsFile, parseConfigFile } from "./parse.js";
import { exitCode, formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import { buildSarif, formatAnnotations } from "./sarif.js";
import type { HealthReport } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const fixtures = join(repo, "fixtures");

const CLAUDE_SECRETS = [
  "claude-oauth-secret-do-not-print",
  "claude-user-secret-do-not-print",
  "claude-local-secret-do-not-print",
  "claude-other-secret-do-not-print",
];

function expectSecretsHidden(report: HealthReport, secrets: string[]) {
  const dumped = `${formatHuman(report)}\n${formatJson(report)}`;
  for (const secret of secrets) {
    expect(dumped, secret).not.toContain(secret);
  }
}

function codes(report: HealthReport): string[] {
  return report.servers.flatMap((server) => server.findings.map((finding) => finding.code));
}

function names(report: HealthReport): string[] {
  return report.servers.map((server) => server.name);
}

function writeClaudeHome(home: string, root: string) {
  const template = readFileSync(join(fixtures, "claude-user", ".claude.json"), "utf8");
  const dest = join(home, ".claude.json");
  writeFileSync(dest, template.replaceAll("__ROOT__", root));
  return dest;
}

describe("Claude Code ~/.claude.json", () => {
  it("checks the user server and only the matching project entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-root-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-home-"));
    try {
      writeClaudeHome(home, root);
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(report).sort()).toEqual(["local-fs", "user-memory"]);
      expect(names(report)).not.toContain("other-db");
      expect(codes(report)).toContain("HEALTHY");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("NO_MCP_SECTION");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expect(report.summary.fail).toBe(0);
      expectSecretsHidden(report, CLAUDE_SECRETS);
      expect(report.files.some((file) => file.endsWith(`${home}/.claude.json`) || file.endsWith(".claude.json"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches a project key with a trailing slash and ignores a different root", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-slash-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-slash-home-"));
    const file = join(home, ".claude.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          projects: {
            [`${root}/`]: {
              mcpServers: { local: { command: "node", args: ["--version"] } },
            },
            "/definitely/not/the/scan/root": {
              mcpServers: { other: { command: "node", args: ["--version"] } },
            },
          },
        }),
      );
      const matched = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(matched)).toEqual(["local"]);

      const elsewhere = mkdtempSync(join(tmpdir(), "mcp-health-claude-other-"));
      try {
        const skipped = await runCheck({
          root: elsewhere,
          includeUserConfig: true,
          home,
          env: {},
        });
        expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
        expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
        expect(names(skipped)).not.toContain("local");
        expect(names(skipped)).not.toContain("other");
        expect(skipped.summary.fail).toBe(0);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("includes the project server when the scan root is another path to the same directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-health-claude-link-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-link-home-"));
    const other = mkdtempSync(join(tmpdir(), "mcp-health-claude-link-other-"));
    const real = join(base, "private", "tmp", "proj");
    mkdirSync(real, { recursive: true });
    symlinkSync(join(base, "private", "tmp"), join(base, "tmp"), "dir");
    const viaTmp = join(base, "tmp", "proj");
    const linked = join(base, "linked");
    symlinkSync(real, linked, "dir");
    const otherLink = join(base, "other-link");
    symlinkSync(other, otherLink, "dir");
    const file = join(home, ".claude.json");
    const project = (name: string) => ({
      mcpServers: { [name]: { command: "node", args: ["--version"] } },
    });
    const writeHome = (projects: Record<string, unknown>) => {
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            "user-memory": { command: "node", args: ["--version"] },
          },
          projects,
        }),
      );
    };
    try {
      writeHome({
        [real]: project("local-fs"),
        [other]: project("other-db"),
      });
      for (const root of [linked, viaTmp]) {
        const report = await runCheck({
          root,
          includeUserConfig: true,
          home,
          env: {},
        });
        expect(names(report).sort()).toEqual(["local-fs", "user-memory"]);
        expect(names(report)).not.toContain("other-db");
      }

      writeHome({
        [`${linked}/`]: project("local-fs"),
        [`${otherLink}/`]: project("other-db"),
      });
      const fromReal = await runCheck({
        root: real,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(fromReal).sort()).toEqual(["local-fs", "user-memory"]);
      expect(names(fromReal)).not.toContain("other-db");
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("matches a Windows project key case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-claude-win-"));
    const file = join(dir, ".claude.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          projects: {
            "C:\\Users\\Me\\Proj\\": {
              mcpServers: { local: { command: "node", args: ["--version"] } },
            },
            "C:\\Users\\Me\\Other": {
              mcpServers: { other: { command: "node", args: ["--version"] } },
            },
          },
        }),
      );
      const parsed = parseConfigFile(file, {
        root: "C:/Users/me/proj",
        platform: "win32",
      });
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.map((server) => server.name)).toEqual(["local"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the existing parser for a bad user entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-schema-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-schema-home-"));
    try {
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { bad: { command: "node", env: { PORT: 1 } } },
        }),
      );
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(report)).toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("NO_MCP_SECTION");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads .claude.json from CLAUDE_CONFIG_DIR and from %USERPROFILE%", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-dir-"));
    const configDir = join(home, "custom-claude");
    try {
      expect(__testing.claudeCodeUserPath({ home, env: {} })).toBe(
        join(home, ".claude.json"),
      );
      expect(
        __testing.claudeCodeUserPath({
          home,
          env: { CLAUDE_CONFIG_DIR: configDir },
        }),
      ).toBe(join(configDir, ".claude.json"));
      expect(
        __testing.claudeCodeUserPath({
          platform: "win32",
          home: join(home, "not-profile"),
          env: { USERPROFILE: join(home, "profile") },
        }),
      ).toBe(join(home, "profile", ".claude.json"));
      expect(
        __testing.claudeCodeUserPath({
          platform: "win32",
          home: join(home, "not-profile"),
          env: {
            USERPROFILE: join(home, "profile"),
            CLAUDE_CONFIG_DIR: configDir,
          },
        }),
      ).toBe(join(configDir, ".claude.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("scans CLAUDE_CONFIG_DIR instead of the home file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-override-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-override-home-"));
    const configDir = join(home, "alt");
    try {
      mkdirSync(configDir);
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { fromHome: { command: "node", args: ["--version"] } },
        }),
      );
      writeFileSync(
        join(configDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { fromConfigDir: { command: "node", args: ["--version"] } },
        }),
      );
      const found = discoverConfigPaths(root, {
        includeUserConfig: true,
        home,
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      expect(found).toContain(join(configDir, ".claude.json"));
      expect(found).not.toContain(join(home, ".claude.json"));
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      expect(names(report)).toEqual(["fromConfigDir"]);
      expect(names(report)).not.toContain("fromHome");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still reads project configs with --no-user and skips ~/.claude.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-nouser-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-nouser-home-"));
    try {
      writeClaudeHome(home, root);
      mkdirSync(join(root, ".claude"));
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { fromMcp: { command: "node", args: ["--version"] } },
        }),
      );
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({
          mcpServers: { fromSettings: { command: "node", args: ["--version"] } },
        }),
      );
      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped).sort()).toEqual(["(config)", "fromMcp"]);
      expect(names(skipped)).not.toContain("fromSettings");
      expect(codes(skipped)).toContain("MCP_SERVERS_IGNORED");
      expect(exitCode(skipped)).toBe(2);
      expect(skipped.files.some((file) => file.endsWith(".claude.json"))).toBe(false);
      expectSecretsHidden(skipped, CLAUDE_SECRETS);

      const cli = spawnSync(
        join(repo, "node_modules", ".bin", "tsx"),
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--json", root],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
            CLAUDE_CONFIG_DIR: "",
            CLINE_DATA_DIR: "",
            CLINE_MCP_SETTINGS_PATH: "",
          },
        },
      );
      expect(cli.status).toBe(2);
      const output = `${cli.stdout}\n${cli.stderr}`;
      expect(output).toContain("fromMcp");
      expect(output).toContain("MCP_SERVERS_IGNORED");
      expect(output).not.toContain("fromSettings");
      expect(output).not.toContain("user-memory");
      expect(output).not.toContain("local-fs");
      expect(output).not.toContain("other-db");
      for (const secret of CLAUDE_SECRETS) {
        expect(output, secret).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Claude Code settings files", () => {
  it("recognizes project and user settings paths, not other JSON configs", () => {
    expect(isClaudeSettingsFile("/work/app/.claude/settings.json")).toBe(true);
    expect(isClaudeSettingsFile("/work/app/.claude/settings.local.json")).toBe(true);
    expect(isClaudeSettingsFile("/home/me/.claude/settings.json")).toBe(true);
    expect(isClaudeSettingsFile("C:\\Users\\me\\.claude\\settings.json")).toBe(true);
    expect(isClaudeSettingsFile("C:\\Users\\me\\.claude\\settings.local.json")).toBe(true);
    expect(isClaudeSettingsFile("/work/app/.mcp.json")).toBe(false);
    expect(isClaudeSettingsFile("/home/me/.claude.json")).toBe(false);
    expect(isClaudeSettingsFile("/work/app/.gemini/settings.json")).toBe(false);
    expect(isClaudeSettingsFile("/work/app/.zed/settings.json")).toBe(false);
  });

  it("fails a project settings mcpServers block and does not probe it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-settings-"));
    const marker = join(root, "spawned.txt");
    const secret = "settings-secret-do-not-print";
    try {
      const script = join(root, "spawn.mjs");
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned\\n");\n`,
      );
      const settings = join(root, ".claude", "settings.json");
      mkdirSync(join(root, ".claude"));
      writeFileSync(
        settings,
        JSON.stringify({
          mcpServers: {
            local: {
              command: "node",
              args: [script],
              env: { API_KEY: secret },
            },
          },
        }),
      );
      const report = await runCheck({
        root,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 3000,
        env: {},
      });
      expect(report.servers.map((server) => server.name)).toEqual(["(config)"]);
      expect(report.servers[0]?.scope).toBe("project");
      expect(report.servers[0]?.findings.map((finding) => finding.code)).toEqual([
        "MCP_SERVERS_IGNORED",
      ]);
      expect(report.servers[0]?.findings[0]?.message).toContain("settings.json");
      expect(report.servers[0]?.findings[0]?.message).toContain(".mcp.json");
      expect(report.servers[0]?.findings[0]?.message).toContain("~/.claude.json");
      expect(report.servers[0]?.status).toBe("fail");
      expect(exitCode(report)).toBe(2);
      expect(report.summary.fail).toBe(0);
      expect(report.summary.servers).toBe(0);
      const header = formatHuman(report).split("\n")[1] ?? "";
      expect(header).toContain(
        "exit 2 because of a config-level failure (MCP_SERVERS_IGNORED)",
      );
      expect(existsSync(marker)).toBe(false);
      expect(codes(report)).not.toContain("HEALTHY");
      expect(codes(report)).not.toContain("PROBE_OK");
      expect(codes(report)).not.toContain("SCHEMA_ERROR");
      expectSecretsHidden(report, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names settings.local.json and still skips a permissions-only file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-local-"));
    try {
      mkdirSync(join(root, ".claude"));
      const local = join(root, ".claude", "settings.local.json");
      writeFileSync(
        local,
        JSON.stringify({
          mcpServers: { misplaced: { command: "node", args: ["--version"] } },
        }),
      );
      const ignored = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(ignored.servers[0]?.findings[0]?.code).toBe("MCP_SERVERS_IGNORED");
      expect(ignored.servers[0]?.findings[0]?.message).toContain("settings.local.json");
      expect(names(ignored)).not.toContain("misplaced");
      expect(exitCode(ignored)).toBe(2);

      writeFileSync(local, JSON.stringify({ permissions: { allow: [] } }));
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(exitCode(skipped)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails an empty or non-object mcpServers key instead of a schema error", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-empty-"));
    try {
      mkdirSync(join(root, ".claude"));
      const settings = join(root, ".claude", "settings.json");
      writeFileSync(settings, JSON.stringify({ mcpServers: {} }));
      const empty = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(empty)).toEqual(["MCP_SERVERS_IGNORED"]);
      expect(codes(empty)).not.toContain("EMPTY_SERVERS");
      expect(exitCode(empty)).toBe(2);

      writeFileSync(settings, JSON.stringify({ mcpServers: ["not-a-map"] }));
      const array = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(array)).toEqual(["MCP_SERVERS_IGNORED"]);
      expect(codes(array)).not.toContain("SCHEMA_ERROR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails ~/.claude/settings.json and skips it with --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-user-settings-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-user-settings-home-"));
    try {
      const file = join(home, ".claude", "settings.json");
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { user: { command: "node", args: ["--version"] } },
        }),
      );
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(report.servers.map((server) => server.file)).toEqual([file]);
      expect(report.servers[0]?.scope).toBe("user");
      expect(codes(report)).toEqual(["MCP_SERVERS_IGNORED"]);
      expect(exitCode(report)).toBe(2);

      const hidden = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(codes(hidden)).toEqual(["NO_CONFIG"]);
      expect(hidden.files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still grades Gemini settings.json and .mcp.json as real server files", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-not-settings-"));
    try {
      mkdirSync(join(root, ".gemini"));
      writeFileSync(
        join(root, ".gemini", "settings.json"),
        JSON.stringify({
          mcpServers: { remote: { url: "https://example.com/mcp" } },
        }),
      );
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { local: { command: "node", args: ["--version"] } },
        }),
      );
      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(names(report).sort()).toEqual(["local", "remote"]);
      expect(codes(report)).not.toContain("MCP_SERVERS_IGNORED");
      expect(exitCode(report)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Continue configs", () => {
  it("reads project block files and the config.yaml list", async () => {
    const root = join(fixtures, "continue");
    const found = discoverConfigPaths(root, { includeUserConfig: false });
    expect(found.some((file) => file.endsWith(".continue/config.yaml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/browser.yaml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/remote.yml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/block.json"))).toBe(true);
    expect(found.some((file) => file.endsWith("/dropped.json"))).toBe(true);
    expect(found.some((file) => file.endsWith("/notes.md"))).toBe(false);

    const report = await runCheck({ root, includeUserConfig: false });
    expect(names(report).sort()).toEqual([
      "browser",
      "config-local",
      "from-block",
      "from-cursor-json",
      "no-transport",
      "remote",
    ]);
    expect(names(report)).not.toContain("from-notes");
    const byName = new Map(report.servers.map((server) => [server.name, server]));
    expect(byName.get("browser")?.transport).toBe("stdio");
    expect(byName.get("browser")?.findings.map((finding) => finding.code)).toContain(
      "UNPINNED_PACKAGE",
    );
    expect(byName.get("remote")?.transport).toBe("http");
    expect(byName.get("remote")?.status).toBe("ok");
    expect(byName.get("config-local")?.status).toBe("ok");
    expect(byName.get("from-block")?.status).toBe("ok");
    expect(byName.get("from-cursor-json")?.status).toBe("ok");
    expect(byName.get("no-transport")?.findings.map((finding) => finding.code)).toContain(
      "NO_TRANSPORT",
    );
    expect(codes(report)).not.toContain("NO_CONFIG");
    expect(codes(report)).not.toContain("PARSE_ERROR");
    expectSecretsHidden(report, [
      "continue-config-secret-do-not-print",
      "continue-server-secret-do-not-print",
      "continue-transport-secret-do-not-print",
      "notes-secret-do-not-print",
    ]);
  });

  it("skips a Continue file with no mcpServers list and ignores a missing directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-skip-"));
    try {
      mkdirSync(join(root, ".continue"));
      writeFileSync(
        join(root, ".continue", "config.yaml"),
        [
          "name: Models only",
          "version: 1.0.0",
          "schema: v1",
          "models:",
          "  - name: secret-model",
          "    apiKey: continue-models-secret-do-not-print",
          "",
        ].join("\n"),
      );
      const skipped = await runCheck({ root, includeUserConfig: false });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(skipped.summary.fail).toBe(0);
      expectSecretsHidden(skipped, ["continue-models-secret-do-not-print"]);

      const missing = mkdtempSync(join(tmpdir(), "mcp-health-continue-missing-"));
      try {
        writeFileSync(join(missing, "README.md"), "no continue directory");
        const absent = await runCheck({ root: missing, includeUserConfig: false });
        expect(codes(absent)).toEqual(["NO_CONFIG"]);
        expect(absent.summary.fail).toBe(0);

        mkdirSync(join(missing, ".continue"));
        writeFileSync(join(missing, ".continue", "mcpServers"), "not-a-directory");
        const blocked = await runCheck({ root: missing, includeUserConfig: false });
        expect(codes(blocked)).not.toContain("PARSE_ERROR");
        expect(blocked.summary.fail).toBe(0);
      } finally {
        rmSync(missing, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-string env value in a Continue list", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-env-"));
    try {
      mkdirSync(join(root, ".continue"));
      writeFileSync(
        join(root, ".continue", "config.yaml"),
        [
          "mcpServers:",
          "  - name: bad",
          "    command: node",
          "    env:",
          "      PORT: 3000",
          "",
        ].join("\n"),
      );
      const report = await runCheck({ root, includeUserConfig: false });
      expect(codes(report)).toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("HEALTHY");
      expect(formatHuman(report)).not.toContain("3000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.continue/config.yaml unless --no-user is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-continue-user-home-"));
    try {
      mkdirSync(join(home, ".continue"));
      writeFileSync(
        join(home, ".continue", "config.yaml"),
        [
          "name: User",
          "version: 1.0.0",
          "schema: v1",
          "mcpServers:",
          "  - name: user-continue",
          "    command: node",
          '    args: ["--version"]',
          "    env:",
          "      TOKEN: continue-user-secret-do-not-print",
          "",
        ].join("\n"),
      );
      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included)).toContain("user-continue");
      expectSecretsHidden(included, ["continue-user-secret-do-not-print"]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("user-continue");
      expect(skipped.files.some((file) => file.includes(".continue"))).toBe(false);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["continue-user-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Junie mcp.json", () => {
  it("discovers the project file and reuses the mcpServers parser", async () => {
    const root = join(fixtures, "junie");
    const found = discoverConfigPaths(root, { includeUserConfig: false });
    expect(found.some((file) => file.endsWith(".junie/mcp/mcp.json"))).toBe(true);
    expect(__testing.PROJECT_CANDIDATES).toContain(".junie/mcp/mcp.json");

    const report = await runCheck({ root, includeUserConfig: false });
    expect(names(report).sort()).toEqual(["context7", "remote"]);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(codes(report)).toContain("HEALTHY");
    const remote = report.servers.find((server) => server.name === "remote");
    expect(remote?.transport).toBe("http");
    expectSecretsHidden(report, ["junie-header-secret-do-not-print"]);
  });

  it("reads ~/.junie/mcp/mcp.json unless --no-user is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-junie-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-junie-user-home-"));
    const file = join(home, ".junie", "mcp", "mcp.json");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            userJunie: {
              command: "node",
              args: ["--version"],
              env: { TOKEN: "junie-user-secret-do-not-print" },
            },
          },
        }),
      );
      expect(
        __testing.userLevelPaths({ home, env: {} }).some((entry) =>
          entry.endsWith("/.junie/mcp/mcp.json"),
        ),
      ).toBe(true);

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included)).toEqual(["userJunie"]);
      expectSecretsHidden(included, ["junie-user-secret-do-not-print"]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("userJunie");
      expect(skipped.files.some((entry) => entry.includes(".junie"))).toBe(false);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["junie-user-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Cline user settings", () => {
  function writeServers(file: string, name: string, secret: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [name]: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
        },
      }),
    );
  }

  it("reads the default path, CLINE_DATA_DIR, and CLINE_MCP_SETTINGS_PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-cline-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-cline-home-"));
    const defaultFile = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    const dataDir = join(home, "cline-data");
    const dataFile = join(dataDir, "settings", "cline_mcp_settings.json");
    const decoy = join(dataDir, "data", "settings", "cline_mcp_settings.json");
    const override = join(home, "override", "cline_mcp_settings.json");
    try {
      expect(__testing.clineUserPath({ home, env: {} })).toBe(defaultFile);
      expect(__testing.clineUserPath({ home, env: { CLINE_DATA_DIR: dataDir } })).toBe(
        dataFile,
      );
      expect(
        __testing.clineUserPath({
          home,
          env: { CLINE_DATA_DIR: dataDir, CLINE_MCP_SETTINGS_PATH: override },
        }),
      ).toBe(override);

      writeServers(defaultFile, "fromDefault", "cline-default-secret-do-not-print");
      const defaults = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(defaults)).toEqual(["fromDefault"]);
      expect(defaults.summary.fail).toBe(0);
      expectSecretsHidden(defaults, ["cline-default-secret-do-not-print"]);

      writeServers(dataFile, "fromDataDir", "cline-data-secret-do-not-print");
      writeServers(decoy, "fromDecoy", "cline-decoy-secret-do-not-print");
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_DATA_DIR: dataDir },
      });
      expect(names(relocated)).toEqual(["fromDataDir"]);
      expect(names(relocated)).not.toContain("fromDefault");
      expect(names(relocated)).not.toContain("fromDecoy");
      expectSecretsHidden(relocated, [
        "cline-data-secret-do-not-print",
        "cline-decoy-secret-do-not-print",
        "cline-default-secret-do-not-print",
      ]);

      writeServers(override, "fromOverride", "cline-override-secret-do-not-print");
      const explicit = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_DATA_DIR: dataDir, CLINE_MCP_SETTINGS_PATH: override },
      });
      expect(names(explicit)).toEqual(["fromOverride"]);
      expect(explicit.files).toContain(override);
      expect(explicit.files).not.toContain(defaultFile);
      expect(explicit.files).not.toContain(dataFile);
      expectSecretsHidden(explicit, ["cline-override-secret-do-not-print"]);

      const missingOverride = join(home, "does-not-exist.json");
      const missing = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_MCP_SETTINGS_PATH: missingOverride },
      });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");
      expect(missing.summary.fail).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips the Cline file with --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-cline-nouser-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-cline-nouser-home-"));
    const file = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    try {
      writeServers(file, "fromDefault", "cline-nouser-secret-do-not-print");
      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("fromDefault");
      expect(skipped.files).not.toContain(file);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["cline-nouser-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Gemini CLI settings.json", () => {
  const secret = "gemini-secret-do-not-print";

  function writeSettings(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("reads a project server and skips a settings file with no mcpServers key", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-gemini-project-"));
    const file = join(root, ".gemini", "settings.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".gemini/settings.json");
      writeSettings(file, {
        theme: "dark",
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
          remote: { url: "https://example.com/mcp" },
        },
      });
      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.map((server) => server.name).sort()).toEqual([
        "local",
        "remote",
      ]);
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "local")?.raw.env).toEqual({
        TOKEN: secret,
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(names(report).sort()).toEqual(["local", "remote"]);
      expect(report.servers.every((server) => server.scope === "project")).toBe(true);
      expect(report.summary.fail).toBe(0);
      expect(codes(report)).not.toContain("UNKNOWN_FORMAT");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expectSecretsHidden(report, [secret]);

      writeSettings(file, { theme: "dark", selectedAuthType: secret });
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(skipped)).not.toContain("UNKNOWN_FORMAT");
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(skipped.summary.fail).toBe(0);
      expect(parseConfigFile(file).format).toBe("none");
      expectSecretsHidden(skipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.gemini/settings.json unless --no-user is set, and honors GEMINI_CLI_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-gemini-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-gemini-home-"));
    const override = join(home, "gemini-home");
    const userFile = join(home, ".gemini", "settings.json");
    const overrideFile = join(override, ".gemini", "settings.json");
    try {
      expect(__testing.geminiUserPath({ home, env: {} })).toBe(userFile);
      expect(__testing.geminiUserPath({ home, env: { GEMINI_CLI_HOME: "  " } })).toBe(
        userFile,
      );
      expect(
        __testing.geminiUserPath({ home, env: { GEMINI_CLI_HOME: override } }),
      ).toBe(overrideFile);

      writeSettings(userFile, {
        mcpServers: {
          fromHome: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
        },
      });
      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included)).toEqual(["fromHome"]);
      expect(included.files).toContain(userFile);
      expect(included.servers[0]?.scope).toBe("user");
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("fromHome");
      expect(skipped.files).not.toContain(userFile);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expectSecretsHidden(skipped, [secret]);

      writeSettings(overrideFile, {
        mcpServers: {
          fromOverride: { command: "node", args: ["--version"] },
        },
      });
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { GEMINI_CLI_HOME: override },
      });
      expect(names(relocated)).toEqual(["fromOverride"]);
      expect(relocated.files).toContain(overrideFile);
      expect(relocated.files).not.toContain(userFile);
      expect(relocated.servers[0]?.scope).toBe("user");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Codex CODEX_HOME", () => {
  const secret = "codex-home-secret-do-not-print";

  function writeToml(file: string, body: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  it("reads $CODEX_HOME/config.toml, keeps the default and the project file, and skips both with --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-codex-home-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-codex-user-"));
    const override = join(home, "codex-home");
    const userFile = join(home, ".codex", "config.toml");
    const overrideFile = join(override, "config.toml");
    const projectFile = join(root, ".codex", "config.toml");
    try {
      expect(__testing.codexUserPath({ home, env: {} })).toBe(userFile);
      expect(__testing.codexUserPath({ home, env: { CODEX_HOME: "" } })).toBe(userFile);
      expect(__testing.codexUserPath({ home, env: { CODEX_HOME: "  " } })).toBe(
        userFile,
      );
      expect(__testing.codexUserPath({ home, env: { CODEX_HOME: override } })).toBe(
        overrideFile,
      );

      writeToml(
        userFile,
        [
          "[mcp_servers.fromHome]",
          'command = "node"',
          'args = ["--version"]',
          "",
          "[mcp_servers.fromHome.env]",
          `TOKEN = "${secret}"`,
          "",
        ].join("\n"),
      );
      writeToml(
        projectFile,
        ['[mcp_servers.fromProject]', 'command = "node"', 'args = ["--version"]', ""].join(
          "\n",
        ),
      );

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included).sort()).toEqual(["fromHome", "fromProject"]);
      expect(included.files).toContain(userFile);
      expect(included.files).toContain(projectFile);
      expect(included.servers.find((server) => server.name === "fromHome")?.scope).toBe(
        "user",
      );
      expect(
        included.servers.find((server) => server.name === "fromProject")?.scope,
      ).toBe("project");
      expectSecretsHidden(included, [secret]);

      const blank = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CODEX_HOME: "   " },
      });
      expect(names(blank).sort()).toEqual(["fromHome", "fromProject"]);
      expect(blank.files).toContain(userFile);
      expect(blank.files).not.toContain(overrideFile);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).toEqual(["fromProject"]);
      expect(skipped.files).toEqual([projectFile]);
      expect(skipped.files).not.toContain(userFile);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");

      const missingOverride = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CODEX_HOME: override },
      });
      expect(names(missingOverride)).toEqual(["fromProject"]);
      expect(missingOverride.files).not.toContain(userFile);
      expect(missingOverride.files).not.toContain(overrideFile);
      expect(codes(missingOverride)).not.toContain("FILE_NOT_FOUND");

      const skippedOverride = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: { CODEX_HOME: override },
      });
      expect(names(skippedOverride)).toEqual(["fromProject"]);
      expect(codes(skippedOverride)).not.toContain("FILE_NOT_FOUND");

      writeToml(
        overrideFile,
        ['[mcp_servers.fromOverride]', 'command = "node"', 'args = ["--version"]', ""].join(
          "\n",
        ),
      );
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CODEX_HOME: override },
      });
      expect(names(relocated).sort()).toEqual(["fromOverride", "fromProject"]);
      expect(relocated.files).toContain(overrideFile);
      expect(relocated.files).toContain(projectFile);
      expect(relocated.files).not.toContain(userFile);
      expect(
        relocated.servers.find((server) => server.name === "fromOverride")?.scope,
      ).toBe("user");
      expect(
        relocated.servers.find((server) => server.name === "fromProject")?.scope,
      ).toBe("project");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Copilot project .github/mcp.json", () => {
  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("parses a mcpServers object with the existing parser", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-github-mcp-"));
    const file = join(root, ".github", "mcp.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".github/mcp.json");
      writeJson(file, {
        mcpServers: {
          playwright: {
            type: "local",
            command: "node",
            args: ["--version"],
            tools: ["*"],
          },
          remote: { url: "https://example.com/mcp" },
        },
      });

      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.map((server) => server.name).sort()).toEqual([
        "playwright",
        "remote",
      ]);
      expect(
        parsed.servers.find((server) => server.name === "playwright")?.transport,
      ).toEqual({ kind: "stdio", command: "node", args: ["--version"] });
      expect(
        parsed.servers.find((server) => server.name === "remote")?.transport,
      ).toEqual({ kind: "http", url: "https://example.com/mcp" });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([file]);
      expect(names(report).sort()).toEqual(["playwright", "remote"]);
      expect(report.servers.every((server) => server.scope === "project")).toBe(true);
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expect(report.summary.fail).toBe(0);

      writeJson(file, {
        mcpServers: { bad: { command: "node", env: { PORT: 1 } } },
      });
      const invalid = parseConfigFile(file);
      expect(invalid.format).toBe("invalid");
      const failed = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(failed)).toContain("SCHEMA_ERROR");
      expect(codes(failed)).not.toContain("NO_CONFIG");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses a bare server map: local command is stdio and url is HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-github-mcp-bare-"));
    const file = join(root, ".github", "mcp.json");
    try {
      writeJson(file, {
        playwright: {
          type: "local",
          command: "node",
          args: ["--version"],
          tools: ["*"],
        },
        context7: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          tools: ["resolve-library-id"],
        },
      });

      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      const playwright = parsed.servers.find((server) => server.name === "playwright");
      const context7 = parsed.servers.find((server) => server.name === "context7");
      expect(playwright?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(playwright?.raw.tools).toEqual(["*"]);
      expect(context7?.transport).toEqual({
        kind: "http",
        url: "https://mcp.context7.com/mcp",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(report.files).toEqual([file]);
      expect(names(report).sort()).toEqual(["context7", "playwright"]);
      expect(report.servers.every((server) => server.scope === "project")).toBe(true);
      expect(codes(report)).toContain("HEALTHY");
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(report.summary.fail).toBe(0);

      const cursorFile = join(root, "mcp.json");
      writeJson(cursorFile, {
        playwright: { type: "local", command: "node", args: ["--version"] },
      });
      expect(parseConfigFile(cursorFile).format).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats .github/mcp.json as the only config under --no-user and skips a missing file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-github-mcp-only-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-github-mcp-only-home-"));
    const file = join(root, ".github", "mcp.json");
    try {
      const missing = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");
      expect(missing.summary.fail).toBe(0);

      writeJson(file, {
        playwright: {
          type: "local",
          command: "npx",
          args: ["@playwright/mcp@latest"],
          tools: ["*"],
        },
      });
      const found = discoverConfigPaths(root, {
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(found).toEqual([file]);
      const report = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(report.files).toEqual([file]);
      expect(names(report)).toEqual(["playwright"]);
      expect(report.servers[0]?.scope).toBe("project");
      expect(report.servers[0]?.transport).toBe("stdio");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("VS Code user mcp.json and Copilot mcp-config.json", () => {
  const vscodeSecret = "vscode-user-secret-do-not-print";
  const copilotSecret = "copilot-user-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("selects the VS Code user path per platform and reads one server", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-vscode-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-vscode-home-"));
    try {
      const linux = { platform: "linux" as const, home, env: {} };
      const xdg = join(home, "xdg");
      const linuxXdg = {
        platform: "linux" as const,
        home,
        env: { XDG_CONFIG_HOME: xdg },
      };
      const mac = {
        platform: "darwin" as const,
        home,
        env: { XDG_CONFIG_HOME: xdg },
      };
      const appData = join(home, "AppData", "Roaming");
      const win = {
        platform: "win32" as const,
        home,
        env: { APPDATA: appData },
      };
      const winDefault = { platform: "win32" as const, home, env: {} };

      expect(__testing.vscodeUserMcpPath(linux)).toBe(
        join(home, ".config", "Code", "User", "mcp.json"),
      );
      expect(__testing.vscodeUserMcpPath(linuxXdg)).toBe(
        join(xdg, "Code", "User", "mcp.json"),
      );
      expect(__testing.vscodeUserMcpPath(mac)).toBe(
        join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
      );
      expect(__testing.vscodeUserMcpPath(win)).toBe(
        join(appData, "Code", "User", "mcp.json"),
      );
      expect(__testing.vscodeUserMcpPath(winDefault)).toBe(
        join(home, "AppData", "Roaming", "Code", "User", "mcp.json"),
      );
      expect(
        __testing.vscodeUserMcpPath({
          platform: "win32",
          home,
          env: { APPDATA: "  " },
        }),
      ).toBe(join(home, "AppData", "Roaming", "Code", "User", "mcp.json"));
      expect(
        __testing.vscodeUserMcpPaths({
          platform: "linux",
          home,
          env: { XDG_CONFIG_HOME: "relative/xdg" },
        }),
      ).toEqual([
        join(home, ".config", "Code", "User", "mcp.json"),
        join(home, ".config", "Code - Insiders", "User", "mcp.json"),
        join(home, ".config", "VSCodium", "User", "mcp.json"),
      ]);
      expect(__testing.vscodeUserMcpPaths(linuxXdg)).toEqual([
        join(xdg, "Code", "User", "mcp.json"),
        join(xdg, "Code - Insiders", "User", "mcp.json"),
        join(xdg, "VSCodium", "User", "mcp.json"),
      ]);
      const relativeXdg = __testing.userLevelPaths({
        platform: "linux",
        home,
        env: { XDG_CONFIG_HOME: "relative/xdg" },
      });
      expect(relativeXdg.some((entry) => entry.includes("relative/xdg"))).toBe(false);
      expect(relativeXdg).toEqual(
        expect.arrayContaining([
          join(home, ".config", "zed", "settings.json"),
          join(home, ".config", "devin", "mcp_config.json"),
          join(home, ".config", "opencode", "opencode.json"),
        ]),
      );

      const cases = [
        { label: "linux", options: linux },
        { label: "xdg", options: linuxXdg },
        { label: "mac", options: mac },
        { label: "windows", options: win },
      ];
      for (const entry of cases) {
        const file = __testing.vscodeUserMcpPath(entry.options);
        writeJson(file, {
          servers: {
            vscodeUser: {
              command: "node",
              args: ["--version"],
              env: { TOKEN: vscodeSecret },
            },
          },
        });
        const parsed = parseConfigFile(file);
        expect(parsed.format, entry.label).toBe("servers");
        expect(parsed.servers.map((server) => server.name), entry.label).toEqual([
          "vscodeUser",
        ]);
        const report = await runCheck({
          root,
          includeUserConfig: true,
          ...entry.options,
        });
        expect(names(report), entry.label).toEqual(["vscodeUser"]);
        expect(report.files, entry.label).toContain(file);
        expect(report.servers[0]?.scope, entry.label).toBe("user");
        expect(report.summary.fail, entry.label).toBe(0);
        expectSecretsHidden(report, [vscodeSecret]);
        rmSync(file);
      }

      const missing = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
        platform: "linux",
      });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Insiders and VSCodium user mcp.json unless --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-vscode-variants-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-vscode-variants-home-"));
    const appData = join(home, "AppData", "Roaming");
    try {
      const products = ["Code - Insiders", "VSCodium"] as const;
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const paths = __testing.vscodeUserMcpPaths({
          platform,
          home,
          env: platform === "win32" ? { APPDATA: " " } : { XDG_CONFIG_HOME: "" },
        });
        expect(paths).toHaveLength(3);
        for (const product of products) {
          expect(
            paths.some(
              (entry) => entry.includes(product) && entry.endsWith(join("User", "mcp.json")),
            ),
          ).toBe(true);
        }
      }

      const insiders = join(
        home,
        ".config",
        "Code - Insiders",
        "User",
        "mcp.json",
      );
      const codium = join(home, ".config", "VSCodium", "User", "mcp.json");
      writeJson(insiders, {
        servers: {
          insidersUser: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: vscodeSecret, PATH: "/opt/insiders" },
          },
        },
      });
      writeJson(codium, {
        servers: {
          codiumUser: { command: "node", args: ["--version"] },
        },
      });
      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: { XDG_CONFIG_HOME: "relative/xdg" },
      });
      expect(included.files).toContain(insiders);
      expect(included.files).toContain(codium);
      expect(included.files.some((file) => file.includes("relative/xdg"))).toBe(false);
      expect(
        included.servers.find((server) => server.name === "insidersUser")?.scope,
      ).toBe("user");
      expect(
        included.servers.find((server) => server.name === "codiumUser")?.scope,
      ).toBe("user");
      expect(codes(included)).not.toContain("FILE_NOT_FOUND");
      expect(codes(included)).not.toContain("COMMAND_NOT_FOUND");
      expectSecretsHidden(included, [vscodeSecret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        platform: "linux",
        env: {},
      });
      expect(skipped.files).not.toContain(insiders);
      expect(skipped.files).not.toContain(codium);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);

      expect(
        __testing.vscodeUserMcpPaths({
          platform: "win32",
          home,
          env: { APPDATA: appData },
        }),
      ).toEqual([
        join(appData, "Code", "User", "mcp.json"),
        join(appData, "Code - Insiders", "User", "mcp.json"),
        join(appData, "VSCodium", "User", "mcp.json"),
      ]);
      expect(
        __testing.vscodeUserMcpPaths({ platform: "darwin", home, env: {} }),
      ).toEqual([
        join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
        join(
          home,
          "Library",
          "Application Support",
          "Code - Insiders",
          "User",
          "mcp.json",
        ),
        join(home, "Library", "Application Support", "VSCodium", "User", "mcp.json"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Copilot mcp-config.json unless --no-user is set, and honors COPILOT_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-copilot-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-copilot-home-"));
    const copilotHome = join(home, "copilot-home");
    const userFile = join(home, ".copilot", "mcp-config.json");
    const overrideFile = join(copilotHome, "mcp-config.json");
    const vscodeFile = join(home, ".config", "Code", "User", "mcp.json");
    try {
      expect(__testing.copilotUserPath({ home, env: {} })).toBe(userFile);
      expect(__testing.copilotUserPath({ home, env: { COPILOT_HOME: " " } })).toBe(
        userFile,
      );
      expect(
        __testing.copilotUserPath({ home, env: { COPILOT_HOME: copilotHome } }),
      ).toBe(overrideFile);

      writeJson(userFile, {
        mcpServers: {
          copilotUser: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: copilotSecret },
          },
        },
      });
      writeJson(vscodeFile, {
        servers: {
          vscodeUser: { command: "node", args: ["--version"] },
        },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: {},
      });
      expect(names(included).sort()).toEqual(["copilotUser", "vscodeUser"]);
      expect(parseConfigFile(userFile).format).toBe("mcpServers");
      expect(
        included.servers.find((server) => server.name === "copilotUser")?.scope,
      ).toBe("user");
      expect(
        included.servers.find((server) => server.name === "vscodeUser")?.scope,
      ).toBe("user");
      expectSecretsHidden(included, [copilotSecret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        platform: "linux",
        env: {},
      });
      expect(names(skipped)).not.toContain("copilotUser");
      expect(names(skipped)).not.toContain("vscodeUser");
      expect(skipped.files).not.toContain(userFile);
      expect(skipped.files).not.toContain(vscodeFile);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expectSecretsHidden(skipped, [copilotSecret]);

      writeJson(overrideFile, {
        mcpServers: {
          fromCopilotHome: { command: "node", args: ["--version"] },
        },
      });
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: { COPILOT_HOME: copilotHome },
      });
      expect(names(relocated).sort()).toEqual(["fromCopilotHome", "vscodeUser"]);
      expect(relocated.files).toContain(overrideFile);
      expect(relocated.files).not.toContain(userFile);
      expect(
        relocated.servers.find((server) => server.name === "fromCopilotHome")?.scope,
      ).toBe("user");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity mcp_config.json", () => {
  const secret = "antigravity-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("reads the project file, skips a missing file and a file with no mcpServers key, and does not rewrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-antigravity-project-"));
    const file = join(root, ".agents", "mcp_config.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".agents/mcp_config.json");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const original = JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
          remote: { serverUrl: "https://example.com/mcp" },
          alias: { url: "https://example.com/alias" },
          floating: { command: "npx", args: ["-y", "@scope/antigravity-server"] },
          paused: { command: "definitely-missing-binary-xyz", disabled: true },
        },
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, original);

      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });
      expect(parsed.servers.find((server) => server.name === "alias")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/alias",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([file]);
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.transport).toBe("stdio");
      expect(byName.get("local")?.scope).toBe("project");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("remote")?.scope).toBe("project");
      expect(byName.get("alias")?.transport).toBe("http");
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual([
        "DISABLED",
      ]);
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expectSecretsHidden(report, [secret]);

      writeJson(file, { theme: "dark", selectedAuthType: secret });
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(skipped)).not.toContain("UNKNOWN_FORMAT");
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(skipped.summary.fail).toBe(0);
      expect(parseConfigFile(file).format).toBe("none");
      expectSecretsHidden(skipped, [secret]);

      writeJson(file, { mcpServers: {} });
      const empty = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(empty)).toEqual(["EMPTY_SERVERS"]);
      expect(codes(empty)).not.toContain("SKIPPED_NO_MCP");

      writeJson(file, { mcpServers: ["not-a-map"] });
      const invalid = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(invalid)).toContain("SCHEMA_ERROR");
      expect(codes(invalid)).not.toContain("SKIPPED_NO_MCP");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.gemini/config/mcp_config.json unless --no-user, and ignores GEMINI_CLI_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-antigravity-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-antigravity-home-"));
    const override = join(home, "gemini-home");
    const projectFile = join(root, ".agents", "mcp_config.json");
    const projectGemini = join(root, ".gemini", "settings.json");
    const userFile = join(home, ".gemini", "config", "mcp_config.json");
    const geminiUser = join(home, ".gemini", "settings.json");
    const geminiOverride = join(override, ".gemini", "settings.json");
    try {
      expect(__testing.antigravityUserPath({ home, env: {} })).toBe(userFile);
      expect(
        __testing.antigravityUserPath({ home, env: { GEMINI_CLI_HOME: override } }),
      ).toBe(userFile);
      expect(
        __testing.antigravityUserPath({ home, env: { GEMINI_CLI_HOME: "  " } }),
      ).toBe(userFile);
      expect(__testing.geminiUserPath({ home, env: {} })).toBe(geminiUser);
      expect(__testing.geminiUserPath({ home, env: { GEMINI_CLI_HOME: override } })).toBe(
        geminiOverride,
      );

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userOriginal = JSON.stringify({
        mcpServers: {
          fromAntigravity: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
        },
      });
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(userFile, userOriginal);
      writeJson(projectFile, {
        mcpServers: {
          fromProject: { command: "node", args: ["--version"] },
        },
      });
      writeJson(projectGemini, {
        mcpServers: {
          fromGeminiProject: { httpUrl: "https://example.com/gemini" },
        },
      });
      writeJson(geminiUser, {
        mcpServers: {
          fromGeminiHome: { command: "node", args: ["--version"] },
        },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(readFileSync(userFile, "utf8")).toBe(userOriginal);
      expect(names(included).sort()).toEqual([
        "fromAntigravity",
        "fromGeminiHome",
        "fromGeminiProject",
        "fromProject",
      ]);
      expect(included.files).toContain(userFile);
      expect(included.files).toContain(projectFile);
      expect(included.files).toContain(geminiUser);
      expect(
        included.servers.find((server) => server.name === "fromAntigravity")?.scope,
      ).toBe("user");
      expect(
        included.servers.find((server) => server.name === "fromProject")?.scope,
      ).toBe("project");
      expect(
        included.servers.find((server) => server.name === "fromGeminiProject")?.transport,
      ).toBe("http");
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped).sort()).toEqual(["fromGeminiProject", "fromProject"]);
      expect(skipped.files).not.toContain(userFile);
      expect(skipped.files).not.toContain(geminiUser);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(codes(skipped)).not.toContain("NO_CONFIG");

      writeJson(geminiOverride, {
        mcpServers: {
          fromGeminiOverride: { command: "node", args: ["--version"] },
        },
      });
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { GEMINI_CLI_HOME: override },
      });
      expect(names(relocated).sort()).toEqual([
        "fromAntigravity",
        "fromGeminiOverride",
        "fromGeminiProject",
        "fromProject",
      ]);
      expect(relocated.files).toContain(userFile);
      expect(relocated.files).toContain(geminiOverride);
      expect(relocated.files).not.toContain(geminiUser);
      expect(
        relocated.servers.find((server) => server.name === "fromAntigravity")?.scope,
      ).toBe("user");
      expect(
        relocated.servers.find((server) => server.name === "fromGeminiOverride")?.scope,
      ).toBe("user");

      writeJson(userFile, { other: secret });
      const userSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { GEMINI_CLI_HOME: override },
      });
      expect(names(userSkipped)).not.toContain("fromAntigravity");
      expect(codes(userSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(userSkipped)).not.toContain("NO_MCP_SECTION");
      expectSecretsHidden(userSkipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Kiro mcp.json", () => {
  const secret = "kiro-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("reads the workspace file, skips a missing file and a file with no mcpServers key, and does not rewrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-kiro-project-"));
    const file = join(root, ".kiro", "settings", "mcp.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".kiro/settings/mcp.json");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const original = JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
            envFile: ".env.missing-kiro",
          },
          remote: { url: "https://example.com/mcp" },
          floating: { command: "npx", args: ["-y", "@scope/kiro-server"] },
          paused: { command: "definitely-missing-binary-xyz", disabled: true },
        },
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, original);

      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([file]);
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.transport).toBe("stdio");
      expect(byName.get("local")?.scope).toBe("project");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("local")?.findings.map((finding) => finding.code)).not.toContain(
        "ENV_FILE_MISSING",
      );
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("remote")?.scope).toBe("project");
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual([
        "DISABLED",
      ]);
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expect(codes(report)).not.toContain("ENV_FILE_MISSING");
      expectSecretsHidden(report, [secret]);

      writeJson(file, { powers: [secret], theme: "dark" });
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(skipped)).not.toContain("UNKNOWN_FORMAT");
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(skipped.summary.fail).toBe(0);
      expect(parseConfigFile(file).format).toBe("none");
      expectSecretsHidden(skipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.kiro/settings/mcp.json unless --no-user, and reports a duplicate name twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-kiro-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-kiro-home-"));
    const appData = join(home, "AppData", "Roaming");
    const projectFile = join(root, ".kiro", "settings", "mcp.json");
    const userFile = join(home, ".kiro", "settings", "mcp.json");
    try {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(
          __testing.kiroUserPath({
            platform,
            home,
            env: { APPDATA: appData, KIRO_HOME: join(home, "kiro-home") },
          }),
        ).toBe(userFile);
      }

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userOriginal = JSON.stringify({
        mcpServers: {
          shared: {
            command: "npx",
            args: ["-y", "@scope/kiro-user"],
            env: { TOKEN: secret },
          },
          fromUser: { command: "node", args: ["--version"] },
        },
      });
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(userFile, userOriginal);
      writeJson(projectFile, {
        mcpServers: {
          shared: { command: "node", args: ["--version"] },
          fromProject: { url: "https://example.com/mcp" },
        },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { APPDATA: appData, KIRO_HOME: join(home, "kiro-home") },
      });
      expect(readFileSync(userFile, "utf8")).toBe(userOriginal);
      expect(readFileSync(projectFile, "utf8")).toContain("fromProject");
      const shared = included.servers.filter((server) => server.name === "shared");
      expect(shared.map((server) => server.scope).sort()).toEqual(["project", "user"]);
      expect(shared.map((server) => server.file).sort()).toEqual(
        [projectFile, userFile].sort(),
      );
      expect(names(included).filter((name) => name === "fromUser")).toEqual(["fromUser"]);
      expect(names(included).filter((name) => name === "fromProject")).toEqual([
        "fromProject",
      ]);
      expect(
        shared.find((server) => server.scope === "user")?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expect(
        shared.find((server) => server.scope === "project")?.findings.map((finding) => finding.code),
      ).toEqual(["HEALTHY"]);
      expect(included.files).toContain(userFile);
      expect(included.files).toContain(projectFile);
      expect(included.files.some((file) => file.includes(`${appData}`))).toBe(false);
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped).sort()).toEqual(["fromProject", "shared"]);
      expect(skipped.files).toEqual([projectFile]);
      expect(skipped.files).not.toContain(userFile);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(codes(skipped)).not.toContain("NO_CONFIG");

      writeJson(userFile, { other: secret });
      const userSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(userSkipped)).not.toContain("fromUser");
      expect(codes(userSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(userSkipped)).not.toContain("NO_MCP_SECTION");
      expectSecretsHidden(userSkipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OpenCode mcp config", () => {
  const secret = "opencode-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("reads project json and jsonc, skips a missing file and a file with no mcp key, and does not rewrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-opencode-project-"));
    const jsonFile = join(root, "opencode.json");
    const jsoncFile = join(root, "opencode.jsonc");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain("opencode.json");
      expect(__testing.PROJECT_CANDIDATES).toContain("opencode.jsonc");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const original = `{
        // comment with "mcp" inside it
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
          "local": {
            "type": "local",
            "command": ["node", "--version"],
            "environment": { "TOKEN": "${secret}" },
          },
          "remote": {
            "type": "remote",
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer your-token-here" },
          },
          "floating": {
            "type": "local",
            "command": ["npx", "-y", "@scope/opencode-server"],
          },
          "paused": {
            "type": "local",
            "command": ["definitely-missing-binary-xyz"],
            "enabled": false,
          },
          "placeholder": {
            "type": "local",
            "command": ["node", "--version"],
            "environment": { "API_TOKEN": "your-token-here" },
          },
          "optIn": { "enabled": true },
        },
        "tools": { "local": false, "note": "${secret}" },
        "agent": { "build": { "model": "openai/gpt-5" } },
        "plugin": ["example"],
      }`;
      writeFileSync(jsoncFile, original);

      const parsed = parseConfigFile(jsoncFile);
      expect(parsed.format).toBe("opencode");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "local")?.raw.env).toEqual({
        TOKEN: secret,
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });
      expect(parsed.servers.map((server) => server.name)).not.toContain("build");
      expect(parsed.servers.map((server) => server.name)).not.toContain("example");
      expect(parsed.servers.map((server) => server.name)).not.toContain("optIn");
      expect(parsed.servers.map((server) => server.name)).not.toContain("$schema");

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(jsoncFile, "utf8")).toBe(original);
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([jsoncFile]);
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.scope).toBe("project");
      expect(byName.get("local")?.transport).toBe("stdio");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toContain(
        "PLACEHOLDER_HEADER",
      );
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual([
        "DISABLED",
      ]);
      expect(byName.get("placeholder")?.findings.map((finding) => finding.code)).toContain(
        "PLACEHOLDER_ENV",
      );
      expect(names(report)).not.toContain("build");
      expect(names(report)).not.toContain("example");
      expect(names(report)).not.toContain("optIn");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expect(codes(report)).not.toContain("UNKNOWN_FORMAT");
      expectSecretsHidden(report, [secret]);

      writeFileSync(
        jsonFile,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          tools: { local: false },
          agent: { build: { model: secret } },
          plugin: ["example"],
        }),
      );
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(discoverConfigPaths(root, { includeUserConfig: false }).sort()).toEqual(
        [jsonFile, jsoncFile].sort(),
      );
      expect(codes(skipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(skipped)).not.toContain("UNKNOWN_FORMAT");
      expect(names(skipped)).toContain("local");
      expect(names(skipped)).not.toContain("build");
      expect(parseConfigFile(jsonFile).format).toBe("none");
      expectSecretsHidden(skipped, [secret]);

      writeJson(jsonFile, { mcp: {} });
      const empty = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(empty)).toContain("EMPTY_SERVERS");

      writeJson(jsonFile, { mcp: [] });
      const invalid = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(invalid)).toContain("SCHEMA_ERROR");
      expect(codes(invalid)).not.toContain("SKIPPED_NO_MCP");

      writeJson(jsonFile, {
        mcp: { bad: { type: "local", command: "npx", args: ["-y", "pkg"] } },
      });
      const stringCommand = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(stringCommand)).toContain("SCHEMA_ERROR");
      expect(parseConfigFile(jsonFile).error).toContain("command");

      writeJson(jsonFile, {
        mcp: {
          badEnv: {
            type: "local",
            command: ["node", "--version"],
            environment: { PORT: 1 },
          },
        },
      });
      const numericEnv = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(numericEnv)).toContain("SCHEMA_ERROR");
      expect(parseConfigFile(jsonFile).error).toContain("environment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the user file unless --no-user, and OPENCODE_CONFIG replaces it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-opencode-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-opencode-home-"));
    const xdg = join(home, "xdg");
    const appData = join(home, "AppData", "Roaming");
    const projectFile = join(root, "opencode.json");
    const userJson = join(home, ".config", "opencode", "opencode.json");
    const userJsonc = join(home, ".config", "opencode", "opencode.jsonc");
    const xdgJson = join(xdg, "opencode", "opencode.json");
    const custom = join(home, "custom-opencode.json");
    try {
      const defaults = [userJson, userJsonc];
      expect(__testing.opencodeUserPaths({ home, env: {} })).toEqual(defaults);
      expect(
        __testing.opencodeUserPaths({ home, env: { OPENCODE_CONFIG: "  " } }),
      ).toEqual(defaults);
      expect(__testing.opencodeUserPaths({ home, env: { XDG_CONFIG_HOME: xdg } })).toEqual([
        join(xdg, "opencode", "opencode.json"),
        join(xdg, "opencode", "opencode.jsonc"),
      ]);
      expect(
        __testing.opencodeUserPaths({ home, env: { XDG_CONFIG_HOME: "relative/xdg" } }),
      ).toEqual(defaults);
      expect(__testing.opencodeUserPaths({ home, env: { XDG_CONFIG_HOME: "  " } })).toEqual(
        defaults,
      );
      expect(
        __testing.opencodeUserPaths({
          home,
          env: { OPENCODE_CONFIG: custom, XDG_CONFIG_HOME: xdg },
        }),
      ).toEqual([custom]);
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(
          __testing.opencodeUserPaths({
            platform,
            home,
            env: { APPDATA: appData },
          }),
        ).toEqual(defaults);
      }

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userOriginal = [
        "{",
        "  // user jsonc",
        "  \"mcp\": {",
        "    \"fromUser\": {",
        "      \"type\": \"local\",",
        `      "command": ["node", "--version"],`,
        "      \"environment\": { \"TOKEN\": \"" + secret + "\" }",
        "    }",
        "  },",
        "  \"tools\": { \"fromUser\": false }",
        "}",
        "",
      ].join("\n");
      mkdirSync(dirname(userJsonc), { recursive: true });
      writeFileSync(userJsonc, userOriginal);
      writeJson(projectFile, {
        mcp: {
          shared: {
            type: "local",
            command: ["node", "--version"],
          },
          fromProject: {
            type: "remote",
            url: "https://example.com/mcp",
          },
        },
        plugin: [secret],
      });
      writeJson(userJson, {
        mcp: {
          shared: {
            type: "local",
            command: ["npx", "-y", "@scope/opencode-user"],
          },
        },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { APPDATA: appData },
      });
      expect(readFileSync(userJsonc, "utf8")).toBe(userOriginal);
      const shared = included.servers.filter((server) => server.name === "shared");
      expect(shared.map((server) => server.scope).sort()).toEqual(["project", "user"]);
      expect(included.files).toContain(userJson);
      expect(included.files).toContain(userJsonc);
      expect(included.files).toContain(projectFile);
      expect(
        included.servers.find((server) => server.name === "fromUser")?.scope,
      ).toBe("user");
      expect(
        included.servers.find((server) => server.name === "fromProject")?.transport,
      ).toBe("http");
      expect(names(included)).not.toContain("build");
      expect(
        shared
          .find((server) => server.scope === "user")
          ?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: { OPENCODE_CONFIG: custom },
      });
      expect(names(skipped).sort()).toEqual(["fromProject", "shared"]);
      expect(skipped.files).toEqual([projectFile]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(codes(skipped)).not.toContain("NO_CONFIG");

      writeJson(custom, {
        mcp: {
          fromCustom: {
            type: "local",
            command: ["node", "--version"],
            environment: { TOKEN: secret },
          },
        },
        agent: { plan: { model: secret } },
      });
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { OPENCODE_CONFIG: custom, XDG_CONFIG_HOME: xdg },
      });
      expect(readFileSync(custom, "utf8")).toContain("fromCustom");
      expect(names(relocated).sort()).toEqual(["fromCustom", "fromProject", "shared"]);
      expect(relocated.files).toContain(custom);
      expect(relocated.files).toContain(projectFile);
      expect(relocated.files).not.toContain(userJson);
      expect(relocated.files).not.toContain(userJsonc);
      expect(
        relocated.servers.find((server) => server.name === "fromCustom")?.scope,
      ).toBe("user");
      expectSecretsHidden(relocated, [secret]);

      writeJson(xdgJson, {
        mcp: {
          fromXdg: { type: "remote", url: "https://example.com/xdg" },
        },
      });
      const xdgReport = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { XDG_CONFIG_HOME: xdg },
      });
      expect(xdgReport.files).toContain(xdgJson);
      expect(xdgReport.files).not.toContain(userJson);
      expect(
        xdgReport.servers.find((server) => server.name === "fromXdg")?.scope,
      ).toBe("user");
      expect(xdgReport.servers.find((server) => server.name === "fromXdg")?.transport).toBe(
        "http",
      );

      writeJson(custom, { tools: { kept: secret }, plugin: [] });
      const customSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { OPENCODE_CONFIG: custom },
      });
      expect(names(customSkipped)).not.toContain("fromCustom");
      expect(codes(customSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(customSkipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(customSkipped)).not.toContain("UNKNOWN_FORMAT");
      expectSecretsHidden(customSkipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Amazon Q Developer mcp config", () => {
  const secret = "amazonq-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  it("reads workspace mcp.json and default.json, skips a missing file and a default.json with no mcpServers, and does not rewrite them", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-amazonq-project-"));
    const mcpFile = join(root, ".amazonq", "mcp.json");
    const defaultFile = join(root, ".amazonq", "default.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".amazonq/mcp.json");
      expect(__testing.PROJECT_CANDIDATES).toContain(".amazonq/default.json");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const pinned = JSON.stringify({
        mcpServers: { local: { command: "node", args: ["--version"] } },
      });
      mkdirSync(dirname(mcpFile), { recursive: true });
      writeFileSync(mcpFile, pinned);
      const healthy = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(mcpFile, "utf8")).toBe(pinned);
      expect(exitCode(healthy)).toBe(0);
      expect(healthy.servers.find((server) => server.name === "local")?.scope).toBe(
        "project",
      );
      expect(
        healthy.servers.find((server) => server.name === "local")?.findings.map(
          (finding) => finding.code,
        ),
      ).toEqual(["HEALTHY"]);

      const original = JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
            envFile: ".env.missing-amazonq",
          },
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer your-token-here" },
          },
          floating: { command: "npx", args: ["-y", "@scope/amazonq-server"] },
          pinnedPkg: { command: "npx", args: ["-y", "@scope/amazonq-server@1.2.3"] },
          paused: { command: "definitely-missing-binary-xyz", disabled: true },
        },
      });
      writeFileSync(mcpFile, original);
      const defaultOriginal = JSON.stringify({
        name: "q-developer",
        tools: ["fs_read"],
        useLegacyMcpJson: true,
        note: secret,
      });
      writeFileSync(defaultFile, defaultOriginal);

      const parsed = parseConfigFile(mcpFile);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });
      expect(parseConfigFile(defaultFile).format).toBe("none");

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(mcpFile, "utf8")).toBe(original);
      expect(readFileSync(defaultFile, "utf8")).toBe(defaultOriginal);
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.scope).toBe("project");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("local")?.findings.map((finding) => finding.code)).not.toContain(
        "ENV_FILE_MISSING",
      );
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toContain(
        "PLACEHOLDER_HEADER",
      );
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("pinnedPkg")?.findings.map((finding) => finding.code)).not.toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual([
        "DISABLED",
      ]);
      expect(codes(report)).toContain("SKIPPED_NO_MCP");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expect(codes(report)).not.toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("NO_MCP_SECTION");
      expect(codes(report)).not.toContain("ENV_FILE_MISSING");
      expectSecretsHidden(report, [secret]);

      rmSync(mcpFile);
      const onlyDefault = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(onlyDefault)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(onlyDefault)).not.toContain("NO_CONFIG");
      expect(codes(onlyDefault)).not.toContain("SCHEMA_ERROR");
      expect(codes(onlyDefault)).not.toContain("NO_MCP_SECTION");
      expect(onlyDefault.summary.fail).toBe(0);
      expectSecretsHidden(onlyDefault, [secret]);

      writeFileSync(mcpFile, "{ not json");
      const malformed = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(malformed)).toContain("PARSE_ERROR");
      expect(readFileSync(mcpFile, "utf8")).toBe("{ not json");

      writeJson(defaultFile, {
        tools: [secret],
        mcpServers: { fromDefault: { command: "node", args: ["--version"] } },
      });
      const fromDefault = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(fromDefault.servers.find((server) => server.name === "fromDefault")?.scope).toBe(
        "project",
      );
      expect(
        fromDefault.servers
          .find((server) => server.name === "fromDefault")
          ?.findings.map((finding) => finding.code),
      ).toEqual(["HEALTHY"]);
      expectSecretsHidden(fromDefault, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.aws/amazonq unless --no-user, and ignores %APPDATA%", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-amazonq-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-amazonq-home-"));
    const appData = join(home, "AppData", "Roaming");
    const userMcp = join(home, ".aws", "amazonq", "mcp.json");
    const userDefault = join(home, ".aws", "amazonq", "default.json");
    const projectMcp = join(root, ".amazonq", "mcp.json");
    try {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(
          __testing.amazonQUserPaths({
            platform,
            home,
            env: { APPDATA: appData },
          }),
        ).toEqual([userMcp, userDefault]);
      }

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userOriginal = JSON.stringify({
        mcpServers: {
          fromUser: {
            command: "npx",
            args: ["-y", "@scope/amazonq-user"],
            env: { TOKEN: secret },
          },
        },
      });
      mkdirSync(dirname(userMcp), { recursive: true });
      writeFileSync(userMcp, userOriginal);
      writeJson(userDefault, {
        tools: ["fs_read"],
        mcpServers: {
          fromDefault: {
            url: "https://example.com/mcp",
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      });
      writeJson(projectMcp, {
        mcpServers: { fromProject: { command: "node", args: ["--version"] } },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { APPDATA: appData },
      });
      expect(readFileSync(userMcp, "utf8")).toBe(userOriginal);
      expect(included.servers.find((server) => server.name === "fromUser")?.scope).toBe("user");
      expect(included.servers.find((server) => server.name === "fromDefault")?.scope).toBe(
        "user",
      );
      expect(included.servers.find((server) => server.name === "fromDefault")?.transport).toBe(
        "http",
      );
      expect(included.servers.find((server) => server.name === "fromProject")?.scope).toBe(
        "project",
      );
      expect(
        included.servers
          .find((server) => server.name === "fromUser")
          ?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expect(included.files).toContain(userMcp);
      expect(included.files).toContain(userDefault);
      expect(included.files).toContain(projectMcp);
      expect(included.files.some((file) => file.includes(appData))).toBe(false);
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).toEqual(["fromProject"]);
      expect(skipped.files).toEqual([projectMcp]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(codes(skipped)).not.toContain("NO_CONFIG");

      writeJson(userDefault, { tools: [secret], useLegacyMcpJson: false });
      const userSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(userSkipped)).not.toContain("fromDefault");
      expect(names(userSkipped)).toContain("fromUser");
      expect(codes(userSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(userSkipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(userSkipped)).not.toContain("SCHEMA_ERROR");
      expectSecretsHidden(userSkipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Amp settings", () => {
  const secret = "amp-secret-do-not-print";
  const setSecret = "amp-set-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  function rendered(report: HealthReport): string {
    return [
      formatHuman(report),
      formatJson(report),
      formatAnnotations(report),
      JSON.stringify(buildSarif(report)),
    ].join("\n");
  }

  it("reads project json and jsonc, skips a file with no amp.mcpServers, and does not rewrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-amp-project-"));
    const jsonFile = join(root, ".amp", "settings.json");
    const jsoncFile = join(root, ".amp", "settings.jsonc");
    const previous = {
      MCP_HEALTH_AMP_TOKEN: process.env.MCP_HEALTH_AMP_TOKEN,
      MCP_HEALTH_AMP_BASE: process.env.MCP_HEALTH_AMP_BASE,
    };
    delete process.env.MCP_HEALTH_AMP_TOKEN;
    delete process.env.MCP_HEALTH_AMP_BASE;
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".amp/settings.json");
      expect(__testing.PROJECT_CANDIDATES).toContain(".amp/settings.jsonc");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const pinned = JSON.stringify({
        "amp.mcpServers": { local: { command: "node", args: ["--version"] } },
        "amp.url": "https://ampcode.com/",
      });
      mkdirSync(dirname(jsonFile), { recursive: true });
      writeFileSync(jsonFile, pinned);
      const healthy = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(jsonFile, "utf8")).toBe(pinned);
      expect(exitCode(healthy)).toBe(0);
      expect(healthy.servers.find((server) => server.name === "local")?.scope).toBe("project");
      expect(
        healthy.servers.find((server) => server.name === "local")?.findings.map(
          (finding) => finding.code,
        ),
      ).toEqual(["HEALTHY"]);

      const original = `{
        // comment with "amp.mcpServers" inside it
        "amp.url": "https://ampcode.com/",
        "amp.mcpServers": {
          "local": {
            "command": "node",
            "args": ["--version"],
            "env": { "TOKEN": "${secret}" },
          },
          "remote": {
            "url": "\${MCP_HEALTH_AMP_BASE}/mcp",
            "headers": { "Authorization": "Bearer \${MCP_HEALTH_AMP_TOKEN}" },
          },
          "placeholder": {
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer your-token-here" },
          },
        },
        "mcpServers": {
          "not-amp": { "command": "definitely-missing-binary-xyz" },
        },
      }`;
      writeFileSync(jsoncFile, original);
      rmSync(jsonFile);

      const parsed = parseConfigFile(jsoncFile);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "${MCP_HEALTH_AMP_BASE}/mcp",
      });
      expect(parsed.servers.map((server) => server.name)).not.toContain("not-amp");

      const unset = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(jsoncFile, "utf8")).toBe(original);
      expect(unset.servers.find((server) => server.name === "local")?.scope).toBe("project");
      expect(
        unset.servers.find((server) => server.name === "local")?.findings.map(
          (finding) => finding.code,
        ),
      ).toEqual(["HEALTHY"]);
      expect(
        unset.servers.find((server) => server.name === "remote")?.findings.map(
          (finding) => finding.code,
        ),
      ).toContain("UNRESOLVED_VARIABLE");
      expect(
        unset.servers.find((server) => server.name === "placeholder")?.findings.map(
          (finding) => finding.code,
        ),
      ).toContain("PLACEHOLDER_HEADER");
      expect(names(unset)).not.toContain("not-amp");
      expect(codes(unset)).not.toContain("COMMAND_NOT_FOUND");
      expect(codes(unset)).not.toContain("NO_CONFIG");
      expect(codes(unset)).not.toContain("FILE_NOT_FOUND");
      expect(rendered(unset)).not.toContain(secret);
      expect(rendered(unset)).not.toContain(setSecret);

      process.env.MCP_HEALTH_AMP_TOKEN = setSecret;
      process.env.MCP_HEALTH_AMP_BASE = "https://example.test";
      const set = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(
        set.servers.find((server) => server.name === "remote")?.findings.map(
          (finding) => finding.code,
        ),
      ).toEqual(["HEALTHY"]);
      const dumped = rendered(set);
      expect(dumped).not.toContain(secret);
      expect(dumped).not.toContain(setSecret);
      expect(dumped).not.toContain("https://example.test");

      writeJson(jsonFile, {
        "amp.url": "https://ampcode.com/",
        "amp.mcpPermissions": [],
        mcpServers: { notAmp: { command: "definitely-missing-binary-xyz" } },
        note: secret,
      });
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(skipped)).not.toContain("SCHEMA_ERROR");
      expect(codes(skipped)).not.toContain("COMMAND_NOT_FOUND");
      expect(names(skipped)).not.toContain("notAmp");
      expect(parseConfigFile(jsonFile).format).toBe("none");
      expect(rendered(skipped)).not.toContain(secret);

      writeJson(jsonFile, { "amp.mcpServers": [] });
      const invalid = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(invalid)).toContain("SCHEMA_ERROR");
      expect(parseConfigFile(jsonFile).error).toContain("amp.mcpServers");

      const broken = "{ not json";
      writeFileSync(jsonFile, broken);
      const malformed = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(malformed)).toContain("PARSE_ERROR");
      expect(readFileSync(jsonFile, "utf8")).toBe(broken);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.config/amp unless --no-user, on every platform, and ignores XDG and %APPDATA%", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-amp-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-amp-home-"));
    const xdg = join(home, "xdg");
    const appData = join(home, "AppData", "Roaming");
    const projectFile = join(root, ".amp", "settings.json");
    const userJson = join(home, ".config", "amp", "settings.json");
    const userJsonc = join(home, ".config", "amp", "settings.jsonc");
    try {
      const defaults = [userJson, userJsonc];
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(
          __testing.ampUserPaths({
            platform,
            home,
            env: { APPDATA: appData, XDG_CONFIG_HOME: xdg },
          }),
        ).toEqual(defaults);
      }

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userOriginal = [
        "{",
        "  // user jsonc",
        '  "amp.mcpServers": {',
        '    "fromUser": {',
        '      "command": "node",',
        '      "args": ["--version"],',
        `      "env": { "TOKEN": "${secret}" }`,
        "    }",
        "  },",
        '  "amp.url": "https://ampcode.com/"',
        "}",
        "",
      ].join("\n");
      mkdirSync(dirname(userJsonc), { recursive: true });
      writeFileSync(userJsonc, userOriginal);
      writeJson(userJson, {
        "amp.mcpServers": {
          shared: { command: "npx", args: ["-y", "@scope/amp-user"] },
        },
      });
      writeJson(projectFile, {
        "amp.mcpServers": {
          shared: { command: "node", args: ["--version"] },
          fromProject: { url: "https://example.com/mcp" },
        },
        "amp.showCosts": secret,
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { APPDATA: appData, XDG_CONFIG_HOME: xdg },
      });
      expect(readFileSync(userJsonc, "utf8")).toBe(userOriginal);
      const shared = included.servers.filter((server) => server.name === "shared");
      expect(shared.map((server) => server.scope).sort()).toEqual(["project", "user"]);
      expect(included.files).toContain(userJson);
      expect(included.files).toContain(userJsonc);
      expect(included.files).toContain(projectFile);
      expect(included.servers.find((server) => server.name === "fromUser")?.scope).toBe("user");
      expect(included.servers.find((server) => server.name === "fromProject")?.transport).toBe(
        "http",
      );
      expect(
        shared.find((server) => server.scope === "user")?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expect(rendered(included)).not.toContain(secret);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: { XDG_CONFIG_HOME: xdg, APPDATA: appData },
      });
      expect(names(skipped).sort()).toEqual(["fromProject", "shared"]);
      expect(skipped.files).toEqual([projectFile]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(codes(skipped)).not.toContain("NO_CONFIG");

      writeJson(userJson, { "amp.url": secret });
      writeJson(userJsonc, { "amp.mcpPermissions": [secret] });
      const userSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(userSkipped)).not.toContain("fromUser");
      expect(codes(userSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(userSkipped)).not.toContain("NO_MCP_SECTION");
      expect(rendered(userSkipped)).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Goose extensions", () => {
  const secret = "goose-secret-do-not-print";

  function rendered(report: HealthReport): string {
    return [
      formatHuman(report),
      formatJson(report),
      formatAnnotations(report),
      JSON.stringify(buildSarif(report)),
    ].join("\n");
  }

  it("reads the user config.yaml, skips builtin and platform extensions, and does not read secrets or a project .goose path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-goose-root-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-goose-home-"));
    const xdg = join(home, "xdg");
    const appData = join(home, "AppData", "Roaming");
    const gooseRoot = join(home, "goose-root");
    const userFile = join(home, ".config", "goose", "config.yaml");
    const xdgFile = join(xdg, "goose", "config.yaml");
    const windowsFile = join(appData, "Block", "goose", "config", "config.yaml");
    const projectFile = join(root, ".goose", "config.yaml");
    try {
      expect(__testing.PROJECT_CANDIDATES).not.toContain(".goose/config.yaml");
      const unixDefault = join(home, ".config", "goose", "config.yaml");
      for (const platform of ["darwin", "linux"] as const) {
        expect(__testing.gooseUserPath({ platform, home, env: {} })).toBe(unixDefault);
        expect(
          __testing.gooseUserPath({
            platform,
            home,
            env: { XDG_CONFIG_HOME: "  ", GOOSE_PATH_ROOT: gooseRoot },
          }),
        ).toBe(unixDefault);
        expect(
          __testing.gooseUserPath({
            platform,
            home,
            env: { XDG_CONFIG_HOME: "relative/xdg", GOOSE_PATH_ROOT: gooseRoot },
          }),
        ).toBe(unixDefault);
        expect(
          __testing.gooseUserPath({ platform, home, env: { XDG_CONFIG_HOME: xdg } }),
        ).toBe(xdgFile);
      }
      expect(
        __testing.gooseUserPath({
          platform: "win32",
          home,
          env: { APPDATA: appData, XDG_CONFIG_HOME: xdg, GOOSE_PATH_ROOT: gooseRoot },
        }),
      ).toBe(windowsFile);
      expect(__testing.gooseUserPath({ platform: "win32", home, env: {} })).toBe(
        join(home, "AppData", "Roaming", "Block", "goose", "config", "config.yaml"),
      );

      mkdirSync(dirname(projectFile), { recursive: true });
      writeFileSync(
        projectFile,
        [
          "extensions:",
          "  from-project-goose:",
          "    type: stdio",
          "    cmd: node",
          "    args: ['--version']",
          "",
        ].join("\n"),
      );
      const projectOnly = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(codes(projectOnly)).toEqual(["NO_CONFIG"]);
      expect(projectOnly.files).not.toContain(projectFile);
      expect(names(projectOnly)).not.toContain("from-project-goose");

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const pinned = [
        "extensions:",
        "  local:",
        "    type: stdio",
        "    cmd: node",
        "    args: ['--version']",
        "    enabled: true",
        "",
      ].join("\n");
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(userFile, pinned);
      const healthy = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { GOOSE_PATH_ROOT: gooseRoot },
      });
      expect(readFileSync(userFile, "utf8")).toBe(pinned);
      expect(exitCode(healthy)).toBe(0);
      expect(healthy.servers.find((server) => server.name === "local")?.scope).toBe("user");
      expect(healthy.files).toContain(userFile);
      expect(healthy.files).not.toContain(projectFile);
      expect(names(healthy)).not.toContain("from-project-goose");

      const original = [
        "provider: openai",
        "extensions:",
        "  local:",
        "    type: stdio",
        "    cmd: node",
        "    args: ['--version']",
        "    enabled: true",
        "    envs:",
        `      TOKEN: ${secret}`,
        "  floating:",
        "    type: stdio",
        "    cmd: npx",
        "    args: ['-y', '@scope/goose-server']",
        "  pinned:",
        "    type: stdio",
        "    cmd: npx",
        "    args: ['-y', '@scope/goose-server@1.2.3']",
        "  remote:",
        "    type: streamable_http",
        "    uri: https://example.com/mcp",
        "    headers:",
        "      Authorization: Bearer your-token-here",
        "    envs:",
        "      API_TOKEN: your-token-here",
        "  paused:",
        "    type: stdio",
        "    cmd: definitely-missing-binary-xyz",
        "    enabled: false",
        "    envs:",
        `      TOKEN: ${secret}`,
        "  developer:",
        "    type: builtin",
        "    enabled: true",
        "  computercontroller:",
        "    type: platform",
        "    enabled: true",
        "",
      ].join("\n");
      writeFileSync(userFile, original);
      const secretsFile = join(dirname(userFile), "secrets.yaml");
      const permissionFile = join(dirname(userFile), "permission.yaml");
      const sessionFile = join(dirname(userFile), "sessions", "session.json");
      writeFileSync(secretsFile, `OPENAI_API_KEY: ${secret}\n`);
      writeFileSync(permissionFile, `tools:\n  note: ${secret}\n`);
      mkdirSync(dirname(sessionFile), { recursive: true });
      writeFileSync(sessionFile, JSON.stringify({ secret }));

      const parsed = parseConfigFile(userFile);
      expect(parsed.format).toBe("goose");
      expect(parsed.servers.find((server) => server.name === "local")?.transport).toEqual({
        kind: "stdio",
        command: "node",
        args: ["--version"],
      });
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });
      expect(parsed.servers.map((server) => server.name)).not.toContain("developer");
      expect(parsed.servers.map((server) => server.name)).not.toContain("computercontroller");

      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(readFileSync(userFile, "utf8")).toBe(original);
      expect(readFileSync(secretsFile, "utf8")).toContain(secret);
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.scope).toBe("user");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("pinned")?.findings.map((finding) => finding.code)).not.toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toContain(
        "PLACEHOLDER_HEADER",
      );
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toContain(
        "PLACEHOLDER_ENV",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual(["DISABLED"]);
      expect(names(report)).not.toContain("developer");
      expect(names(report)).not.toContain("computercontroller");
      expect(names(report)).not.toContain("from-project-goose");
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(codes(report)).not.toContain("COMMAND_NOT_FOUND");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(report.files).toEqual([userFile]);
      expect(report.files).not.toContain(secretsFile);
      expect(report.files).not.toContain(permissionFile);
      expect(report.files).not.toContain(sessionFile);
      expect(report.files).not.toContain(projectFile);
      expect(rendered(report)).not.toContain(secret);

      const skippedUser = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(codes(skippedUser)).toEqual(["NO_CONFIG"]);
      expect(skippedUser.files).not.toContain(userFile);
      expect(rendered(skippedUser)).not.toContain(secret);

      writeFileSync(userFile, `provider: openai\nnote: ${secret}\n`);
      const noExtensions = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(noExtensions)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(noExtensions)).not.toContain("NO_MCP_SECTION");
      expect(codes(noExtensions)).not.toContain("NO_CONFIG");
      expect(parseConfigFile(userFile).format).toBe("none");
      expect(rendered(noExtensions)).not.toContain(secret);

      writeFileSync(
        userFile,
        ["extensions:", "  developer:", "    type: builtin", "    enabled: true", ""].join("\n"),
      );
      const builtins = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(builtins)).toContain("EMPTY_SERVERS");
      expect(codes(builtins)).not.toContain("NO_TRANSPORT");
      expect(builtins.summary.fail).toBe(0);
      expect(names(builtins)).not.toContain("developer");

      writeFileSync(userFile, "extensions: [\n");
      const malformed = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(malformed)).toContain("PARSE_ERROR");
      expect(readFileSync(userFile, "utf8")).toBe("extensions: [\n");

      writeFileSync(
        userFile,
        ["extensions:", "  old:", "    type: sse", "    uri: https://example.com/sse", ""].join(
          "\n",
        ),
      );
      const sse = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(sse)).toContain("SCHEMA_ERROR");
      expect(parseConfigFile(userFile).error).toContain("type");
      expect(codes(sse)).not.toContain("NO_TRANSPORT");

      mkdirSync(dirname(xdgFile), { recursive: true });
      writeFileSync(
        xdgFile,
        [
          "extensions:",
          "  fromXdg:",
          "    type: streamable_http",
          "    uri: https://example.com/xdg",
          `    envs: { TOKEN: ${secret} }`,
          "",
        ].join("\n"),
      );
      const fromXdg = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { XDG_CONFIG_HOME: xdg, GOOSE_PATH_ROOT: gooseRoot },
      });
      expect(fromXdg.files).toContain(xdgFile);
      expect(fromXdg.files).not.toContain(userFile);
      expect(fromXdg.servers.find((server) => server.name === "fromXdg")?.scope).toBe("user");
      expect(fromXdg.servers.find((server) => server.name === "fromXdg")?.transport).toBe(
        "http",
      );
      expect(rendered(fromXdg)).not.toContain(secret);

      mkdirSync(dirname(windowsFile), { recursive: true });
      writeFileSync(
        windowsFile,
        [
          "extensions:",
          "  fromWindows:",
          "    type: stdio",
          "    cmd: node",
          "    args: ['--version']",
          "",
        ].join("\n"),
      );
      const fromWindows = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "win32",
        env: { APPDATA: appData, XDG_CONFIG_HOME: xdg },
      });
      expect(fromWindows.files).toContain(windowsFile);
      expect(fromWindows.files).not.toContain(xdgFile);
      expect(fromWindows.files).not.toContain(userFile);
      expect(fromWindows.servers.find((server) => server.name === "fromWindows")?.scope).toBe(
        "user",
      );
      expect(
        fromWindows.servers
          .find((server) => server.name === "fromWindows")
          ?.findings.map((finding) => finding.code),
      ).toEqual(["HEALTHY"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Roo Code mcp.json", () => {
  const secret = "roo-secret-do-not-print";

  function writeJson(file: string, body: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }

  function settingsFile(base: string, product: string, name = "mcp_settings.json"): string {
    return join(
      base,
      product,
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "settings",
      name,
    );
  }

  it("reads .roo/mcp.json, skips a file with no mcpServers key, and does not rewrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-roo-project-"));
    const file = join(root, ".roo", "mcp.json");
    const nested = join(root, "services", "api", ".roo", "mcp.json");
    try {
      expect(__testing.PROJECT_CANDIDATES).toContain(".roo/mcp.json");
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([]);

      const missing = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");

      const original = JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
            envFile: ".env.missing-roo",
            alwaysAllow: ["search"],
          },
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            alwaysAllow: ["search"],
          },
          floating: { command: "npx", args: ["-y", "@scope/roo-server"] },
          paused: { command: "definitely-missing-binary-xyz", disabled: true },
        },
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, original);
      writeJson(nested, {
        mcpServers: { nested: { command: "node", args: ["--version"] } },
      });

      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "remote")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(discoverConfigPaths(root, { includeUserConfig: false })).toEqual([file]);
      expect(
        discoverConfigPaths(root, { includeUserConfig: false, recursive: true }).sort(),
      ).toEqual([file, nested].sort());
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.scope).toBe("project");
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("local")?.findings.map((finding) => finding.code)).not.toContain(
        "ENV_FILE_MISSING",
      );
      expect(byName.get("remote")?.transport).toBe("http");
      expect(byName.get("floating")?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(byName.get("paused")?.findings.map((finding) => finding.code)).toEqual(["DISABLED"]);
      expect(codes(report)).not.toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("ENV_FILE_MISSING");
      expect(codes(report)).not.toContain("FILE_NOT_FOUND");
      expectSecretsHidden(report, [secret]);

      const nestedReport = await runCheck({
        root,
        includeUserConfig: false,
        recursive: true,
        env: {},
      });
      expect(names(nestedReport)).toContain("nested");
      expect(
        nestedReport.servers.find((server) => server.name === "nested")?.scope,
      ).toBe("project");

      writeJson(file, { alwaysAllow: [secret], theme: "dark" });
      const skipped = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(skipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");
      expect(parseConfigFile(file).format).toBe("none");
      expectSecretsHidden(skipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads editor globalStorage unless --no-user, including the legacy filename", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-roo-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-roo-home-"));
    const xdg = join(home, "xdg");
    const appData = join(home, "AppData", "Roaming");
    const projectFile = join(root, ".roo", "mcp.json");
    try {
      expect(__testing.rooUserPaths({ platform: "linux", home, env: {} })).toContain(
        settingsFile(join(home, ".config"), "Code"),
      );
      expect(
        __testing.rooUserPaths({ platform: "linux", home, env: { XDG_CONFIG_HOME: "relative/xdg" } }),
      ).toContain(settingsFile(join(home, ".config"), "Cursor"));
      expect(
        __testing.rooUserPaths({ platform: "linux", home, env: { XDG_CONFIG_HOME: xdg } }),
      ).toEqual(
        expect.arrayContaining([
          settingsFile(xdg, "Code"),
          settingsFile(xdg, "Code - Insiders"),
          settingsFile(xdg, "VSCodium"),
          settingsFile(xdg, "Cursor"),
          settingsFile(xdg, "Code", "cline_mcp_settings.json"),
        ]),
      );
      expect(
        __testing.rooUserPaths({ platform: "darwin", home, env: { XDG_CONFIG_HOME: xdg } }),
      ).toContain(
        settingsFile(join(home, "Library", "Application Support"), "Cursor"),
      );
      expect(
        __testing.rooUserPaths({
          platform: "win32",
          home,
          env: { APPDATA: "  ", XDG_CONFIG_HOME: xdg },
        }),
      ).toContain(settingsFile(join(home, "AppData", "Roaming"), "Code"));
      expect(
        __testing.rooUserPaths({ platform: "win32", home, env: { APPDATA: appData } }),
      ).toContain(settingsFile(appData, "VSCodium", "cline_mcp_settings.json"));
      expect(
        __testing.rooUserPaths({ platform: "linux", home, env: {} }).some((entry) =>
          entry.includes(".windsurf") || entry.includes("vscode-server"),
        ),
      ).toBe(false);

      const absent = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: {},
      });
      expect(codes(absent)).toEqual(["NO_CONFIG"]);
      expect(codes(absent)).not.toContain("FILE_NOT_FOUND");

      const userFile = settingsFile(join(home, ".config"), "Code");
      const legacyFile = settingsFile(join(home, ".config"), "Cursor", "cline_mcp_settings.json");
      const userOriginal = JSON.stringify({
        mcpServers: {
          shared: {
            command: "npx",
            args: ["-y", "@scope/roo-user"],
            env: { TOKEN: secret },
          },
          fromUser: { command: "node", args: ["--version"] },
        },
      });
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(userFile, userOriginal);
      writeJson(legacyFile, {
        mcpServers: { legacy: { command: "node", args: ["--version"] } },
      });
      writeJson(projectFile, {
        mcpServers: {
          shared: { command: "node", args: ["--version"] },
          fromProject: { url: "https://example.com/mcp" },
        },
      });

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: { XDG_CONFIG_HOME: " " },
      });
      expect(readFileSync(userFile, "utf8")).toBe(userOriginal);
      const shared = included.servers.filter((server) => server.name === "shared");
      expect(shared.map((server) => server.scope).sort()).toEqual(["project", "user"]);
      expect(names(included)).toContain("fromUser");
      expect(names(included)).toContain("fromProject");
      expect(names(included)).toContain("legacy");
      expect(included.servers.find((server) => server.name === "legacy")?.scope).toBe("user");
      expect(included.files).toContain(userFile);
      expect(included.files).toContain(legacyFile);
      expect(included.files).toContain(projectFile);
      expect(
        shared.find((server) => server.scope === "user")?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expectSecretsHidden(included, [secret]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        platform: "linux",
        env: {},
      });
      expect(names(skipped).sort()).toEqual(["fromProject", "shared"]);
      expect(skipped.files).toEqual([projectFile]);
      expect(codes(skipped)).not.toContain("FILE_NOT_FOUND");

      writeJson(userFile, { other: secret });
      const userSkipped = await runCheck({
        root,
        includeUserConfig: true,
        home,
        platform: "linux",
        env: {},
      });
      expect(codes(userSkipped)).toContain("SKIPPED_NO_MCP");
      expect(codes(userSkipped)).not.toContain("NO_MCP_SECTION");
      expectSecretsHidden(userSkipped, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
