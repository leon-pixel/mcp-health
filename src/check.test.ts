import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isVersionPinned,
  extractNpxPackage,
  resolveCommandOnPath,
  commandLookupEnv,
  commandNeedsShell,
} from "./check.js";
import { parseConfigFile } from "./parse.js";
import { omitStaleHealthy, runCheck } from "./run.js";
import { exitCode, formatHuman } from "./report.js";
import { splitPackageSpec, isRangePin, isVersionDrift } from "./npm.js";
import { discoverConfigPaths, __testing } from "./discover.js";
import { expandString } from "./vars.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const fixtures = join(repo, "fixtures");

describe("isVersionPinned", () => {
  it("detects pinned and unpinned packages", () => {
    expect(isVersionPinned("pkg@1.2.3")).toBe(true);
    expect(isVersionPinned("@scope/pkg@1.0.0")).toBe(true);
    expect(isVersionPinned("pkg@^2025.1.0")).toBe(true);
    expect(isVersionPinned("pkg")).toBe(false);
    expect(isVersionPinned("@scope/pkg")).toBe(false);
    expect(isVersionPinned("@playwright/mcp@latest")).toBe(false);
    expect(isVersionPinned("some-server@Latest")).toBe(false);
    expect(isVersionPinned("some-server@next")).toBe(false);
    expect(isVersionPinned("some-server@*")).toBe(false);
  });
});

describe("extractNpxPackage", () => {
  it("reads package from npx args", () => {
    expect(extractNpxPackage("npx", ["-y", "foo@1.0.0"])).toBe("foo@1.0.0");
    expect(extractNpxPackage("npm", ["exec", "-y", "bar@2"])).toBe("bar@2");
    expect(extractNpxPackage("/usr/local/bin/npx", ["-y", "foo@1.0.0"])).toBe(
      "foo@1.0.0",
    );
    expect(extractNpxPackage("npm.cmd", ["exec", "--yes", "bar@2"])).toBe("bar@2");
  });

  it("reads uvx, bunx, pnpm, and yarn packages and ignores launcher flags", () => {
    expect(extractNpxPackage("uvx", ["mcp-server-git"])).toBe("mcp-server-git");
    expect(extractNpxPackage("uvx", ["mcp-server-git@1.2.3"])).toBe(
      "mcp-server-git@1.2.3",
    );
    expect(
      extractNpxPackage("uvx", ["--from", "mcp-server-git@1.2.3", "mcp-server-git"]),
    ).toBe("mcp-server-git@1.2.3");
    expect(extractNpxPackage("uvx", ["--from=mcp-server-git@1.2.3"])).toBe(
      "mcp-server-git@1.2.3",
    );
    expect(extractNpxPackage("uvx", ["-y", "--yes", "--quiet", "mcp-server-git"])).toBe(
      "mcp-server-git",
    );
    expect(extractNpxPackage("uvx", ["--python", "3.12", "mcp-server-git"])).toBe(
      "mcp-server-git",
    );
    expect(extractNpxPackage("uvx", ["--with", "extra", "mcp-server-git"])).toBe(
      "mcp-server-git",
    );
    expect(extractNpxPackage("uvx.exe", ["pkg@1"])).toBe("pkg@1");

    expect(extractNpxPackage("bunx", ["--quiet", "some-mcp-server"])).toBe(
      "some-mcp-server",
    );
    expect(extractNpxPackage("bunx", ["some-mcp-server@1.2.3"])).toBe(
      "some-mcp-server@1.2.3",
    );

    expect(extractNpxPackage("pnpm", ["dlx", "some-mcp-server"])).toBe("some-mcp-server");
    expect(extractNpxPackage("pnpm", ["dlx", "--yes", "some-mcp-server@1.2.3"])).toBe(
      "some-mcp-server@1.2.3",
    );
    expect(extractNpxPackage("pnpm", ["exec", "-y", "some-mcp-server"])).toBe(
      "some-mcp-server",
    );
    expect(extractNpxPackage("pnpm", ["--dir", "/tmp", "dlx", "--quiet", "pkg"])).toBe(
      "pkg",
    );
    expect(extractNpxPackage("pnpm", ["dlx", "--dir", "/tmp", "pkg"])).toBe("pkg");
    expect(extractNpxPackage("pnpm", ["install", "left-pad"])).toBeUndefined();
    expect(extractNpxPackage("pnpm.cmd", ["dlx", "pkg@1.2.3"])).toBe("pkg@1.2.3");

    expect(extractNpxPackage("yarn", ["dlx", "--quiet", "some-mcp-server"])).toBe(
      "some-mcp-server",
    );
    expect(extractNpxPackage("yarn", ["dlx", "some-mcp-server@1.2.3"])).toBe(
      "some-mcp-server@1.2.3",
    );
    expect(extractNpxPackage("yarn", ["some-mcp-server"])).toBeUndefined();
    expect(extractNpxPackage("yarn", ["dlx"])).toBeUndefined();
    expect(extractNpxPackage("pnpm", ["exec"])).toBeUndefined();
  });
});

