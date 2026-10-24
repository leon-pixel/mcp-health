import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpreterScriptArg } from "./check.js";
import { parseConfigFile } from "./parse.js";
import { formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import type { HealthReport } from "./types.js";

const secret = "script-body-secret-do-not-print";
const repo = dirname(fileURLToPath(import.meta.url));

function codes(report: HealthReport, name: string): string[] {
  return (
    report.servers
      .find((server) => server.name === name)
      ?.findings.map((finding) => finding.code) ?? []
  );
}

function writeExe(file: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

describe("interpreter script arguments", () => {
  it("keeps eval, version, python -m, and package args off the script check", () => {
    expect(interpreterScriptArg("node", ["--version"])).toBeUndefined();
    expect(interpreterScriptArg("node", ["-v"])).toBeUndefined();
    expect(interpreterScriptArg("node", ["-e", "process.exit(0)"])).toBeUndefined();
    expect(interpreterScriptArg("node", ["--eval", "process.exit(0)"])).toBeUndefined();
    expect(interpreterScriptArg("node", ["--eval=process.exit(0)"])).toBeUndefined();
    expect(interpreterScriptArg("node", ["server.mjs"])).toBe("server.mjs");
    expect(
      interpreterScriptArg("node", [
        "--experimental-strip-types",
        "--require",
        "./preload.cjs",
        "server.mjs",
      ]),
    ).toBe("server.mjs");
    expect(interpreterScriptArg("node.exe", ["server.mjs"])).toBe("server.mjs");
    expect(interpreterScriptArg("tsx.cmd", ["watch", "server.ts"])).toBe("server.ts");
    expect(interpreterScriptArg("python", ["-m", "missing_module"])).toBeUndefined();
    expect(interpreterScriptArg("python3", ["-c", "pass"])).toBeUndefined();
    expect(interpreterScriptArg("python", ["-W", "ignore", "server.py"])).toBe("server.py");
    expect(interpreterScriptArg("python.exe", ["server.py"])).toBe("server.py");
    expect(interpreterScriptArg("deno", ["run", "--allow-net", "server.ts"])).toBe(
      "server.ts",
    );
    expect(interpreterScriptArg("deno", ["eval", "1"])).toBeUndefined();
    expect(interpreterScriptArg("bun", ["server.mjs"])).toBe("server.mjs");
    expect(interpreterScriptArg("bun", ["run", "dev"])).toBeUndefined();
    expect(interpreterScriptArg("bun", ["run", "src/index.ts"])).toBe("src/index.ts");
    expect(interpreterScriptArg("bun", ["--version"])).toBeUndefined();
    expect(interpreterScriptArg("npx", ["-y", "left-pad@1.0.0"])).toBeUndefined();
    expect(interpreterScriptArg("uvx", ["some-tool@1.2.3"])).toBeUndefined();
    expect(interpreterScriptArg("bunx", ["some-server@1.0.0"])).toBeUndefined();
  });
});

describe("stdio cwd and interpreter scripts", () => {
  it("uses cwd for the clients that launch there and fails a missing script without reading it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-cwd-home-"));
    const sub = join(root, "sub");
    const empty = join(root, "empty");
    try {
      mkdirSync(join(root, ".vscode"), { recursive: true });
      mkdirSync(join(root, ".gemini"), { recursive: true });
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(join(root, ".github"), { recursive: true });
      mkdirSync(empty, { recursive: true });
      writeExe(join(sub, "tool"));
      writeExe(join(root, "root-tool"));
      writeFileSync(join(root, "present.mjs"), `export const token = ${JSON.stringify(secret)};\n`);
      writeFileSync(join(sub, "server.mjs"), "export {};\n");
      writeFileSync(join(root, "preload.cjs"), "module.exports = {};\n");

      const vscode = {
        servers: {
          toolInSub: { type: "stdio", command: "./tool", cwd: "sub" },
          scriptInSub: { type: "stdio", command: "node", args: ["server.mjs"], cwd: "sub" },
          scriptOnlyAtRoot: {
            type: "stdio",
            command: "node",
            args: ["present.mjs"],
            cwd: "empty",
          },
          omitted: { type: "stdio", command: "node", args: ["present.mjs"] },
          missingAtRoot: { type: "stdio", command: "node", args: ["server.mjs"] },
          expanded: { type: "stdio", command: "./tool", cwd: "${workspaceFolder}/sub" },
          absolute: { type: "stdio", command: "./tool", cwd: sub },
          unresolved: {
            type: "stdio",
            command: "./root-tool",
            cwd: "${env:MCP_HEALTH_NO_SUCH_CWD}/elsewhere",
          },
        },
      };
      const vscodeFile = join(root, ".vscode", "mcp.json");
      const vscodeText = JSON.stringify(vscode, null, 2);
      writeFileSync(vscodeFile, vscodeText);

      writeFileSync(
        join(root, ".gemini", "settings.json"),
        JSON.stringify({
          mcpServers: { geminiTool: { command: "./tool", cwd: "sub" } },
        }),
      );
      const codexText = [
        "[mcp_servers.codexTool]",
        'command = "./tool"',
        'cwd = "sub"',
        "",
        "[mcp_servers.badCwd]",
        'command = "node"',
        "cwd = 1",
        "",
      ].join("\n");
      const codexFile = join(root, ".codex", "config.toml");
      writeFileSync(codexFile, codexText);
      const invalidCodex = parseConfigFile(codexFile);
      expect(invalidCodex.format).toBe("invalid");
      expect(invalidCodex.error).toMatch(/cwd/);

      writeFileSync(
        codexFile,
        [
          "[mcp_servers.codexTool]",
          'command = "./tool"',
          'args = []',
          'cwd = "sub"',
          "",
        ].join("\n"),
      );
      const parsedCodex = parseConfigFile(codexFile);
      expect(parsedCodex.format).toBe("codex");
      expect(parsedCodex.servers[0]?.raw.cwd).toBe("sub");

      writeFileSync(
        join(root, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            ignoredCwd: { command: "./tool", cwd: "sub" },
            cwdIgnoredForScript: {
              command: "node",
              args: ["present.mjs"],
              cwd: "empty",
            },
            missingScript: { command: "node", args: ["missing.mjs"] },
            presentScript: { command: "node", args: ["present.mjs"] },
            eval: { command: "node", args: ["-e", "process.exit(0)"] },
            version: { command: "node", args: ["--version"] },
            pythonModule: { command: "python", args: ["-m", "missing_module"] },
            pythonScript: { command: "python3", args: ["missing.py"] },
            nodeExe: { command: "node.exe", args: ["missing.mjs"] },
            denoRun: { command: "deno", args: ["run", "--allow-net", "missing.ts"] },
            tsxWatch: { command: "tsx", args: ["watch", "missing.ts"] },
            bunFile: { command: "bun", args: ["missing.mjs"] },
            bunScriptName: { command: "bun", args: ["run", "dev"] },
            bunRunFile: { command: "bun", args: ["run", "src/index.ts"] },
            npxPinned: { command: "npx", args: ["-y", "left-pad@1.0.0"] },
            uvxPkg: { command: "uvx", args: ["some-tool@1.2.3"] },
            stripTypes: {
              command: "node",
              args: ["--experimental-strip-types", "missing.ts"],
            },
            requireThenScript: {
              command: "node",
              args: ["--require", "./preload.cjs", "missing.mjs"],
            },
            pythonWarn: { command: "python", args: ["-W", "ignore", "missing.py"] },
          },
        }),
      );
      writeFileSync(
        join(root, ".github", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            projectCopilot: { command: "./tool", args: [], cwd: "sub" },
          },
        }),
      );

      const userVsCode = join(home, ".config", "Code", "User", "mcp.json");
      const userCopilot = join(home, ".copilot", "mcp-config.json");
      mkdirSync(join(userVsCode, ".."), { recursive: true });
      mkdirSync(join(userCopilot, ".."), { recursive: true });
      writeFileSync(
        userVsCode,
        JSON.stringify({
          servers: { vscodeUser: { command: "./tool", cwd: "sub" } },
        }),
      );
      writeFileSync(
        userCopilot,
        JSON.stringify({
          mcpServers: { copilotUser: { command: "./tool", cwd: "sub" } },
        }),
      );

      const locate = { home, platform: "linux" as const, env: {} };
      const report = await runCheck({
        root,
        includeUserConfig: true,
        ...locate,
      });
      const rendered = `${formatHuman(report)}\n${formatJson(report)}`;
      expect(rendered).not.toContain(secret);
      expect(readFileSync(vscodeFile, "utf8")).toBe(vscodeText);

      expect(codes(report, "toolInSub")).toEqual(["HEALTHY"]);
      expect(codes(report, "scriptInSub")).toEqual(["HEALTHY"]);
      expect(codes(report, "scriptOnlyAtRoot")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "scriptOnlyAtRoot")).not.toContain("HEALTHY");
      expect(codes(report, "omitted")).toEqual(["HEALTHY"]);
      expect(codes(report, "missingAtRoot")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "expanded")).toEqual(["HEALTHY"]);
      expect(codes(report, "absolute")).toEqual(["HEALTHY"]);
      expect(codes(report, "unresolved")).toContain("UNRESOLVED_VARIABLE");
      expect(codes(report, "unresolved")).not.toContain("COMMAND_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "unresolved")
          ?.findings.find((finding) => finding.code === "UNRESOLVED_VARIABLE")?.message,
      ).toContain("cwd");

      expect(codes(report, "geminiTool")).toEqual(["HEALTHY"]);
      expect(codes(report, "codexTool")).toEqual(["HEALTHY"]);
      expect(codes(report, "ignoredCwd")).toContain("COMMAND_NOT_FOUND");
      expect(codes(report, "cwdIgnoredForScript")).toEqual(["HEALTHY"]);
      expect(codes(report, "projectCopilot")).toContain("COMMAND_NOT_FOUND");

      expect(codes(report, "missingScript")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "missingScript")).not.toContain("HEALTHY");
      expect(
        report.servers
          .find((server) => server.name === "missingScript")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("missing.mjs");
      expect(codes(report, "presentScript")).toEqual(["HEALTHY"]);
      expect(codes(report, "eval")).toEqual(["HEALTHY"]);
      expect(codes(report, "version")).toEqual(["HEALTHY"]);
      expect(codes(report, "pythonModule")).not.toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "pythonScript")).toContain("SCRIPT_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "pythonScript")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("missing.py");
      expect(codes(report, "nodeExe")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "denoRun")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "tsxWatch")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "bunFile")).toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "bunScriptName")).not.toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "bunRunFile")).toContain("SCRIPT_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "bunRunFile")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("src/index.ts");
      expect(codes(report, "npxPinned")).not.toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "uvxPkg")).not.toContain("SCRIPT_NOT_FOUND");
      expect(codes(report, "stripTypes")).toContain("SCRIPT_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "stripTypes")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("missing.ts");
      expect(codes(report, "requireThenScript")).toContain("SCRIPT_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "requireThenScript")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("missing.mjs");
      expect(
        report.servers
          .find((server) => server.name === "requireThenScript")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).not.toContain("preload.cjs");
      expect(codes(report, "pythonWarn")).toContain("SCRIPT_NOT_FOUND");
      expect(
        report.servers
          .find((server) => server.name === "pythonWarn")
          ?.findings.find((finding) => finding.code === "SCRIPT_NOT_FOUND")?.message,
      ).toContain("missing.py");

      expect(codes(report, "vscodeUser")).toEqual(["HEALTHY"]);
      expect(report.servers.find((server) => server.name === "vscodeUser")?.scope).toBe(
        "user",
      );
      expect(codes(report, "copilotUser")).toEqual(["HEALTHY"]);
      expect(report.servers.find((server) => server.name === "copilotUser")?.scope).toBe(
        "user",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("probes in the configured subdirectory and fails when spawn stays at the scan root", async () => {
      const root = mkdtempSync(join(tmpdir(), "mcp-health-cwd-probe-"));
    const sub = join(root, "sub");
    try {
      mkdirSync(join(root, ".vscode"), { recursive: true });
      mkdirSync(sub, { recursive: true });
      const reply = join(repo, "..", "fixtures", "support", "stdio-reply.mjs");
      writeFileSync(
        join(sub, "server.mjs"),
        [
          'import { realpathSync } from "node:fs";',
          `import { replyToInitialize } from ${JSON.stringify(reply)};`,
          "const expected = process.argv[2];",
          "if (!expected || realpathSync(process.cwd()) !== realpathSync(expected)) {",
          '  process.stderr.write("bad-cwd\\n");',
          "  process.exit(4);",
          "}",
          "replyToInitialize();",
          "",
        ].join("\n"),
      );
      const configPath = join(root, ".vscode", "mcp.json");
      const before = JSON.stringify(
        {
          servers: {
            inSubdir: {
              type: "stdio",
              command: "node",
              args: ["server.mjs", sub],
              cwd: "sub",
            },
            atRoot: {
              type: "stdio",
              command: "node",
              args: ["sub/server.mjs", sub],
            },
          },
        },
        null,
        2,
      );
      writeFileSync(configPath, before);

      const report = await runCheck({
        root,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
        env: {},
      });
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(codes(report, "inSubdir")).toEqual(
        expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]),
      );
      expect(codes(report, "inSubdir")).not.toContain("PROBE_FAILED");
      expect(codes(report, "atRoot")).toContain("PROBE_FAILED");
      expect(codes(report, "atRoot")).not.toContain("PROBE_OK");
      expect(
        report.servers
          .find((server) => server.name === "atRoot")
          ?.findings.find((finding) => finding.code === "PROBE_FAILED")?.message,
      ).toMatch(/code 4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
