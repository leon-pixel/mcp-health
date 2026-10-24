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