describe("unpinned uvx, bunx, pnpm, and yarn launches", () => {
  function codesFor(report: Awaited<ReturnType<typeof runCheck>>, name: string): string[] {
    return (
      report.servers
        .find((server) => server.name === name)
        ?.findings.map((finding) => finding.code) ?? []
    );
  }

  function messageFor(
    report: Awaited<ReturnType<typeof runCheck>>,
    name: string,
    code: string,
  ): string | undefined {
    return report.servers
      .find((server) => server.name === name)
      ?.findings.find((finding) => finding.code === code)?.message;
  }

  const servers = {
    "uvx-loose": { command: "uvx", args: ["mcp-server-git"] },
    "uvx-pinned": {
      command: "uvx",
      args: ["--from", "mcp-server-git@1.2.3", "mcp-server-git"],
    },
    "uvx-arg-pinned": { command: "uvx", args: ["mcp-server-git@1.2.3"] },
    "pnpm-loose": { command: "pnpm", args: ["dlx", "--quiet", "some-mcp-server"] },
    "pnpm-pinned": { command: "pnpm", args: ["dlx", "some-mcp-server@9.9.9"] },
    "pnpm-exec": { command: "pnpm", args: ["exec", "-y", "other-mcp"] },
    "pnpm-install": { command: "pnpm", args: ["install", "left-pad"] },
    "bunx-loose": { command: "bunx", args: ["-y", "some-bun-server"] },
    "yarn-loose": { command: "yarn", args: ["dlx", "--yes", "some-yarn-server"] },
    "yarn-pinned": { command: "yarn", args: ["dlx", "some-yarn-server@1.0.0"] },
  };

  function writeLaunchers(): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-launchers-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    return dir;
  }

  it("warns when uvx or pnpm dlx has no version and stays quiet when pinned", async () => {
    const dir = writeLaunchers();
    const fetchSpy = vi.fn(() => {
      throw new Error("offline test contacted the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const report = await runCheck({ root: dir, includeUserConfig: false, env: {} });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(messageFor(report, "uvx-loose", "UNPINNED_PACKAGE")).toBe(
        'Package "mcp-server-git" is not version-pinned (recommend name@version)',
      );
      expect(codesFor(report, "uvx-pinned")).not.toContain("UNPINNED_PACKAGE");
      expect(codesFor(report, "uvx-arg-pinned")).not.toContain("UNPINNED_PACKAGE");
      expect(messageFor(report, "pnpm-loose", "UNPINNED_PACKAGE")).toBe(
        'Package "some-mcp-server" is not version-pinned (recommend name@version)',
      );
      expect(codesFor(report, "pnpm-pinned")).not.toContain("UNPINNED_PACKAGE");
      expect(messageFor(report, "pnpm-exec", "UNPINNED_PACKAGE")).toBe(
        'Package "other-mcp" is not version-pinned (recommend name@version)',
      );
      expect(codesFor(report, "pnpm-install")).not.toContain("UNPINNED_PACKAGE");
      expect(messageFor(report, "bunx-loose", "UNPINNED_PACKAGE")).toBe(
        'Package "some-bun-server" is not version-pinned (recommend name@version)',
      );
      expect(messageFor(report, "yarn-loose", "UNPINNED_PACKAGE")).toBe(
        'Package "some-yarn-server" is not version-pinned (recommend name@version)',
      );
      expect(codesFor(report, "yarn-pinned")).not.toContain("UNPINNED_PACKAGE");
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looks up the launcher package online and reports NPM_LOOKUP_FAILED on a registry miss", async () => {
    const dir = writeLaunchers();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      urls.push(String(input));
      return new Response("missing", { status: 404 });
    });
    try {
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
        online: true,
      });
      expect(urls).toContain("https://registry.npmjs.org/mcp-server-git/latest");
      expect(urls).toContain("https://registry.npmjs.org/some-mcp-server/latest");
      expect(urls).not.toContain("https://registry.npmjs.org/dlx/latest");
      expect(urls).not.toContain("https://registry.npmjs.org/--quiet/latest");
      expect(messageFor(report, "uvx-pinned", "NPM_LOOKUP_FAILED")).toContain(
        "npm registry HTTP 404 for mcp-server-git",
      );
      expect(codesFor(report, "uvx-pinned")).not.toContain("UNPINNED_PACKAGE");
      expect(codesFor(report, "pnpm-loose")).toContain("NPM_LOOKUP_FAILED");
      expect(codesFor(report, "pnpm-loose")).toContain("UNPINNED_PACKAGE");
      expect(codesFor(report, "pnpm-install")).not.toContain("NPM_LOOKUP_FAILED");
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(isVersionDrift("Latest", "1.0.0")).toBe(true);
    expect(isRangePin("Latest")).toBe(false);
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

  it("adds the Windows MSIX Claude Desktop config only when that file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-health-msix-"));
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    const documented = join(appData, "Claude", "claude_desktop_config.json");
    const msix = join(
      localAppData,
      "Packages",
      "Claude_pzs8sxrjxfjjc",
      "LocalCache",
      "Roaming",
      "Claude",
      "claude_desktop_config.json",
    );
    const win32 = {
      platform: "win32" as const,
      home,
      env: { APPDATA: appData, LOCALAPPDATA: localAppData },
    };
    try {
      expect(__testing.claudeDesktopPaths(win32)).toEqual([documented, msix]);
      expect(__testing.userLevelPaths(win32)).toEqual(
        expect.arrayContaining([documented, msix]),
      );
      expect(discoverConfigPaths(home, win32)).not.toContain(msix);
      expect(discoverConfigPaths(home, win32)).not.toContain(documented);

      mkdirSync(dirname(msix), { recursive: true });
      writeFileSync(msix, "{}\n");
      const msixOnly = discoverConfigPaths(home, win32);
      expect(msixOnly).toContain(msix);
      expect(msixOnly).not.toContain(documented);

      mkdirSync(dirname(documented), { recursive: true });
      writeFileSync(documented, "{}\n");
      const both = discoverConfigPaths(home, win32);
      expect(both).toContain(documented);
      expect(both).toContain(msix);

      const noLocal = { ...win32, env: { APPDATA: appData } };
      expect(__testing.claudeDesktopPaths(noLocal)).toEqual([documented]);
      const withoutLocal = discoverConfigPaths(home, noLocal);
      expect(withoutLocal).toContain(documented);
      expect(withoutLocal.some((p) => p.includes("Claude_pzs8sxrjxfjjc"))).toBe(
        false,
      );

      expect(
        discoverConfigPaths(home, { ...win32, includeUserConfig: false }),
      ).toEqual([]);

      expect(
        __testing.claudeDesktopPaths({ platform: "win32", home, env: {} }),
      ).toEqual([
        join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      ]);
      expect(
        __testing
          .claudeDesktopPaths({
            platform: "linux",
            home,
            env: { LOCALAPPDATA: localAppData },
          })
          .some((p) => p.includes("Claude_pzs8sxrjxfjjc")),
      ).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
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
  it("resolves a relative command from the scan root when cwd is elsewhere", async () => {
    const scan = mkdtempSync(join(tmpdir(), "mcp-health-rel-run-"));
    try {
      mkdirSync(join(scan, "bin"));
      const tool = join(scan, "bin", "server");
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
      writeFileSync(
        join(scan, "mcp.json"),
        JSON.stringify({
          mcpServers: { local: { command: "./bin/server" } },
        }),
      );
      const report = await runCheck({
        root: scan,
        includeUserConfig: false,
      });
      const codes = report.servers.flatMap((server) =>
        server.findings.map((finding) => finding.code),
      );
      expect(codes).not.toContain("COMMAND_NOT_FOUND");
      expect(codes).toContain("HEALTHY");
      expect(report.summary.fail).toBe(0);
    } finally {
      rmSync(scan, { recursive: true, force: true });
    }
  });

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

  it("fails claude settings mcpServers instead of grading them healthy", async () => {
    const report = await runCheck({
      root: join(fixtures, "claude-settings"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.servers).toBe(0);
    expect(report.servers.some((server) => server.name === "memory")).toBe(false);
    expect(report.servers.flatMap((server) => server.findings.map((finding) => finding.code))).toEqual([
      "MCP_SERVERS_IGNORED",
    ]);
    expect(exitCode(report)).toBe(2);
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
    expect(exitCode(report)).toBe(2);
    expect(report.summary.servers).toBe(0);
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
      report.summary.servers,
    );
  });

  it("warns on input and unset env variables and can fail with --strict-variables", async () => {
    const report = await runCheck({
      root: join(fixtures, "unresolved-var"),
      includeUserConfig: false,
    });
    const finding = report.servers
      .flatMap((s) => s.findings)
      .find((item) => item.code === "UNRESOLVED_VARIABLE");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("${input:script}");
    expect(finding?.message).toContain("${env:MCP_HEALTH_UNSET_VAR_SHOULD_NOT_EXIST}");
    expect(report.servers.flatMap((s) => s.findings.map((f) => f.code))).not.toContain(
      "HEALTHY",
    );
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(exitCode(report)).toBe(1);

    const strict = await runCheck({
      root: join(fixtures, "unresolved-var"),
      includeUserConfig: false,
      strictVariables: true,
    });
    expect(
      strict.servers.flatMap((s) => s.findings).find((item) => item.code === "UNRESOLVED_VARIABLE")
        ?.severity,
    ).toBe("fail");
    expect(exitCode(strict)).toBe(2);

    const probed = await runCheck({
      root: join(fixtures, "unresolved-var"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 1000,
    });
    const probedCodes = probed.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(probedCodes).toContain("PROBE_SKIPPED");
    expect(probedCodes).not.toContain("PROBE_OK");
    expect(probedCodes).not.toContain("PROBE_FAILED");
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
    expect(
      expandString("${API_KEY}", { root, env: { API_KEY: "secret" } }),
    ).toBe("secret");
    expect(expandString("${API_KEY}", { root, env: {} })).toBe("${API_KEY}");
    expect(
      expandString("${API_BASE_URL:-https://api.example.com}/mcp", {
        root,
        env: {},
      }),
    ).toBe("https://api.example.com/mcp");
    expect(
      expandString("${API_BASE_URL:-https://api.example.com}/mcp", {
        root,
        env: { API_BASE_URL: "https://example.test" },
      }),
    ).toBe("https://example.test/mcp");
    expect(expandString("${CLAUDE_PROJECT_DIR}/bin/server", { root })).toBe(
      "/work/app/bin/server",
    );
    expect(expandString("${foo.bar}", { root, env: {} })).toBe("${foo.bar}");
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

  it("resolves a relative command from the scan root, not another directory", () => {
    const scan = mkdtempSync(join(tmpdir(), "mcp-health-rel-scan-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-health-rel-else-"));
    try {
      mkdirSync(join(scan, "bin"));
      const tool = join(scan, "bin", "server");
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
      mkdirSync(join(elsewhere, "bin"));
      writeFileSync(join(elsewhere, "bin", "server"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(elsewhere, "bin", "server"), 0o755);

      expect(
        resolveCommandOnPath("./bin/server", { PATH: "/usr/bin" }, "linux", scan),
      ).toBe(tool);
      expect(
        resolveCommandOnPath("bin/server", { PATH: "/usr/bin" }, "linux", scan),
      ).toBe(tool);
      expect(
        resolveCommandOnPath(
          "./bin/server",
          { PATH: "/usr/bin" },
          "linux",
          elsewhere,
        ),
      ).toBe(join(elsewhere, "bin", "server"));
      expect(
        resolveCommandOnPath("./bin/missing", { PATH: "/usr/bin" }, "linux", scan),
      ).toBeUndefined();
    } finally {
      rmSync(scan, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("searches the working directory before PATH on Windows", () => {
    const scan = mkdtempSync(join(tmpdir(), "mcp-health-win-cwd-"));
    const pathDir = mkdtempSync(join(tmpdir(), "mcp-health-win-path-"));
    try {
      writeFileSync(join(scan, "tool.CMD"), "@echo off\r\n");
      writeFileSync(join(pathDir, "tool.EXE"), "");
      expect(
        resolveCommandOnPath(
          "tool",
          { PATH: pathDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          "win32",
          scan,
        ),
      ).toBe(join(scan, "tool.CMD"));
    } finally {
      rmSync(scan, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it("does not search the working directory for a bare name on linux", () => {
    const scan = mkdtempSync(join(tmpdir(), "mcp-health-linux-cwd-"));
    try {
      const tool = join(scan, "tool");
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
      expect(
        resolveCommandOnPath("tool", { PATH: "/usr/bin" }, "linux", scan),
      ).toBeUndefined();
    } finally {
      rmSync(scan, { recursive: true, force: true });
    }
  });

  it("treats an empty PATH entry as the working directory", () => {
    const scan = mkdtempSync(join(tmpdir(), "mcp-health-empty-path-"));
    try {
      const tool = join(scan, "tool");
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
      expect(
        resolveCommandOnPath("tool", { PATH: "/usr/bin:" }, "linux", scan),
      ).toBe(tool);
      expect(resolveCommandOnPath("tool", { PATH: "" }, "linux", scan)).toBe(
        tool,
      );
      expect(
        resolveCommandOnPath("tool", {}, "linux", scan),
      ).toBeUndefined();
    } finally {
      rmSync(scan, { recursive: true, force: true });
    }
  });
});

describe("audit fixes", () => {
  it("keeps server summary counts equal to real servers", async () => {
    const report = await runCheck({
      root: join(fixtures, "issues"),
      includeUserConfig: false,
    });
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
      report.summary.servers,
    );
    expect(report.summary.servers).toBe(4);
  });

  it("does not count a skipped settings file as a server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-counts-"));
    try {
      const settings = join(dir, "settings.json");
      const mcp = join(dir, "mcp.json");
      writeFileSync(settings, JSON.stringify({ theme: "dark" }));
      writeFileSync(
        mcp,
        JSON.stringify({ mcpServers: { local: { command: "node", args: ["--version"] } } }),
      );
      const report = await runCheck({
        root: dir,
        files: [settings, mcp],
        includeUserConfig: false,
      });
      expect(report.summary.skipped).toBe(1);
      expect(report.summary.servers).toBe(1);
      expect(report.summary.ok).toBe(1);
      expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(1);
      expect(exitCode(report)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips disabled Cursor and Codex servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-disabled-"));
    try {
      const cursor = join(dir, "mcp.json");
      writeFileSync(
        cursor,
        JSON.stringify({
          mcpServers: {
            off: { command: "definitely-missing-binary-xyz", disabled: true },
            on: { command: "definitely-missing-binary-xyz" },
          },
        }),
      );
      const report = await runCheck({
        root: dir,
        files: [cursor],
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 1000,
      });
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("off")?.status).toBe("ok");
      expect(byName.get("off")?.findings.map((f) => f.code)).toEqual(["DISABLED"]);
      expect(byName.get("on")?.findings.map((f) => f.code)).toContain("COMMAND_NOT_FOUND");
      expect(byName.get("off")?.findings.map((f) => f.code)).not.toContain("PROBE_FAILED");

      const toml = join(dir, "config.toml");
      writeFileSync(
        toml,
        [
          "[mcp_servers.off]",
          'command = "definitely-missing-binary-xyz"',
          "enabled = false",
          "",
          "[mcp_servers.on]",
          'command = "node"',
          'args = ["--version"]',
          "",
        ].join("\n"),
      );
      const codex = await runCheck({
        root: dir,
        files: [toml],
        includeUserConfig: false,
      });
      const codexByName = new Map(codex.servers.map((server) => [server.name, server]));
      expect(codexByName.get("off")?.findings.map((f) => f.code)).toEqual(["DISABLED"]);
      expect(codexByName.get("on")?.status).toBe("ok");
      expect(exitCode(codex)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses JSONC and recognizes Zed extension servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-jsonc-"));
    try {
      mkdirSync(join(dir, ".zed"));
      writeFileSync(
        join(dir, ".zed", "settings.json"),
        `{
          // zed allows comments
          "context_servers": {
            "zed-local": {
              "command": "node",
              "args": ["--version"],
            },
            "from-ext": {
              "source": "extension",
              "settings": { "note": "https://example.com//not-a-comment" },
            },
            "broken": { "env": { "A": "b" } },
            "paused": { "enabled": false, "command": "definitely-missing-binary-xyz" },
          },
        }`,
      );
      const report = await runCheck({ root: dir, includeUserConfig: false });
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("zed-local")?.status).toBe("ok");
      expect(byName.get("from-ext")?.findings.map((f) => f.code)).toEqual([
        "EXTENSION_SERVER",
      ]);
      expect(byName.get("from-ext")?.status).toBe("ok");
      expect(byName.get("broken")?.findings.map((f) => f.code)).toContain("NO_TRANSPORT");
      expect(byName.get("paused")?.findings.map((f) => f.code)).toEqual(["DISABLED"]);
      expect(report.servers.flatMap((s) => s.findings.map((f) => f.code))).not.toContain(
        "PARSE_ERROR",
      );
      expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
        report.summary.servers,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails unknown variables, missing files, and a missing root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-paths-"));
    try {
      const file = join(dir, "mcp.json");
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { typo: { command: "${foo.bar}" } },
        }),
      );
      const typo = await runCheck({ root: dir, files: [file], includeUserConfig: false });
      const finding = typo.servers.flatMap((s) => s.findings).find((item) => item.code === "UNRESOLVED_VARIABLE");
      expect(finding?.severity).toBe("fail");
      expect(exitCode(typo)).toBe(2);

      const missing = await runCheck({
        root: dir,
        files: [join(dir, "nope.json")],
        includeUserConfig: false,
      });
      expect(missing.servers[0]?.findings.map((f) => f.code)).toEqual(["FILE_NOT_FOUND"]);
      expect(missing.servers.flatMap((s) => s.findings.map((f) => f.code))).not.toContain(
        "PARSE_ERROR",
      );
      expect(exitCode(missing)).toBe(2);

      const absent = await runCheck({
        root: join(dir, "does-not-exist"),
        includeUserConfig: false,
      });
      expect(absent.servers[0]?.findings.map((f) => f.code)).toEqual(["ROOT_NOT_FOUND"]);
      expect(absent.servers.flatMap((s) => s.findings.map((f) => f.code))).not.toContain(
        "NO_CONFIG",
      );
      expect(exitCode(absent)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when no config exists and can allow that", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-none-"));
    try {
      const warned = await runCheck({ root: dir, includeUserConfig: false });
      expect(warned.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
      expect(warned.servers[0]?.status).toBe("warn");
      expect(exitCode(warned)).toBe(1);
      expect(warned.summary.servers).toBe(0);
      expect(warned.summary.configWarnings).toBe(0);
      const warnedHeader = formatHuman(warned).split("\n")[1] ?? "";
      expect(warnedHeader).toContain("warn: 0");
      expect(warnedHeader).not.toContain("config-level warning");

      const allowed = await runCheck({
        root: dir,
        includeUserConfig: false,
        allowMissing: true,
      });
      expect(allowed.servers[0]?.status).toBe("ok");
      expect(allowed.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
      expect(exitCode(allowed)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 for an empty server map and says so in the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-empty-map-"));
    try {
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      const report = await runCheck({ root: dir, includeUserConfig: false });
      expect(report.summary).toMatchObject({
        ok: 0,
        warn: 0,
        fail: 0,
        files: 1,
        servers: 0,
        skipped: 0,
        configWarnings: 1,
      });
      expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
        report.summary.servers,
      );
      expect(report.servers.map((server) => server.name)).toEqual(["(config)"]);
      expect(report.servers[0]?.findings.map((finding) => finding.code)).toEqual([
        "EMPTY_SERVERS",
      ]);
      expect(exitCode(report)).toBe(1);
      const header = formatHuman(report).split("\n")[1] ?? "";
      expect(header).toContain("servers: 0");
      expect(header).toContain("warn: 0");
      expect(header).toContain(
        "exit 1 because of a config-level warning (EMPTY_SERVERS)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--probe-timeout", () => {
  const tsx = join(repo, "node_modules", ".bin", "tsx");

  function runCli(args: string[], cwd = repo) {
    return spawnSync(tsx, [join(repo, "src", "cli.ts"), ...args], {
      encoding: "utf8",
      cwd,
    });
  }

  it("rejects non-numeric and non-positive values before spawning a server", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-timeout-"));
    const marker = join(dir, "spawned");
    const script = join(dir, "server.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned\\n");\n`,
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: { local: { command: "node", args: [script] } },
      }),
    );
    try {
      for (const value of ["foo", "0", "-5"]) {
        const result = runCli(
          ["check", "--no-user", "--probe", "--probe-timeout", value, dir],
          dir,
        );
        expect(result.status, value).toBeGreaterThan(0);
        expect(result.stderr, value).toContain("--probe-timeout");
        expect(result.stderr, value).toContain(
          "value must be a positive number of milliseconds",
        );
        expect(result.stdout, value).not.toContain("mcp-health — scanned");
        expect(existsSync(marker), value).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the default of 8000 and still probes with 4000", () => {
    const help = runCli(["check", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--probe-timeout <ms>");
    expect(help.stdout).toContain("(default: 8000)");

    const probed = runCli([
      "check",
      "--no-user",
      "--probe",
      "--probe-timeout",
      "4000",
      "fixtures/probe-ok",
    ]);
    expect(probed.status).toBe(0);
    expect(probed.stdout).toContain("PROBE_OK");
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

describe("Claude ${VAR} references", () => {
  const secret = "super-secret-mcp-health-value";

  function codesFor(
    report: Awaited<ReturnType<typeof runCheck>>,
    name: string,
  ): string[] {
    return (
      report.servers
        .find((server) => server.name === name)
        ?.findings.map((finding) => finding.code) ?? []
    );
  }

  it("expands set variables and defaults, and does not print the value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-claude-var-"));
    const previous = {
      API_KEY: process.env.API_KEY,
      API_BASE_URL: process.env.API_BASE_URL,
      MCP_HEALTH_MISSING_HOST: process.env.MCP_HEALTH_MISSING_HOST,
    };
    delete process.env.API_KEY;
    delete process.env.API_BASE_URL;
    delete process.env.MCP_HEALTH_MISSING_HOST;
    try {
      mkdirSync(join(dir, "bin"));
      const tool = join(dir, "bin", "server");
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "api-server": {
              type: "http",
              url: "${API_BASE_URL:-https://api.example.com}/mcp",
              headers: { Authorization: "Bearer ${API_KEY}" },
            },
            "project-bin": {
              command: "${CLAUDE_PROJECT_DIR}/bin/server",
            },
            "input-url": { url: "${input:serverUrl}" },
            "env-in-url": { url: "http://${env:MCP_HEALTH_MISSING_HOST}/mcp" },
            typo: { command: "${foo.bar}" },
          },
        }),
      );

      const unset = await runCheck({ root: dir, includeUserConfig: false });
      expect(codesFor(unset, "api-server")).toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(unset, "api-server")).not.toContain("BAD_URL");
      expect(codesFor(unset, "api-server")).not.toContain("BAD_URL_PROTOCOL");
      expect(
        unset.servers.find((server) => server.name === "api-server")?.status,
      ).toBe("warn");

      const strict = await runCheck({
        root: dir,
        includeUserConfig: false,
        strictVariables: true,
      });
      expect(
        strict.servers.find((server) => server.name === "api-server")?.status,
      ).toBe("fail");

      process.env.API_KEY = secret;
      process.env.API_BASE_URL = "https://example.test";
      const set = await runCheck({ root: dir, includeUserConfig: false });
      expect(codesFor(set, "api-server")).not.toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(set, "api-server")).not.toContain("BAD_URL");
      expect(codesFor(set, "api-server")).toContain("HEALTHY");
      const rendered = `${formatHuman(set)}\n${JSON.stringify(set)}`;
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain("https://example.test");

      expect(codesFor(set, "project-bin")).not.toContain("COMMAND_NOT_FOUND");
      expect(codesFor(set, "project-bin")).toContain("HEALTHY");

      expect(codesFor(set, "input-url")).toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(set, "input-url")).toContain("MISSING_TRANSPORT_TYPE");
      expect(codesFor(set, "input-url")).not.toContain("BAD_URL");
      const inputUrl = set.servers.find((server) => server.name === "input-url");
      expect(
        inputUrl?.findings.find((finding) => finding.code === "UNRESOLVED_VARIABLE")
          ?.severity,
      ).toBe("warn");
      expect(inputUrl?.status).toBe("fail");

      expect(codesFor(set, "env-in-url")).toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(set, "env-in-url")).toContain("MISSING_TRANSPORT_TYPE");
      expect(codesFor(set, "env-in-url")).not.toContain("BAD_URL");

      expect(codesFor(set, "typo")).toContain("UNRESOLVED_VARIABLE");
      expect(set.servers.find((server) => server.name === "typo")?.status).toBe(
        "fail",
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("floating package tags", () => {
  it("warns on @latest offline and reports NPM_LATEST online", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-floating-"));
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
          star: { command: "npx", args: ["-y", "some-server@*"] },
          pinned: { command: "npx", args: ["-y", "some-server@1.2.3"] },
        },
      }),
    );
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ version: "9.9.9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const offline = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const playwright = offline.servers.find((server) => server.name === "playwright");
      expect(playwright?.findings.map((finding) => finding.code)).toContain(
        "UNPINNED_PACKAGE",
      );
      expect(
        playwright?.findings.find((finding) => finding.code === "UNPINNED_PACKAGE")
          ?.message,
      ).toContain("@playwright/mcp@latest");
      expect(
        offline.servers
          .find((server) => server.name === "star")
          ?.findings.map((finding) => finding.code),
      ).toContain("UNPINNED_PACKAGE");
      expect(
        offline.servers
          .find((server) => server.name === "pinned")
          ?.findings.map((finding) => finding.code),
      ).not.toContain("UNPINNED_PACKAGE");

      const online = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
        online: true,
      });
      const latest = online.servers
        .find((server) => server.name === "playwright")
        ?.findings.find((finding) => finding.code === "NPM_LATEST");
      expect(latest?.message).toContain("Unpinned");
      expect(latest?.message).toContain("@playwright/mcp@9.9.9");
      expect(latest?.message).not.toContain("Pinned");
      expect(
        online.servers
          .find((server) => server.name === "pinned")
          ?.findings.some((finding) => finding.message.startsWith("Pinned latest")),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server env PATH", () => {
  it("uses Path on Windows and ignores an unresolved PATH", () => {
    const base = { PATH: "/usr/bin" };
    expect(commandLookupEnv({ PATH: "/opt/bin" }, base, "linux").PATH).toBe(
      "/opt/bin",
    );
    expect(commandLookupEnv({ Path: "C:\\bin" }, base, "win32").PATH).toBe(
      "C:\\bin",
    );
    expect(
      commandLookupEnv({ PATH: "${env:MISSING}/bin" }, base, "linux").PATH,
    ).toBe("/usr/bin");
    expect(commandLookupEnv({ API_KEY: "x" }, base, "linux")).toBe(base);
  });

  it("finds a command only on the server PATH and misses one the server PATH hides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-server-path-"));
    const bin = mkdtempSync(join(tmpdir(), "mcp-health-server-bin-"));
    const hidden = mkdtempSync(join(tmpdir(), "mcp-health-server-hide-"));
    try {
      const server = join(bin, "server.mjs");
      writeFileSync(
        server,
        `import { replyToInitialize } from ${JSON.stringify(join(fixtures, "support", "stdio-reply.mjs"))};\nreplyToInitialize();\n`,
      );
      const script = join(bin, "only-on-server-path");
      writeFileSync(
        script,
        `#!/bin/sh\nexec ${JSON.stringify(execPath)} ${JSON.stringify(server)}\n`,
      );
      chmodSync(script, 0o755);
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            local: {
              command: "only-on-server-path",
              env: { PATH: bin },
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "other.json"),
        JSON.stringify({
          mcpServers: {
            hidden: {
              command: "node",
              env: { PATH: hidden },
            },
            unresolved: {
              command: "node",
              env: { PATH: "${env:MCP_HEALTH_PATH_DOES_NOT_EXIST}/bin" },
            },
          },
        }),
      );

      const probed = await runCheck({
        root: dir,
        files: [join(dir, "mcp.json")],
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      const local = probed.servers.find((server) => server.name === "local");
      expect(local?.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]),
      );
      expect(local?.findings.map((finding) => finding.code)).not.toContain(
        "COMMAND_NOT_FOUND",
      );

      const report = await runCheck({
        root: dir,
        files: [join(dir, "other.json")],
        includeUserConfig: false,
      });
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("hidden")?.findings.map((finding) => finding.code)).toContain(
        "COMMAND_NOT_FOUND",
      );
      expect(
        byName.get("unresolved")?.findings.map((finding) => finding.code),
      ).toContain("UNRESOLVED_VARIABLE");
      expect(
        byName.get("unresolved")?.findings.map((finding) => finding.code),
      ).not.toContain("COMMAND_NOT_FOUND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      rmSync(hidden, { recursive: true, force: true });
    }
  });
});

describe("websocket and socket URLs", () => {
  function codesFor(
    report: Awaited<ReturnType<typeof runCheck>>,
    name: string,
  ): string[] {
    return (
      report.servers
        .find((server) => server.name === name)
        ?.findings.map((finding) => finding.code) ?? []
    );
  }

  it("accepts wss, ws, unix, and pipe, and rejects ftp and file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-socket-url-"));
    const previous = process.env.MCP_HOST;
    delete process.env.MCP_HOST;
    try {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            events: {
              type: "ws",
              url: "wss://mcp.example.com/socket",
            },
            plainWs: {
              type: "ws",
              url: "ws://mcp.example.com/socket",
            },
            variable: {
              type: "ws",
              url: "wss://${MCP_HOST}/socket",
            },
          },
        }),
      );
      mkdirSync(join(dir, ".vscode"));
      writeFileSync(
        join(dir, ".vscode/mcp.json"),
        JSON.stringify({
          servers: {
            local: {
              type: "http",
              url: "unix:///tmp/server.sock#/mcp/subpath",
            },
            pipe: {
              type: "http",
              url: "pipe:///pipe/named-pipe",
            },
            https: {
              type: "http",
              url: "https://example.com/mcp",
            },
            ftp: {
              type: "http",
              url: "ftp://example.com/mcp",
            },
            file: {
              type: "http",
              url: "file:///tmp/not-mcp",
            },
          },
        }),
      );

      const report = await runCheck({ root: dir, includeUserConfig: false });
      expect(codesFor(report, "events")).toEqual(["HEALTHY"]);
      expect(codesFor(report, "plainWs")).toEqual(["HEALTHY"]);
      expect(codesFor(report, "variable")).toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(report, "variable")).not.toContain("BAD_URL");
      expect(codesFor(report, "variable")).not.toContain("BAD_URL_PROTOCOL");
      expect(codesFor(report, "local")).toEqual(["HEALTHY"]);
      expect(codesFor(report, "pipe")).toEqual(["HEALTHY"]);
      expect(codesFor(report, "https")).toEqual(["HEALTHY"]);
      expect(codesFor(report, "ftp")).toContain("BAD_URL_PROTOCOL");
      expect(codesFor(report, "file")).toContain("BAD_URL_PROTOCOL");
      const ftp = report.servers.find((server) => server.name === "ftp");
      expect(ftp?.findings.map((finding) => finding.message).join("\n")).toMatch(
        /ftp:/,
      );
      expect(exitCode(report)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.MCP_HOST;
      else process.env.MCP_HOST = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the probe for wss and unix URLs without opening a connection", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchMock);
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-socket-probe-"));
    try {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            events: {
              type: "ws",
              url: "wss://mcp.example.com/socket",
            },
          },
        }),
      );
      mkdirSync(join(dir, ".vscode"));
      writeFileSync(
        join(dir, ".vscode/mcp.json"),
        JSON.stringify({
          servers: {
            local: {
              type: "http",
              url: "unix:///tmp/server.sock#/mcp/subpath",
            },
          },
        }),
      );

      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeListTools: false,
        probeTimeoutMs: 500,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      for (const name of ["events", "local"]) {
        const codes = codesFor(report, name);
        expect(codes).toContain("PROBE_SKIPPED");
        expect(codes).not.toContain("PROBE_FAILED");
        expect(codes).not.toContain("BAD_URL_PROTOCOL");
      }
      expect(
        report.servers
          .find((server) => server.name === "events")
          ?.findings.find((finding) => finding.code === "PROBE_SKIPPED")?.message,
      ).toMatch(/wss:/);
      expect(
        report.servers
          .find((server) => server.name === "local")
          ?.findings.find((finding) => finding.code === "PROBE_SKIPPED")?.message,
      ).toMatch(/unix:/);
      expect(report.servers.every((server) => server.status === "warn")).toBe(
        true,
      );
      expect(exitCode(report)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VS Code env values", () => {
  it("accepts a number and null without failing the rest of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-vscode-env-"));
    try {
      mkdirSync(join(dir, ".vscode"));
      writeFileSync(
        join(dir, ".vscode/mcp.json"),
        JSON.stringify({
          servers: {
            numeric: {
              type: "stdio",
              command: "node",
              args: ["--version"],
              env: { PORT: 3000, OPTIONAL: null },
            },
            plain: {
              type: "stdio",
              command: "node",
              args: ["--version"],
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            api: {
              command: "node",
              args: ["--version"],
              env: { PORT: 3000 },
            },
          },
        }),
      );

      const report = await runCheck({ root: dir, includeUserConfig: false });
      const vscode = report.servers.filter((server) =>
        server.file.endsWith(".vscode/mcp.json"),
      );
      const vscodeCodes = vscode.flatMap((server) =>
        server.findings.map((finding) => finding.code),
      );
      expect(vscodeCodes).not.toContain("SCHEMA_ERROR");
      expect(vscodeCodes).not.toContain("PLACEHOLDER_ENV");
      expect(vscode.map((server) => server.name).sort()).toEqual([
        "numeric",
        "plain",
      ]);
      expect(vscode.every((server) => server.status === "ok")).toBe(true);

      const cursor = report.servers.find(
        (server) => server.file === join(dir, "mcp.json"),
      );
      expect(cursor?.findings.map((finding) => finding.code)).toContain(
        "SCHEMA_ERROR",
      );
      expect(cursor?.name).toBe("(config)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a boolean env value in a VS Code config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-vscode-env-bool-"));
    try {
      mkdirSync(join(dir, ".vscode"));
      writeFileSync(
        join(dir, ".vscode/mcp.json"),
        JSON.stringify({
          servers: {
            numeric: {
              type: "stdio",
              command: "node",
              args: ["--version"],
              env: { ENABLED: true },
            },
          },
        }),
      );
      const report = await runCheck({ root: dir, includeUserConfig: false });
      const finding = report.servers
        .flatMap((server) => server.findings)
        .find((item) => item.code === "SCHEMA_ERROR");
      expect(finding?.message).toMatch(/ENABLED/);
      expect(finding?.message).toMatch(/boolean/i);
      expect(exitCode(report)).toBe(2);
      expect(report.summary.servers).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("envFile", () => {
  const secret = "envfile-secret-do-not-print";

  function codesFor(
    report: Awaited<ReturnType<typeof runCheck>>,
    name: string,
  ): string[] {
    return (
      report.servers
        .find((server) => server.name === name)
        ?.findings.map((finding) => finding.code) ?? []
    );
  }

  it("warns when a Cursor or VS Code stdio envFile is missing and does not read one that exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-envfile-"));
    try {
      mkdirSync(join(dir, ".cursor"));
      mkdirSync(join(dir, ".vscode"));
      mkdirSync(join(dir, ".github"));
      writeFileSync(
        join(dir, ".cursor/mcp.json"),
        JSON.stringify({
          mcpServers: {
            local: {
              command: "node",
              args: ["--version"],
              envFile: "${workspaceFolder}/.env",
            },
            remote: {
              url: "https://example.com/mcp",
              envFile: "${workspaceFolder}/.env",
            },
            deferred: {
              command: "node",
              args: ["--version"],
              envFile: "${input:env-file}",
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            root: {
              command: "node",
              args: ["--version"],
              envFile: ".env",
            },
          },
        }),
      );
      writeFileSync(
        join(dir, ".vscode/mcp.json"),
        JSON.stringify({
          servers: {
            editor: {
              type: "stdio",
              command: "node",
              args: ["--version"],
              envFile: "${workspaceFolder}/missing.env",
            },
          },
        }),
      );
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            claude: {
              command: "node",
              args: ["--version"],
              envFile: "${workspaceFolder}/.env",
            },
          },
        }),
      );
      writeFileSync(
        join(dir, ".github/mcp.json"),
        JSON.stringify({
          mcpServers: {
            copilot: {
              command: "node",
              args: ["--version"],
              envFile: "${workspaceFolder}/.env",
            },
          },
        }),
      );

      const missing = await runCheck({ root: dir, includeUserConfig: false });
      expect(codesFor(missing, "local")).toContain("ENV_FILE_MISSING");
      expect(codesFor(missing, "local")).not.toContain("HEALTHY");
      expect(missing.servers.find((server) => server.name === "local")?.status).toBe(
        "warn",
      );
      expect(codesFor(missing, "root")).toContain("ENV_FILE_MISSING");
      expect(codesFor(missing, "editor")).toContain("ENV_FILE_MISSING");
      expect(codesFor(missing, "remote")).not.toContain("ENV_FILE_MISSING");
      expect(codesFor(missing, "deferred")).toContain("UNRESOLVED_VARIABLE");
      expect(codesFor(missing, "deferred")).not.toContain("ENV_FILE_MISSING");
      expect(codesFor(missing, "claude")).toEqual(["HEALTHY"]);
      expect(codesFor(missing, "copilot")).toEqual(["HEALTHY"]);
      expect(exitCode(missing)).toBe(1);

      writeFileSync(join(dir, ".env"), `TOKEN=${secret}\n`);
      const present = await runCheck({ root: dir, includeUserConfig: false });
      expect(codesFor(present, "local")).toEqual(["HEALTHY"]);
      expect(codesFor(present, "root")).toEqual(["HEALTHY"]);
      expect(codesFor(present, "editor")).toContain("ENV_FILE_MISSING");
      const rendered = `${formatHuman(present)}\n${JSON.stringify(present)}`;
      expect(rendered).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
