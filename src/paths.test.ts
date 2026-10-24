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
    expect(pkg.version).toBe("1.5.0");
    expect(readme).toContain("tracks the published 1.5.0 release");
    expect(readme).toContain(
      "`@leon-pixel/mcp-health@1.5.0` is the current npm `latest`.",
    );
    expect(readme).toContain(
      "This repository is `1.5.0` in `package.json`, and the `v1.5.0` tag is published and `v1` points to it.",
    );
    expect(readme).not.toContain("tracks the published 1.4.0 release");
    expect(readme).not.toContain(
      "`@leon-pixel/mcp-health@1.4.0` is the current npm `latest`",
    );
    expect(readme).not.toContain("tracks the published 1.3.0 release");
    expect(readme).not.toContain(
      "`@leon-pixel/mcp-health@1.3.0` is the current npm `latest`",
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
    expect(readme).toContain("npx @leon-pixel/mcp-health check --no-user .");
    expect(readme).toContain("labeled `user`");
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
      "VS Code",
      "Claude Code",
      "Claude Desktop",
      "Continue",
      "Junie",
      "Cline",
      "Gemini CLI",
      "Copilot",
      "Windsurf",
      "Devin",
      "Zed",
      "Codex",
    ]) {
      expect(help).toContain(client);
    }
  });
});

describe("1.5.0 changelog", () => {
  it("covers the unreleased fixes and the new clients", () => {
    const pkg = require("../package.json") as { version: string };
    const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
    const notes = changelogSection(changelog, pkg.version);
    const unreleased = changelog.slice(0, changelog.indexOf("## [1.5.0]"));
    expect(unreleased).toContain("## [Unreleased]");
    expect(unreleased).toContain("MCP_SERVERS_IGNORED");
    expect(unreleased).toContain("#85");
    expect(unreleased).toContain("SCRIPT_NOT_FOUND");
    expect(unreleased).toContain("CODEX_HOME");
    expect(unreleased).toContain("include-user: true");
    expect(unreleased).toContain("#86");
    expect(unreleased).toContain("#87");
    expect(unreleased).toContain("#89");
    expect(notes).not.toContain("MCP_SERVERS_IGNORED");
    expect(pkg.version).toBe("1.5.0");
    expect(notes.startsWith("## [1.5.0] - 2026-10-22")).toBe(true);
    expect(notes).toContain(".github/mcp.json");
    expect(notes).toContain("#68");
    expect(notes).toContain("type: \"local\"");
    expect(notes).toContain("${CLAUDE_PROJECT_DIR}");
    expect(notes).toContain("UNPINNED_PACKAGE");
    expect(notes).toContain("NPM_LATEST");
    expect(notes).toContain("BAD_URL_PROTOCOL");
    expect(notes).toContain("PROBE_SKIPPED");
    expect(notes).toContain("ENV_FILE_MISSING");
    expect(notes).toContain("#81");
    expect(notes).toContain("env.PATH");
    expect(notes).toContain("httpUrl");
    expect(notes).toContain("PLACEHOLDER_ENV");
    expect(notes).toContain("UNRESOLVED_VARIABLE");
    expect(notes).toContain("MISSING_TRANSPORT_TYPE");
    expect(notes).toContain("labeled `user`");
    expect(notes).not.toContain("## [1.4.0]");
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
