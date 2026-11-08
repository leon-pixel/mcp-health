import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { discoverConfigPaths } from "./discover.js";
import { IGNORE_FILENAME } from "./ignore.js";
import { runCheck } from "./run.js";
import { exitCode, formatHuman, formatJson } from "./report.js";
import { buildSarif, formatAnnotations } from "./sarif.js";
import type { HealthReport } from "./types.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(repo, "node_modules", ".bin", "tsx");
const SECRET = "sk-live-ignore-should-not-print";

function writeJson(root: string, rel: string, value: unknown): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
  return full;
}

function unpinnedConfig(extra?: Record<string, unknown>): unknown {
  return {
    mcpServers: {
      unpinned: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        env: { TOKEN: SECRET },
        ...extra,
      },
    },
  };
}

function ignoreFile(entries: unknown): unknown {
  return { ignore: entries };
}

function rendered(report: HealthReport): string {
  return [
    formatHuman(report),
    formatJson(report),
    formatAnnotations(report),
    JSON.stringify(buildSarif(report)),
  ].join("\n");
}

function ruleIds(report: HealthReport): string[] {
  const sarif = buildSarif(report) as {
    runs: Array<{ results: Array<{ ruleId: string }> }>;
  };
  return sarif.runs[0]?.results.map((result) => result.ruleId) ?? [];
}

