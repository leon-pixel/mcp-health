import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { exitCode, formatHuman } from "./report.js";
import { runCheck } from "./run.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(repo, "README.md"), "utf8");

const FIXTURES = [
  { name: "issues" as const, code: 2, command: "mcp-health check --no-user fixtures/issues" },
  { name: "healthy" as const, code: 0, command: "mcp-health check --no-user fixtures/healthy" },
];

function demoText(root: string, relative: string, reportText: string): string {
  return reportText.split(root).join(relative).trimEnd();
}

function castOutput(raw: string): string {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const header = JSON.parse(lines[0] ?? "") as {
    version?: number;
    env?: Record<string, string>;
  };
  expect(header.version).toBe(2);
  expect(header.env?.HOME).toBeUndefined();
  expect(header.env?.PWD).toBeUndefined();
  let text = "";
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line) as [number, string, string];
    expect(event[1]).toBe("o");
    text += event[2];
  }
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function sceneBody(cast: string, command: string): string {
  const marker = `$ ${command}\n`;
  const start = cast.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + marker.length;
  const next = cast.indexOf("\n$ ", from);
  const chunk = next === -1 ? cast.slice(from) : cast.slice(from, next);
  return chunk.replace(/\n+$/, "");
}

/** GIF comment extension blocks (0x21 0xFE). Image data is ignored unless it parses. */
function gifComments(buf: Buffer): string[] {
  const comments: string[] = [];
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] !== 0x21 || buf[i + 1] !== 0xfe) continue;
    i += 2;
    const chunks: Buffer[] = [];
    while (i < buf.length && buf[i] !== 0) {
      const size = buf[i] ?? 0;
      i += 1;
      chunks.push(buf.subarray(i, i + size));
      i += size;
    }
    comments.push(Buffer.concat(chunks).toString("utf8"));
  }
  return comments;
}

describe("README demo", () => {
  it("keeps the cast and GIF comment on current check output", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const expected: Record<string, string> = {};
      for (const fixture of FIXTURES) {
        const root = resolve(repo, "fixtures", fixture.name);
        const report = await runCheck({ root, includeUserConfig: false });
        expect(exitCode(report)).toBe(fixture.code);
        const text = demoText(root, `fixtures/${fixture.name}`, formatHuman(report));
        expect(text).not.toContain(root);
        expect(text).toContain("project");
        expected[fixture.name] = text;
      }

      expect(expected.issues).toContain(
        'Install "definitely-not-a-real-mcp-binary-xyz" so it is on PATH',
      );
      expect(expected.issues).toContain(
        'Change the package argument to "@modelcontextprotocol/server-memory@<version>".',
      );
      expect(expected.issues).toContain('Add a stdio "command"');
      expect(expected.issues).toContain('Replace env "API_KEY"');
      expect(expected.issues).toContain('Set "url" to an absolute URL');
      expect(expected.healthy).toContain("[OK] filesystem");
      expect(expected.healthy).not.toContain("[FAIL]");
      expect(expected.healthy).not.toContain("[WARN]");

      const castRaw = readFileSync(join(repo, "docs", "demo.cast"), "utf8");
      const cast = castOutput(castRaw);
      for (const fixture of FIXTURES) {
        expect(cast).toContain(`$ ${fixture.command}\n`);
        expect(sceneBody(cast, fixture.command)).toBe(expected[fixture.name]);
      }

      const gif = readFileSync(join(repo, "docs", "demo.gif"));
      expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      const comment = gifComments(gif)
        .map((block) => {
          try {
            return JSON.parse(block) as unknown;
          } catch {
            return undefined;
          }
        })
        .find(
          (value): value is { issues: string; healthy: string } =>
            typeof value === "object" &&
            value !== null &&
            "issues" in value &&
            "healthy" in value &&
            typeof value.issues === "string" &&
            typeof value.healthy === "string",
        );
      expect(comment?.issues).toBe(expected.issues);
      expect(comment?.healthy).toBe(expected.healthy);

      const home = homedir();
      for (const blob of [castRaw, comment?.issues ?? "", comment?.healthy ?? ""]) {
        expect(blob).not.toContain(home);
        expect(blob).not.toContain("/home/");
        expect(blob).not.toContain("/Users/");
        expect(blob).not.toContain("YOUR_KEY_HERE");
      }
      expect(fetchSpy).not.toHaveBeenCalled();

      const demo = readme.slice(readme.indexOf("## Demo"), readme.indexOf("## Install"));
      expect(demo).toContain("docs/demo.gif");
      expect(demo).toContain("docs/demo.cast");
      expect(demo).toContain("python3 scripts/render-demo-gif.py");
      expect(demo).toContain("python3 scripts/record-demo-cast.py");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
