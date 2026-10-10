import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isVersionPinned,
  extractNpxPackage,
  resolveCommandOnPath,
  commandNeedsShell,
} from "./check.js";
import { parseConfigFile } from "./parse.js";
import { omitStaleHealthy, runCheck } from "./run.js";
import { splitPackageSpec, isRangePin, isVersionDrift } from "./npm.js";
import { discoverConfigPaths, __testing } from "./discover.js";
import { expandString } from "./vars.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "fixtures");

describe("isVersionPinned", () => {
  it("detects pinned and unpinned packages", () => {
    expect(isVersionPinned("pkg@1.2.3")).toBe(true);
    expect(isVersionPinned("@scope/pkg@1.0.0")).toBe(true);
    expect(isVersionPinned("pkg")).toBe(false);
    expect(isVersionPinned("@scope/pkg")).toBe(false);
  });
});

describe("extractNpxPackage", () => {
  it("reads package from npx args", () => {
    expect(extractNpxPackage("npx", ["-y", "foo@1.0.0"])).toBe("foo@1.0.0");
    expect(extractNpxPackage("npm", ["exec", "-y", "bar@2"])).toBe("bar@2");
  });
});

describe("splitPackageSpec", () => {
  it("splits scoped and unscoped specs", () => {
    expect(splitPackageSpec("@a/b@1.2.3")).toEqual({
      name: "@a/b",
      version: "1.2.3",
    });
    expect(splitPackageSpec("lodash@4.17.21")).toEqual({
      name: "lodash",
      version: "4.17.21",
    });
    expect(splitPackageSpec("@a/b")).toEqual({
      name: "@a/b",
      version: undefined,
    });
  });
});

describe("isVersionDrift", () => {
  it("flags mismatch and floating tags", () => {
    expect(isVersionDrift("1.0.0", "1.0.0")).toBe(false);
    expect(isVersionDrift("1.0.0", "1.0.1")).toBe(true);
    expect(isVersionDrift("latest", "1.0.0")).toBe(true);
  });

  it("accepts a semver range that includes npm latest", () => {
    expect(isVersionDrift("^2025.1.0", "2025.4.0")).toBe(false);
    expect(isVersionDrift("^2025.1.0", "2025.1.0")).toBe(false);
    expect(isVersionDrift("~1.2.3", "1.2.9")).toBe(false);
    expect(isRangePin("^2025.1.0")).toBe(true);
    expect(isRangePin("1.2.3")).toBe(false);
    expect(isVersionPinned("pkg@^2025.1.0")).toBe(true);
  });

  it("still flags a range that excludes the next major", () => {
    expect(isVersionDrift("^2025.1.0", "2026.0.0")).toBe(true);
    expect(isVersionDrift("~1.2.3", "1.3.0")).toBe(true);
  });
});

