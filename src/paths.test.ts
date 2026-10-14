import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minVersion, satisfies } from "semver";
import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/changelog-section.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

describe("cli paths", () => {
  const tsx = join(repo, "node_modules", ".bin", "tsx");

  it("resolves a relative -f path from cwd, not the scan root", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-health-rel-"));
    const cwd = join(base, "cwd");
    const root = join(base, "root");
    mkdirSync(cwd);
    mkdirSync(root);
    try {
      writeFileSync(
        join(cwd, "mcp.json"),
        JSON.stringify({
          mcpServers: { local: { command: "node", args: ["--version"] } },
        }),
      );
      const result = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "-f", "mcp.json", root],
        { encoding: "utf8", cwd },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("HEALTHY");
      expect(result.stdout).not.toContain("FILE_NOT_FOUND");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("changelogSection", () => {
  it("returns only the requested version", () => {
    const markdown = [
      "# Changelog",
      "",
      "## [1.2.1] - 2026-10-10",
      "",
      "Patch notes.",
      "",
      "## [1.2.0] - 2026-10-10",
      "",
      "Older notes.",
      "",
    ].join("\n");
    const section = changelogSection(markdown, "1.2.1");
    expect(section).toContain("Patch notes.");
    expect(section).not.toContain("Older notes.");
    expect(section.startsWith("## [1.2.1]")).toBe(true);
  });
});

describe("readme release lines", () => {
  it("keeps the published release and the package version consistent", () => {
    const pkg = require("../package.json") as { version: string };
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    expect(pkg.version).toBe("1.3.0");
    expect(readme).toContain("tracks the published 1.3.0 release");
    expect(readme).toContain(
      "`@leon-pixel/mcp-health@1.3.0` is the current npm `latest`.",
    );
    expect(readme).toContain(
      "This repository is `1.3.0` in `package.json`, and the `v1.3.0` tag is published and `v1` points to it.",
    );
    expect(readme).not.toContain("tracks the published 1.2.1 release");
    expect(readme).not.toContain(
      "`@leon-pixel/mcp-health@1.2.1` is the current npm `latest`",
    );
    expect(readme).toContain("path: services/api");
    expect(readme).toContain("fail-on-missing: true");
    expect(readme).toContain("upload-sarif: true");
    expect(readme).toContain("security-events: write");
    expect(readme).toContain(
      "npx --yes @leon-pixel/mcp-health check --no-user",
    );
    expect(readme).toContain("pass_filenames: false");
    expect(readme).not.toContain("tracks the published 1.2.0 release");
    expect(readme).not.toContain(
      "`@leon-pixel/mcp-health@1.2.0` is the current npm `latest`",
    );
  });
});

describe("--no-user help", () => {
  it("names every user-level client the flag skips", () => {
    const tsx = join(repo, "node_modules", ".bin", "tsx");
    const result = spawnSync(
      tsx,
      [join(repo, "src", "cli.ts"), "check", "--help"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/g, " ");
    for (const client of [
      "Cursor",
      "Claude Code",
      "Claude Desktop",
      "Continue",
      "Junie",
      "Cline",
      "Windsurf",
      "Devin",
      "Zed",
      "Codex",
    ]) {
      expect(help).toContain(client);
    }
  });
});

describe("1.3.0 changelog", () => {
  it("covers the unreleased fixes and the new clients", () => {
    const pkg = require("../package.json") as { version: string };
    const notes = changelogSection(
      readFileSync(join(repo, "CHANGELOG.md"), "utf8"),
      pkg.version,
    );
    expect(notes.startsWith("## [1.3.0]")).toBe(true);
    expect(notes).toContain("~/.claude.json");
    expect(notes).toContain("Continue");
    expect(notes).toContain("Junie");
    expect(notes).toContain("Cline");
    expect(notes).toContain("CLAUDE_CONFIG_DIR");
    expect(notes).toContain("CLINE_MCP_SETTINGS_PATH");
    expect(notes).toContain("CLINE_DATA_DIR");
    expect(notes).toContain("An empty server map still exits 1");
    expect(notes).toContain("--probe-timeout");
    expect(notes).toContain("MSIX");
    expect(notes).not.toContain("## [1.2.1]");
  });
});

describe("engines", () => {
  it("declares a Node range that satisfies commander", () => {
    const ours = require("../package.json") as { engines: { node: string } };
    const commander = JSON.parse(
      readFileSync(join(repo, "node_modules", "commander", "package.json"), "utf8"),
    ) as { engines: { node: string } };
    const minimum = minVersion(ours.engines.node);
    expect(minimum).toBeTruthy();
    expect(satisfies(minimum!, commander.engines.node)).toBe(true);
    expect(satisfies("20.19.0", commander.engines.node)).toBe(false);
  });
});