describe(".mcp-health.json suppressions", () => {
  it("drops a suppressed unpinned package from the result and the exit code", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-ok-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = writeJson(root, "mcp.json", unpinnedConfig());
    const ignore = writeJson(
      root,
      IGNORE_FILENAME,
      ignoreFile([{ code: "UNPINNED_PACKAGE", server: "unpinned", file: "mcp.json" }]),
    );
    const before = [config, ignore].map((file) => readFileSync(file));

    try {
      const open = await runCheck({ root, includeUserConfig: false });
      expect(exitCode(open)).toBe(0);
      expect(open.summary).toMatchObject({ ok: 1, warn: 0, fail: 0, servers: 1, configWarnings: 0 });
      expect(open.servers.find((server) => server.name === "unpinned")?.status).toBe("ok");
      expect(open.servers.find((server) => server.name === "unpinned")?.findings.map((f) => f.code)).toEqual([
        "HEALTHY",
      ]);
      expect(open.files).toEqual([config]);
      expect(rendered(open)).not.toContain("UNPINNED_PACKAGE");
      expect(rendered(open)).not.toContain(SECRET);
      expect(ruleIds(open)).not.toContain("UNPINNED_PACKAGE");
      expect(formatAnnotations(open)).toBe("");
      expect([config, ignore].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a second finding on the same server when only the pin is accepted", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-fail-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = writeJson(
      root,
      "mcp.json",
      unpinnedConfig({ args: ["-y", "@modelcontextprotocol/server-memory", "${not.a.variable}"] }),
    );
    const ignore = writeJson(
      root,
      IGNORE_FILENAME,
      ignoreFile([{ code: "UNPINNED_PACKAGE", server: "unpinned", file: "mcp.json" }]),
    );
    const before = [config, ignore].map((file) => readFileSync(file));

    try {
      const report = await runCheck({ root, includeUserConfig: false });
      const server = report.servers.find((item) => item.name === "unpinned");
      expect(server?.status).toBe("fail");
      expect(server?.findings.map((finding) => finding.code)).toEqual(["UNRESOLVED_VARIABLE"]);
      expect(report.summary).toMatchObject({ ok: 0, warn: 0, fail: 1, configWarnings: 0 });
      expect(exitCode(report)).toBe(2);
      const text = rendered(report);
      expect(text).toContain("UNRESOLVED_VARIABLE");
      expect(text).not.toContain("UNPINNED_PACKAGE");
      expect(text).not.toContain(SECRET);
      expect(ruleIds(report)).toEqual(["UNRESOLVED_VARIABLE"]);
      expect(formatAnnotations(report)).toContain("UNRESOLVED_VARIABLE");
      expect(formatAnnotations(report)).not.toContain("UNPINNED_PACKAGE");
      expect([config, ignore].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on a stale entry and leaves a scan with no ignore file unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-stale-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = writeJson(root, "mcp.json", {
      mcpServers: { local: { command: "node", args: ["--version"], env: { TOKEN: SECRET } } },
    });
    const beforeConfig = readFileSync(config);

    try {
      const plain = await runCheck({ root, includeUserConfig: false });
      expect(exitCode(plain)).toBe(0);
      expect(plain.summary).toMatchObject({ ok: 1, warn: 0, fail: 0, configWarnings: 0 });
      expect(plain.servers.map((server) => server.name)).toEqual(["local"]);
      expect(rendered(plain)).not.toContain("STALE_IGNORE");
      expect(rendered(plain)).not.toContain(SECRET);
      expect(readFileSync(config)).toEqual(beforeConfig);

      const ignore = writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([{ code: "UNPINNED_PACKAGE", server: "missing", file: "mcp.json" }]),
      );
      const beforeIgnore = readFileSync(ignore);
      const stale = await runCheck({ root, includeUserConfig: false });
      expect(exitCode(stale)).toBe(1);
      expect(stale.summary).toMatchObject({
        ok: 1,
        warn: 0,
        fail: 0,
        servers: 1,
        configWarnings: 1,
      });
      expect(stale.servers.find((server) => server.name === "local")?.status).toBe("ok");
      const warning = stale.servers.find((server) => server.name === "(config)");
      expect(warning?.status).toBe("warn");
      expect(warning?.findings.map((finding) => finding.code)).toEqual(["STALE_IGNORE"]);
      expect(warning?.findings[0]?.message).toContain("UNPINNED_PACKAGE");
      expect(warning?.findings[0]?.message).toContain("missing");
      expect(warning?.findings[0]?.message).toContain("mcp.json");
      expect(formatHuman(stale)).toContain(
        "exit 1 because of a config-level warning (STALE_IGNORE)",
      );
      expect(rendered(stale)).toContain("STALE_IGNORE");
      expect(rendered(stale)).not.toContain(SECRET);
      expect(ruleIds(stale)).toContain("STALE_IGNORE");
      expect(formatAnnotations(stale)).toContain("STALE_IGNORE");
      expect(readFileSync(config)).toEqual(beforeConfig);
      expect(readFileSync(ignore)).toEqual(beforeIgnore);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not suppress from a message substring, an unknown code, or the wrong file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-exact-"));
    writeJson(root, "mcp.json", unpinnedConfig());
    writeJson(
      root,
      "services/api/mcp.json",
      unpinnedConfig(),
    );

    try {
      const byMessage = await runCheck({ root, includeUserConfig: false, recursive: true });
      writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([
          {
            code: "UNPINNED_PACKAGE",
            server: "not version-pinned",
            file: "mcp.json",
            message: "Package is not version-pinned",
          },
        ]),
      );
      const messageMiss = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(messageMiss.servers.filter((server) => server.name === "unpinned").every((server) =>
        server.findings.some((finding) => finding.code === "UNPINNED_PACKAGE"),
      )).toBe(true);
      expect(messageMiss.servers.some((server) =>
        server.findings.some((finding) => finding.code === "STALE_IGNORE"),
      )).toBe(true);
      expect(exitCode(messageMiss)).toBe(1);
      expect(byMessage.summary.warn).toBe(2);

      writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([{ code: "UNPINNED", server: "unpinned", file: "mcp.json" }]),
      );
      const unknown = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(unknown.servers.filter((server) => server.name === "unpinned")).toHaveLength(2);
      expect(
        unknown.servers
          .filter((server) => server.name === "unpinned")
          .every((server) => server.findings.some((finding) => finding.code === "UNPINNED_PACKAGE")),
      ).toBe(true);
      expect(
        unknown.servers.some((server) =>
          server.findings.some((finding) => finding.code === "UNKNOWN_IGNORE"),
        ),
      ).toBe(true);
      expect(rendered(unknown)).toContain('unknown code "UNPINNED"');
      expect(exitCode(unknown)).toBe(1);

      writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([{ code: "UNPINNED_PACKAGE", server: "unpinned", file: "mcp.json" }]),
      );
      const oneFile = await runCheck({ root, includeUserConfig: false, recursive: true });
      const rootServer = oneFile.servers.find(
        (server) => server.name === "unpinned" && server.file === join(root, "mcp.json"),
      );
      const nestedServer = oneFile.servers.find(
        (server) => server.name === "unpinned" && server.file === join(root, "services/api/mcp.json"),
      );
      expect(rootServer?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(nestedServer?.status).toBe("warn");
      expect(nestedServer?.findings.some((finding) => finding.code === "UNPINNED_PACKAGE")).toBe(
        true,
      );
      expect(oneFile.summary).toMatchObject({ ok: 1, warn: 1, fail: 0 });
      expect(exitCode(oneFile)).toBe(1);

      writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([
          {
            code: "UNPINNED_PACKAGE",
            server: "unpinned",
            file: "services\\api\\mcp.json",
          },
        ]),
      );
      const windowsPath = await runCheck({ root, includeUserConfig: false, recursive: true });
      const nested = windowsPath.servers.find(
        (server) => server.file === join(root, "services/api/mcp.json"),
      );
      expect(nested?.findings.some((finding) => finding.code === "UNPINNED_PACKAGE")).toBe(false);
      expect(windowsPath.servers.find((server) => server.file === join(root, "mcp.json"))?.status).toBe(
        "warn",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a broken ignore file without hiding the finding, and does not scan the file as MCP config", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-bad-"));
    const config = writeJson(root, "mcp.json", unpinnedConfig());

    try {
      writeFileSync(join(root, IGNORE_FILENAME), "{ not json\n");
      const broken = await runCheck({ root, includeUserConfig: false });
      expect(broken.servers.some((server) =>
        server.findings.some((finding) => finding.code === "UNPINNED_PACKAGE"),
      )).toBe(true);
      expect(broken.servers.some((server) =>
        server.findings.some((finding) => finding.code === "IGNORE_CONFIG"),
      )).toBe(true);
      expect(exitCode(broken)).toBe(1);
      expect(broken.files).toEqual([config]);

      writeJson(root, IGNORE_FILENAME, {
        ignore: [{ server: "unpinned", file: "mcp.json" }],
      });
      const partial = await runCheck({ root, includeUserConfig: false });
      expect(partial.servers.some((server) =>
        server.findings.some((finding) => finding.code === "UNPINNED_PACKAGE"),
      )).toBe(true);
      expect(partial.servers.some((server) =>
        server.findings.some((finding) => finding.code === "IGNORE_CONFIG"),
      )).toBe(true);

      writeJson(root, IGNORE_FILENAME, {
        ignore: [{ code: "UNPINNED_PACKAGE", server: 1, file: "mcp.json" }],
      });
      const badServer = await runCheck({ root, includeUserConfig: false });
      expect(badServer.servers.some((server) =>
        server.findings.some((finding) => finding.code === "UNPINNED_PACKAGE"),
      )).toBe(true);
      expect(badServer.servers.some((server) =>
        server.findings.some((finding) => finding.code === "IGNORE_CONFIG"),
      )).toBe(true);

      const only = mkdtempSync(join(tmpdir(), "mcp-health-ignore-only-"));
      try {
        const ignored = writeJson(only, IGNORE_FILENAME, {
          mcpServers: {
            ghost: { command: "definitely-not-a-real-mcp-binary-xyz" },
          },
          ignore: [],
        });
        expect(discoverConfigPaths(only, { includeUserConfig: false })).not.toContain(ignored);
        expect(
          discoverConfigPaths(only, { includeUserConfig: false, recursive: true }),
        ).not.toContain(ignored);
        const report = await runCheck({ root: only, includeUserConfig: false, recursive: true });
        expect(report.files).toEqual([]);
        expect(report.servers.map((server) => server.name)).toEqual(["(scan)"]);
        expect(report.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
        expect(rendered(report)).not.toContain("ghost");
        expect(exitCode(report)).toBe(1);
      } finally {
        rmSync(only, { recursive: true, force: true });
      }

      rmSync(join(root, IGNORE_FILENAME));
      writeJson(
        root,
        "nested/.mcp-health.json",
        ignoreFile([{ code: "UNPINNED_PACKAGE", server: "unpinned", file: "mcp.json" }]),
      );
      const nestedIgnore = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(nestedIgnore.servers.find((server) => server.name === "unpinned")?.status).toBe(
        "warn",
      );
      expect(exitCode(nestedIgnore)).toBe(1);
      expect(rendered(nestedIgnore)).toContain("UNPINNED_PACKAGE");
      expect(rendered(nestedIgnore)).not.toContain("STALE_IGNORE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a nested finding from the scan-root ignore file without a new CLI flag", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-cli-"));
    writeJson(
      root,
      "services/api/.cursor/mcp.json",
      unpinnedConfig(),
    );
    writeJson(
      root,
      IGNORE_FILENAME,
      ignoreFile([
        {
          code: "UNPINNED_PACKAGE",
          server: "unpinned",
          file: "services/api/.cursor/mcp.json",
        },
      ]),
    );
    const readme = readFileSync(join(repo, "README.md"), "utf8");

    try {
      const result = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--recursive", "--json", root],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("UNPINNED_PACKAGE");
      expect(result.stdout).not.toContain(SECRET);
      const parsed = JSON.parse(result.stdout) as HealthReport;
      expect(parsed.summary).toMatchObject({ ok: 1, warn: 0, fail: 0 });
      expect(parsed.files.some((file) => file.endsWith(IGNORE_FILENAME))).toBe(false);

      expect(readme).toContain(".mcp-health.json");
      expect(readme).toContain("STALE_IGNORE");
      expect(readme).toContain("UNKNOWN_IGNORE");
      expect(readme).toContain("trailing commas");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses one code in every file when server and file are omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-any-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rootConfig = writeJson(root, "mcp.json", unpinnedConfig());
    const nestedConfig = writeJson(root, "services/api/mcp.json", unpinnedConfig());
    const ignore = writeJson(root, IGNORE_FILENAME, ignoreFile([{ code: "UNPINNED_PACKAGE" }]));
    const before = [rootConfig, nestedConfig, ignore].map((file) => readFileSync(file));

    try {
      const report = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(exitCode(report)).toBe(0);
      expect(report.summary).toMatchObject({ ok: 2, warn: 0, fail: 0, configWarnings: 0 });
      for (const file of [rootConfig, nestedConfig]) {
        const server = report.servers.find((item) => item.file === file);
        expect(server?.status).toBe("ok");
        expect(server?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      }
      const text = rendered(report);
      expect(text).not.toContain("UNPINNED_PACKAGE");
      expect(text).not.toContain("STALE_IGNORE");
      expect(text).not.toContain(SECRET);
      expect(ruleIds(report)).not.toContain("UNPINNED_PACKAGE");
      expect(formatAnnotations(report)).toBe("");
      expect([rootConfig, nestedConfig, ignore].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();

      writeJson(
        root,
        IGNORE_FILENAME,
        ignoreFile([{ code: "UNPINNED_PACKAGE", server: "*", file: "*" }]),
      );
      const starred = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(exitCode(starred)).toBe(0);
      expect(starred.servers.filter((server) => server.name === "unpinned")).toHaveLength(2);
      expect(
        starred.servers
          .filter((server) => server.name === "unpinned")
          .every((server) => server.findings.map((finding) => finding.code).join() === "HEALTHY"),
      ).toBe(true);
      expect(rendered(starred)).not.toContain(SECRET);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses comments and trailing commas, and a stale code-only entry still warns", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-jsonc-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = writeJson(root, "mcp.json", unpinnedConfig());
    const ignorePath = join(root, IGNORE_FILENAME);
    const jsonc = `{
      // accepted in this package
      "ignore": [
        { "code": "UNPINNED_PACKAGE", "server": "unpinned", "file": "mcp.json", },
      ],
    }
    `;
    writeFileSync(ignorePath, jsonc);
    const beforeConfig = readFileSync(config);

    try {
      const accepted = await runCheck({ root, includeUserConfig: false });
      expect(exitCode(accepted)).toBe(0);
      expect(accepted.servers.find((server) => server.name === "unpinned")?.findings.map((f) => f.code)).toEqual([
        "HEALTHY",
      ]);
      expect(accepted.servers.some((server) =>
        server.findings.some((finding) => finding.code === "IGNORE_CONFIG"),
      )).toBe(false);
      expect(rendered(accepted)).not.toContain("UNPINNED_PACKAGE");
      expect(rendered(accepted)).not.toContain(SECRET);
      expect(readFileSync(config)).toEqual(beforeConfig);
      expect(readFileSync(ignorePath, "utf8")).toBe(jsonc);
      expect(fetchSpy).not.toHaveBeenCalled();

      writeFileSync(
        ignorePath,
        "{\n  /* nothing here matches */\n  \"ignore\": [\n    { \"code\": \"UNPINNED_PACKAGE\", },\n  ],\n}\n",
      );
      writeJson(root, "mcp.json", {
        mcpServers: { local: { command: "node", args: ["--version"], env: { TOKEN: SECRET } } },
      });
      const stale = await runCheck({ root, includeUserConfig: false });
      expect(exitCode(stale)).toBe(1);
      const warning = stale.servers.find((server) => server.name === "(config)");
      expect(warning?.findings.map((finding) => finding.code)).toEqual(["STALE_IGNORE"]);
      expect(warning?.findings[0]?.message).toContain("UNPINNED_PACKAGE");
      expect(warning?.findings[0]?.message).toContain('server "*"');
      expect(warning?.findings[0]?.message).toContain('file "*"');
      expect(stale.servers.find((server) => server.name === "local")?.status).toBe("ok");
      expect(rendered(stale)).not.toContain(SECRET);
      expect(rendered(stale)).not.toContain("IGNORE_CONFIG");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an exact file entry from suppressing the same code in another file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-ignore-one-file-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rootConfig = writeJson(root, "mcp.json", unpinnedConfig());
    const nestedConfig = writeJson(root, "services/api/mcp.json", unpinnedConfig());
    const ignore = writeJson(
      root,
      IGNORE_FILENAME,
      ignoreFile([{ code: "UNPINNED_PACKAGE", server: "unpinned", file: "mcp.json" }]),
    );
    const before = [rootConfig, nestedConfig, ignore].map((file) => readFileSync(file));

    try {
      const report = await runCheck({ root, includeUserConfig: false, recursive: true });
      const rootServer = report.servers.find((server) => server.file === rootConfig);
      const nestedServer = report.servers.find((server) => server.file === nestedConfig);
      expect(rootServer?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(nestedServer?.findings.some((finding) => finding.code === "UNPINNED_PACKAGE")).toBe(
        true,
      );
      expect(report.summary).toMatchObject({ ok: 1, warn: 1, fail: 0 });
      expect(exitCode(report)).toBe(1);
      expect(rendered(report)).not.toContain(SECRET);
      expect(rendered(report)).not.toContain("STALE_IGNORE");
      expect([rootConfig, nestedConfig, ignore].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