describe("discoverConfigPaths", () => {
  it("exposes project candidates including claude settings", () => {
    expect(__testing.PROJECT_CANDIDATES).toContain(".claude/settings.json");
    expect(__testing.PROJECT_CANDIDATES).toContain(".windsurf/mcp_config.json");
    expect(__testing.PROJECT_CANDIDATES).toContain(".zed/settings.json");
    expect(__testing.PROJECT_CANDIDATES).toContain(".codex/config.toml");
    expect(__testing.claudeDesktopPaths().length).toBeGreaterThan(0);
  });

  it("finds fixture configs without user paths", () => {
    const found = discoverConfigPaths(join(fixtures, "healthy"), {
      includeUserConfig: false,
    });
    expect(found.some((p) => p.endsWith(".cursor/mcp.json"))).toBe(true);
  });

  it("lists Windsurf, Zed, and Codex user paths and skips them with --no-user", () => {
    const normalized = __testing.userLevelPaths().map((p) => p.replace(/\\/g, "/"));
    expect(
      normalized.some((p) => p.endsWith("/.codeium/windsurf/mcp_config.json")),
    ).toBe(true);
    expect(normalized.some((p) => p.endsWith("/devin/mcp_config.json"))).toBe(true);
    expect(
      normalized.some(
        (p) => p.endsWith("/zed/settings.json") || p.endsWith("/Zed/settings.json"),
      ),
    ).toBe(true);
    expect(normalized.some((p) => p.endsWith("/.codex/config.toml"))).toBe(true);

    const empty = mkdtempSync(join(tmpdir(), "mcp-health-empty-"));
    try {
      expect(
        discoverConfigPaths(empty, { includeUserConfig: false }),
      ).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("parseConfigFile", () => {
  it("parses mcpServers fixture", () => {
    const parsed = parseConfigFile(
      join(fixtures, "healthy", ".cursor", "mcp.json"),
    );
    expect(parsed.format).toBe("mcpServers");
    expect(parsed.servers.map((s) => s.name).sort()).toEqual([
      "filesystem",
      "remote-demo",
    ]);
  });

  it("parses Windsurf serverUrl, Zed command objects, and Codex tables", () => {
    const windsurf = parseConfigFile(
      join(fixtures, "windsurf", ".windsurf", "mcp_config.json"),
    );
    expect(windsurf.format).toBe("mcpServers");
    expect(windsurf.servers[0]).toMatchObject({
      name: "cascade",
      transport: { kind: "http", url: "https://example.com/mcp" },
    });

    const zed = parseConfigFile(join(fixtures, "zed", ".zed", "settings.json"));
    expect(zed.format).toBe("contextServers");
    expect(zed.servers[0]).toMatchObject({
      name: "zed-local",
      transport: { kind: "stdio", command: "node", args: ["--version"] },
    });

    const codex = parseConfigFile(join(fixtures, "codex", ".codex", "config.toml"));
    expect(codex.format).toBe("codex");
    expect(codex.servers[0]).toMatchObject({
      name: "remote",
      transport: { kind: "http", url: "https://example.com/mcp" },
    });
  });

  it("keeps HTTP headers on the parsed server", () => {
    const parsed = parseConfigFile(join(fixtures, "http-headers", "mcp.json"));
    expect(parsed.format).toBe("mcpServers");
    expect(parsed.servers[0]?.raw.headers).toEqual({
      Authorization: "Bearer ${env:MCP_TOKEN}",
    });
  });
});

describe("runCheck", () => {
  it("reports healthy fixture without fails", async () => {
    const report = await runCheck({
      root: join(fixtures, "healthy"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.servers).toBeGreaterThan(0);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("HEALTHY");
  });

  it("flags broken fixture issues", async () => {
    const report = await runCheck({
      root: join(fixtures, "issues"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBeGreaterThan(0);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("COMMAND_NOT_FOUND");
    expect(codes).toContain("UNPINNED_PACKAGE");
    expect(codes).toContain("NO_TRANSPORT");
    expect(codes).toContain("BAD_URL");
  });

  it("reads claude settings mcpServers", async () => {
    const report = await runCheck({
      root: join(fixtures, "claude-settings"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.servers.some((s) => s.name === "memory")).toBe(true);
  });

  it("probes fixture stdio server successfully", async () => {
    const report = await runCheck({
      root: join(fixtures, "probe-ok"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 5000,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("PROBE_OK");
    expect(codes).toContain("TOOLS_OK");
    expect(report.servers.every((server) => server.status === "ok")).toBe(true);
  });

  it("scans Windsurf, Zed, and Codex project configs", async () => {
    for (const name of ["windsurf", "zed", "codex"] as const) {
      const root = join(fixtures, name);
      const found = discoverConfigPaths(root, { includeUserConfig: false });
      expect(found.every((p) => p.startsWith(root))).toBe(true);
      expect(found.length).toBeGreaterThan(0);
      const report = await runCheck({ root, includeUserConfig: false });
      expect(report.summary.fail).toBe(0);
      expect(report.summary.warn).toBe(0);
      const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
      expect(codes).toContain("HEALTHY");
      expect(codes).not.toContain("NO_CONFIG");
      expect(codes).not.toContain("NO_TRANSPORT");
      expect(codes).not.toContain("COMMAND_NOT_FOUND");
    }
  });

  it("treats a missing config and a Codex file without mcp_servers as non-failures", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcp-health-missing-"));
    const codex = mkdtempSync(join(tmpdir(), "mcp-health-codex-"));
    try {
      const missing = await runCheck({
        root: empty,
        includeUserConfig: false,
      });
      expect(missing.servers[0]?.findings.map((f) => f.code)).toEqual(["NO_CONFIG"]);
      expect(missing.summary.fail).toBe(0);

      const file = join(codex, ".codex", "config.toml");
      mkdirSync(join(codex, ".codex"), { recursive: true });
      writeFileSync(file, 'model = "gpt-5"\n');
      const skipped = await runCheck({
        root: codex,
        includeUserConfig: false,
      });
      expect(skipped.servers[0]?.findings.map((f) => f.code)).toEqual([
        "SKIPPED_NO_MCP",
      ]);
      expect(skipped.summary.fail).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });

  it("reports a schema error for a numeric env value", async () => {
    const report = await runCheck({
      root: join(fixtures, "numeric-env"),
      includeUserConfig: false,
    });
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("SCHEMA_ERROR");
    expect(codes).not.toContain("NO_MCP_SECTION");
    const message = report.servers
      .flatMap((s) => s.findings)
      .map((f) => f.message)
      .join("\n");
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/number/);
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it("flags unresolved input and env variables instead of HEALTHY", async () => {
    const report = await runCheck({
      root: join(fixtures, "unresolved-var"),
      includeUserConfig: false,
    });
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("UNRESOLVED_VARIABLE");
    expect(codes).not.toContain("HEALTHY");
    const message = report.servers
      .flatMap((s) => s.findings)
      .map((f) => f.message)
      .join("\n");
    expect(message).toContain("${input:script}");
    expect(message).toContain("${env:MCP_HEALTH_UNSET_VAR_SHOULD_NOT_EXIST}");
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it("still skips settings files that simply have no MCP section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-settings-"));
    try {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify({ theme: "dark" }));
      const report = await runCheck({
        root: dir,
        files: [file],
        includeUserConfig: false,
      });
      expect(report.servers[0]?.findings.map((f) => f.code)).toEqual([
        "SKIPPED_NO_MCP",
      ]);
      expect(report.summary.fail).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expandString", () => {
  it("expands workspace and env variables and leaves input variables", () => {
    const root = "/work/app";
    expect(expandString("${workspaceFolder}/server.mjs", { root })).toBe(
      "/work/app/server.mjs",
    );
    expect(
      expandString("x ${env:MCP_HEALTH_MARK_SRC} y", {
        root,
        env: { MCP_HEALTH_MARK_SRC: "ok" },
      }),
    ).toBe("x ok y");
    expect(expandString("${input:token}", { root, env: {} })).toBe(
      "${input:token}",
    );
    expect(expandString("${env:MISSING}", { root, env: {} })).toBe(
      "${env:MISSING}",
    );
  });
});

describe("resolveCommandOnPath", () => {
  it("matches PATHEXT on Windows and not on other platforms", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-path-"));
    try {
      writeFileSync(join(dir, "npx.CMD"), "@echo off\r\n");
      expect(
        resolveCommandOnPath(
          "npx",
          { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          "win32",
        ),
      ).toBe(join(dir, "npx.CMD"));
      expect(
        resolveCommandOnPath(
          "npx",
          { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          "linux",
        ),
      ).toBeUndefined();
      expect(commandNeedsShell(join(dir, "npx.CMD"), "win32")).toBe(true);
      expect(commandNeedsShell(join(dir, "npx.EXE"), "win32")).toBe(false);
      expect(commandNeedsShell(join(dir, "npx.CMD"), "linux")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("omitStaleHealthy", () => {
  it("drops HEALTHY when a warning was added later", () => {
    const findings = omitStaleHealthy([
      {
        severity: "ok",
        code: "HEALTHY",
        message: "No issues detected",
      },
      {
        severity: "warn",
        code: "NPM_DRIFT",
        message: "Pinned range ^1.0.0 does not include npm latest 2.0.0",
      },
    ]);
    expect(findings.map((f) => f.code)).toEqual(["NPM_DRIFT"]);
  });
});
