import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isVersionPinned, extractNpxPackage } from "./check.js";
import { parseConfigFile } from "./parse.js";
import { runCheck } from "./run.js";

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
  it("reports healthy fixture without fails", () => {
    const report = runCheck({
      root: join(fixtures, "healthy"),
      includeUserConfig: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.servers).toBeGreaterThan(0);
  });

  it("flags broken fixture issues", () => {
    const report = runCheck({
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
});
