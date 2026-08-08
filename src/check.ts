import type { ConfigFile, Finding, Severity } from "./types.js";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function commandOnPath(command: string): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return existsSync(command);
    }
  }

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, command))) return true;
  }
  return false;
}

/** True when package ref includes an explicit version after the name. */
export function isVersionPinned(pkg: string): boolean {
  if (pkg.startsWith("@")) {
    // @scope/name@version
    return /^@[^/]+\/[^@]+@.+$/.test(pkg);
  }
  // name@version
  return /^[^@]+@.+$/.test(pkg);
}

export function extractNpxPackage(command: string, args: string[]): string | undefined {
  const cleaned = args.filter((a) => a !== "-y" && a !== "--yes" && a !== "--");
  if (command === "npx") {
    const pkg = cleaned.find((a) => !a.startsWith("-"));
    return pkg;
  }
  if (command === "npm") {
    // npm exec [-y] pkg
    const execIdx = cleaned.indexOf("exec");
    if (execIdx === -1) return undefined;
    const rest = cleaned.slice(execIdx + 1).filter((a) => !a.startsWith("-"));
    return rest[0];
  }
  return undefined;
}

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function checkConfig(file: ConfigFile): {
  findings: Finding[];
  perServer: Map<string, { status: Severity; findings: Finding[] }>;
} {
  const findings: Finding[] = [];
  const perServer = new Map<
    string,
    { status: Severity; findings: Finding[] }
  >();

  if (file.format === "unknown") {
    findings.push({
      severity: "fail",
      code: "UNKNOWN_FORMAT",
      message:
        "Config is not a JSON object with mcpServers/servers (or was invalid shape)",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.format === "none") {
    findings.push({
      severity: "warn",
      code: "NO_MCP_SECTION",
      message: "JSON has no mcpServers or servers key",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.servers.length === 0) {
    findings.push({
      severity: "warn",
      code: "EMPTY_SERVERS",
      message: "Config contains an empty server map",
      file: file.path,
    });
  }

  for (const server of file.servers) {
    const local: Finding[] = [];
    let status: Severity = "ok";

    if (!server.name.trim()) {
      local.push({
        severity: "fail",
        code: "EMPTY_NAME",
        message: "Server name is empty",
        server: server.name,
        file: file.path,
      });
    }

    if (server.transport.kind === "unknown") {
      local.push({
        severity: "fail",
        code: "NO_TRANSPORT",
        message: "Server has neither command nor url",
        server: server.name,
        file: file.path,
      });
    }

    if (server.transport.kind === "http") {
      try {
        const u = new URL(server.transport.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          local.push({
            severity: "fail",
            code: "BAD_URL_PROTOCOL",
            message: `URL must be http(s), got ${u.protocol}`,
            server: server.name,
            file: file.path,
          });
        }
      } catch {
        local.push({
          severity: "fail",
          code: "BAD_URL",
          message: `Invalid URL: ${server.transport.url}`,
          server: server.name,
          file: file.path,
        });
      }
    }

    if (server.transport.kind === "stdio") {
      const { command, args } = server.transport;

      if (!commandOnPath(command)) {
        local.push({
          severity: "fail",
          code: "COMMAND_NOT_FOUND",
          message: `Command not found on PATH: ${command}`,
          server: server.name,
          file: file.path,
        });
      }

      if (command === "npx" || command === "npm") {
        const pkg = extractNpxPackage(command, args);
        if (!pkg) {
          local.push({
            severity: "warn",
            code: "NPX_NO_PACKAGE",
            message: "npx/npm exec invoked without a clear package argument",
            server: server.name,
            file: file.path,
          });
        } else if (!isVersionPinned(pkg)) {
          local.push({
            severity: "warn",
            code: "UNPINNED_PACKAGE",
            message: `Package "${pkg}" is not version-pinned (recommend name@version)`,
            server: server.name,
            file: file.path,
          });
        }
      }

      if (args.some((a) => a.includes("YOUR_") || a.includes("REPLACE_"))) {
        local.push({
          severity: "warn",
          code: "PLACEHOLDER_ARG",
          message: "Args look like unresolved placeholders",
          server: server.name,
          file: file.path,
        });
      }
    }

    const env = server.raw.env;
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(
        env as Record<string, string>,
      )) {
        if (
          typeof value === "string" &&
          (value.includes("YOUR_") ||
            value === "" ||
            value.toLowerCase() === "changeme")
        ) {
          local.push({
            severity: "warn",
            code: "PLACEHOLDER_ENV",
            message: `Env ${key} looks unset or placeholder`,
            server: server.name,
            file: file.path,
          });
        }
      }
    }

    for (const f of local) {
      status = worst(status, f.severity);
    }

    if (local.length === 0) {
      local.push({
        severity: "ok",
        code: "HEALTHY",
        message: "No issues detected",
        server: server.name,
        file: file.path,
      });
    }

    findings.push(...local);
    perServer.set(server.name, { status, findings: local });
  }

  return { findings, perServer };
}
