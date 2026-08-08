import { describe, expect, it } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersionPinned, extractNpxPackage } from "./check.js";
import { parseConfigFile } from "./parse.js";
import { runCheck } from "./run.js";
import { splitPackageSpec, isVersionDrift } from "./npm.js";
import { discoverConfigPaths, __testing } from "./discover.js";

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
});

describe("discoverConfigPaths", () => {
  it("exposes project candidates including claude settings", () => {
    expect(__testing.PROJECT_CANDIDATES).toContain(".claude/settings.json");
    expect(__testing.claudeDesktopPaths().length).toBeGreaterThan(0);
  });

  it("finds fixture configs without user paths", () => {
    const found = discoverConfigPaths(join(fixtures, "healthy"), {
      includeUserConfig: false,
    });
    expect(found.some((p) => p.endsWith(".cursor/mcp.json"))).toBe(true);
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
});

describe("runCheck", () => {
  it("reports healthy fixture without fails", async () => {
    const report = await runCheck({
      root: join(fixtures, "healthy"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.servers).toBeGreaterThan(0);
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
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("PROBE_OK");
  });
});
