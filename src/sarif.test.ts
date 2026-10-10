import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCheck } from "./run.js";
import { buildSarif, formatAnnotations } from "./sarif.js";
import type { HealthReport } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const fixtures = join(repo, "fixtures");

type SarifResult = {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
    };
  }>;
};

describe("buildSarif", () => {
  it("maps fixtures/issues findings to SARIF 2.1.0 rules", async () => {
    const report = await runCheck({
      root: join(fixtures, "issues"),
      includeUserConfig: false,
    });
    const sarif = buildSarif(report) as {
      version: string;
      runs: Array<{
        tool: {
          driver: {
            name: string;
            rules: Array<{ id: string }>;
          };
        };
        results: SarifResult[];
      }>;
    };

    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run?.tool.driver.name).toBe("mcp-health");
    const results = run?.results ?? [];
    const byRule = new Map(results.map((result) => [result.ruleId, result]));
    expect(byRule.get("COMMAND_NOT_FOUND")?.level).toBe("error");
    expect(byRule.get("UNPINNED_PACKAGE")?.level).toBe("warning");
    expect(byRule.get("NO_TRANSPORT")?.level).toBe("error");
    expect(byRule.get("BAD_URL")?.level).toBe("error");
    expect(results.some((result) => result.ruleId === "HEALTHY")).toBe(false);
    expect(results.every((result) => result.level !== "note")).toBe(true);

    const broken = byRule.get("COMMAND_NOT_FOUND");
    expect(broken?.message.text).toContain("broken-binary");
    expect(broken?.message.text.length).toBeGreaterThan("broken-binary".length);
    expect(broken?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      "mcp.json",
    );
    expect(broken?.locations[0]?.physicalLocation.region.startLine).toBe(3);

    const ruleIds = new Set(run?.tool.driver.rules.map((rule) => rule.id));
    for (const result of results) expect(ruleIds.has(result.ruleId)).toBe(true);
  });

  it("escapes annotation properties and skips ok findings", () => {
    const scanRoot = join(fixtures, "issues");
    const file = join(scanRoot, "mcp.json");
    const report: HealthReport = {
      scannedAt: "2026-10-10T00:00:00.000Z",
      root: scanRoot,
      files: [file],
      summary: { ok: 0, warn: 0, fail: 1, files: 1, servers: 1 },
      servers: [
        {
          name: "odd",
          file,
          transport: "stdio",
          status: "fail",
          findings: [
            {
              severity: "fail",
              code: "BAD",
              message: "100% broken\nnext",
              server: "odd",
              file,
            },
          ],
        },
      ],
    };

    const text = formatAnnotations(report);
    expect(text).toContain("::error ");
    expect(text).toContain("title=BAD");
    expect(text).toContain("file=mcp.json");
    expect(text).toContain("100%25 broken%0Anext");

    const clean: HealthReport = {
      ...report,
      servers: [
        {
          ...report.servers[0]!,
          status: "ok",
          findings: [
            {
              severity: "ok",
              code: "HEALTHY",
              message: "fine",
              server: "odd",
              file,
            },
          ],
        },
      ],
    };
    expect(formatAnnotations(clean)).toBe("");
    expect(buildSarif(clean)).toMatchObject({
      version: "2.1.0",
      runs: [{ results: [] }],
    });
  });
});

describe("cli sarif and tools flags", () => {
  const tsx = join(repo, "node_modules", ".bin", "tsx");

  function runCli(args: string[]) {
    return spawnSync(tsx, [join(repo, "src", "cli.ts"), ...args], {
      encoding: "utf8",
      cwd: repo,
    });
  }

  it("leaves the default check output and exit code unchanged", () => {
    const result = runCli(["check", "--no-user", "fixtures/issues"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("COMMAND_NOT_FOUND");
    expect(result.stdout).not.toContain("sarif-2.1.0");
    expect(result.stdout).not.toContain("::error");
    expect(result.stderr).not.toContain("::error");
  });

  it("writes SARIF to a file and annotations to stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-sarif-"));
    const sarifPath = join(dir, "out.sarif");
    try {
      const result = runCli([
        "check",
        "--no-user",
        "--json",
        "--sarif",
        sarifPath,
        "--github-annotations",
        "fixtures/issues",
      ]);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("COMMAND_NOT_FOUND");
      expect(result.stdout).not.toContain("sarif-2.1.0");
      expect(result.stdout).not.toContain("::error");
      expect(result.stderr).toContain("::error");
      expect(result.stderr).toContain("COMMAND_NOT_FOUND");
      const sarif = JSON.parse(readFileSync(sarifPath, "utf8")) as {
        version: string;
        runs: Array<{ results: Array<{ ruleId: string }> }>;
      };
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0]?.results.map((item) => item.ruleId)).toContain(
        "COMMAND_NOT_FOUND",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips tools/list when --no-tools is set", () => {
    const result = runCli([
      "check",
      "--no-user",
      "--probe",
      "--no-tools",
      "--probe-timeout",
      "4000",
      "fixtures/probe-tools",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PROBE_OK");
    expect(result.stdout).not.toContain("EMPTY_TOOLS");
    expect(result.stdout).not.toContain("super-secret-tool-token");
  });
});
