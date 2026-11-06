import { execPath } from "node:process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { commandLookupEnv, resolveCommandOnPath } from "./check.js";
import { runCheck } from "./run.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("VS Code stdio PATH", () => {
  it("appends VS Code PATH after the process PATH and still replaces it elsewhere", () => {
    const base = { PATH: "/usr/bin" };
    const vscode = { file: "/repo/.vscode/mcp.json" };
    expect(commandLookupEnv({ PATH: "/opt/bin" }, base, "linux", vscode).PATH).toBe(
      "/usr/bin:/opt/bin",
    );
    expect(
      commandLookupEnv({ PATH: "/opt:/extra" }, base, "linux", vscode).PATH,
    ).toBe("/usr/bin:/opt:/extra");
    expect(
      commandLookupEnv({ PATH: "/opt/bin" }, { PATH: "" }, "linux", vscode).PATH,
    ).toBe("/opt/bin");
    expect(commandLookupEnv({ PATH: "/opt/bin" }, {}, "linux", vscode).PATH).toBe(
      "/opt/bin",
    );
    expect(
      commandLookupEnv({ Path: "/opt/bin" }, base, "linux", vscode).PATH,
    ).toBe("/usr/bin");
    expect(
      commandLookupEnv({ PATH: "${env:MISSING}/bin" }, base, "linux", vscode),
    ).toBe(base);
    expect(
      commandLookupEnv({ PATH: "/opt/bin" }, base, "linux", {
        file: "/repo/mcp.json",
      }).PATH,
    ).toBe("/opt/bin");
    expect(
      commandLookupEnv({ PATH: "/opt/bin" }, base, "linux", {
        file: "/repo/custom-servers.json",
      }).PATH,
    ).toBe("/opt/bin");

    expect(
      commandLookupEnv({ Path: "C:\\extra" }, { PATH: "C:\\Windows" }, "win32", {
        file: "C:\\repo\\.vscode\\mcp.json",
      }).PATH,
    ).toBe("C:\\Windows;C:\\extra");
    expect(
      commandLookupEnv({ PATH: "C:\\extra" }, { Path: "C:\\Windows" }, "win32", {
        file: "C:\\repo\\.VSCode\\mcp.json",
      }).PATH,
    ).toBe("C:\\Windows;C:\\extra");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: "/repo/.VSCode/mcp.json",
      }).PATH,
    ).toBe("/opt");

    const home = "/tmp/mcp-health-path-home";
    const xdg = "/tmp/mcp-health-path-xdg";
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(home, ".config", "Code", "User", "mcp.json"),
        home,
        platform: "linux",
        env: {},
      }).PATH,
    ).toBe("/usr/bin:/opt");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(xdg, "Code", "User", "mcp.json"),
        home,
        platform: "linux",
        env: { XDG_CONFIG_HOME: xdg },
      }).PATH,
    ).toBe("/usr/bin:/opt");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "mcp.json",
        ),
        home,
        platform: "darwin",
        env: {},
      }).PATH,
    ).toBe("/usr/bin:/opt");
    const appData = join(home, "AppData", "Roaming");
    expect(
      commandLookupEnv({ Path: "C:\\extra" }, { PATH: "C:\\Windows" }, "win32", {
        file: join(appData, "Code", "User", "mcp.json"),
        home,
        platform: "win32",
        env: { APPDATA: appData },
      }).PATH,
    ).toBe("C:\\Windows;C:\\extra");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(home, ".config", "Code - Insiders", "User", "mcp.json"),
        home,
        platform: "linux",
        env: {},
      }).PATH,
    ).toBe("/usr/bin:/opt");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(home, ".config", "VSCodium", "User", "mcp.json"),
        home,
        platform: "linux",
        env: {},
      }).PATH,
    ).toBe("/usr/bin:/opt");
    expect(
      commandLookupEnv({ Path: "C:\\extra" }, { PATH: "C:\\Windows" }, "win32", {
        file: join(appData, "Code - Insiders", "User", "mcp.json"),
        home,
        platform: "win32",
        env: { APPDATA: "  " },
      }).PATH,
    ).toBe("C:\\Windows;C:\\extra");
    expect(
      commandLookupEnv({ PATH: "/opt" }, base, "linux", {
        file: join(home, ".copilot", "mcp-config.json"),
        home,
        platform: "linux",
        env: {},
      }).PATH,
    ).toBe("/opt");
  });

  it("searches the process PATH before the appended VS Code PATH", () => {
    const first = mkdtempSync(join(tmpdir(), "mcp-health-path-first-"));
    const second = mkdtempSync(join(tmpdir(), "mcp-health-path-second-"));
    try {
      for (const dir of [first, second]) {
        const tool = join(dir, "tool");
        writeFileSync(tool, "#!/bin/sh\nexit 0\n");
        chmodSync(tool, 0o755);
      }
      const onlySecond = join(second, "only-second");
      writeFileSync(onlySecond, "#!/bin/sh\nexit 0\n");
      chmodSync(onlySecond, 0o755);

      const appended = commandLookupEnv(
        { PATH: second },
        { PATH: first },
        "linux",
        { file: "/repo/.vscode/mcp.json" },
      );
      expect(resolveCommandOnPath("tool", appended, "linux")).toBe(
        join(first, "tool"),
      );
      expect(resolveCommandOnPath("only-second", appended, "linux")).toBe(
        onlySecond,
      );
      expect(resolveCommandOnPath("neither", appended, "linux")).toBeUndefined();

      const replaced = commandLookupEnv(
        { PATH: second },
        { PATH: first },
        "linux",
        { file: "/repo/mcp.json" },
      );
      expect(resolveCommandOnPath("tool", replaced, "linux")).toBe(
        join(second, "tool"),
      );
      expect(resolveCommandOnPath("only-second", replaced, "linux")).toBe(
        onlySecond,
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("appends PATH for VS Code configs and replaces it for other clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-vscode-path-"));
    const extra = mkdtempSync(join(tmpdir(), "mcp-health-vscode-extra-"));
    const empty = mkdtempSync(join(tmpdir(), "mcp-health-vscode-empty-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-vscode-user-"));
    const appendedMarker = join(dir, "appended-path.txt");
    const replacedMarker = join(dir, "replaced-path.txt");
    const userMarker = join(dir, "user-path.txt");
    const userRoot = mkdtempSync(join(tmpdir(), "mcp-health-vscode-user-root-"));
    try {
      const record = join(dir, "record-path.mjs");
      writeFileSync(
        record,
        `import { writeFileSync } from "node:fs";\nimport { replyToInitialize } from ${JSON.stringify(join(fixtures, "support", "stdio-reply.mjs"))};\nwriteFileSync(process.env.MCP_HEALTH_PATH_MARKER, process.env.PATH ?? "");\nreplyToInitialize();\n`,
      );
      const server = join(extra, "server.mjs");
      writeFileSync(
        server,
        `import { replyToInitialize } from ${JSON.stringify(join(fixtures, "support", "stdio-reply.mjs"))};\nreplyToInitialize();\n`,
      );
      const onlyExtra = join(extra, "only-on-server-path");
      writeFileSync(
        onlyExtra,
        `#!/bin/sh\nexec ${JSON.stringify(execPath)} ${JSON.stringify(server)}\n`,
      );
      chmodSync(onlyExtra, 0o755);

      mkdirSync(join(dir, ".vscode"));
      writeFileSync(
        join(dir, ".vscode", "mcp.json"),
        JSON.stringify({
          servers: {
            pathHidesNode: {
              type: "stdio",
              command: "node",
              args: [record],
              env: {
                PATH: empty,
                MCP_HEALTH_PATH_MARKER: appendedMarker,
              },
            },
            onlyOnServer: {
              command: "only-on-server-path",
              env: { PATH: extra },
            },
            missing: {
              command: "mcp-health-no-such-command",
              env: { PATH: extra },
            },
            unresolved: {
              command: "node",
              args: ["-e", "process.exit(0)"],
              env: { PATH: "${env:MCP_HEALTH_PATH_DOES_NOT_EXIST}/bin" },
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            hidden: {
              command: "node",
              args: ["-e", "process.exit(0)"],
              env: { PATH: empty },
            },
            replaced: {
              command: execPath,
              args: [record],
              env: {
                PATH: extra,
                MCP_HEALTH_PATH_MARKER: replacedMarker,
              },
            },
          },
        }),
      );

      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      const codes = (name: string) =>
        report.servers
          .find((server) => server.name === name)
          ?.findings.map((finding) => finding.code) ?? [];

      expect(codes("pathHidesNode")).toEqual(
        expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]),
      );
      expect(codes("pathHidesNode")).not.toContain("COMMAND_NOT_FOUND");
      expect(readFileSync(appendedMarker, "utf8")).toBe(
        `${process.env.PATH}${delimiter}${empty}`,
      );
      expect(codes("onlyOnServer")).toEqual(
        expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]),
      );
      expect(codes("onlyOnServer")).not.toContain("COMMAND_NOT_FOUND");
      expect(codes("missing")).toContain("COMMAND_NOT_FOUND");
      expect(codes("unresolved")).toContain("UNRESOLVED_VARIABLE");
      expect(codes("unresolved")).not.toContain("COMMAND_NOT_FOUND");
      expect(codes("hidden")).toContain("COMMAND_NOT_FOUND");
      expect(codes("replaced")).toEqual(
        expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]),
      );
      expect(readFileSync(replacedMarker, "utf8")).toBe(extra);

      const userFile = join(home, ".config", "Code", "User", "mcp.json");
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(
        userFile,
        JSON.stringify({
          servers: {
            vscodeUser: {
              command: "node",
              args: [record],
              env: {
                PATH: extra,
                MCP_HEALTH_PATH_MARKER: userMarker,
              },
            },
          },
        }),
      );
      const userReport = await runCheck({
        root: userRoot,
        includeUserConfig: true,
        probe: true,
        probeTimeoutMs: 4000,
        home,
        platform: "linux",
        env: {},
      });
      const userCodes =
        userReport.servers
          .find((server) => server.name === "vscodeUser")
          ?.findings.map((finding) => finding.code) ?? [];
      expect(userCodes).toEqual(expect.arrayContaining(["PROBE_OK", "TOOLS_OK"]));
      expect(userCodes).not.toContain("COMMAND_NOT_FOUND");
      expect(readFileSync(userMarker, "utf8")).toBe(
        `${process.env.PATH}${delimiter}${extra}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
});
