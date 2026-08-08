import { resolve } from "node:path";
import { discoverConfigPaths } from "./discover.js";
import { parseConfigFile } from "./parse.js";
import { checkConfig } from "./check.js";
import type { HealthReport, ServerReport, Severity } from "./types.js";

export type RunOptions = {
  root: string;
  files?: string[];
  includeUserConfig?: boolean;
};

export function runCheck(options: RunOptions): HealthReport {
  const root = resolve(options.root);
  const paths =
    options.files && options.files.length > 0
      ? options.files.map((f) => resolve(root, f))
      : discoverConfigPaths(root, {
          includeUserConfig: options.includeUserConfig,
        });

  const servers: ServerReport[] = [];
  const files: string[] = [];

  for (const path of paths) {
    files.push(path);
    let parsed;
    try {
      parsed = parseConfigFile(path);
    } catch (err) {
      servers.push({
        name: "(file)",
        file: path,
        transport: "unknown",
        status: "fail",
        findings: [
          {
            severity: "fail",
            code: "PARSE_ERROR",
            message: err instanceof Error ? err.message : String(err),
            file: path,
          },
        ],
      });
      continue;
    }

    const { perServer, findings } = checkConfig(parsed);

    if (parsed.format === "unknown" || parsed.servers.length === 0) {
      const status: Severity = findings.some((f) => f.severity === "fail")
        ? "fail"
        : findings.some((f) => f.severity === "warn")
          ? "warn"
          : "ok";
      servers.push({
        name: "(config)",
        file: path,
        transport: "unknown",
        status,
        findings,
      });
      continue;
    }

    for (const server of parsed.servers) {
      const result = perServer.get(server.name) ?? {
        status: "ok" as const,
        findings: [],
      };
      servers.push({
        name: server.name,
        file: path,
        transport: server.transport.kind,
        status: result.status,
        findings: result.findings,
      });
    }
  }

  if (files.length === 0) {
    servers.push({
      name: "(scan)",
      file: root,
      transport: "unknown",
      status: "warn",
      findings: [
        {
          severity: "warn",
          code: "NO_CONFIG",
          message:
            "No MCP config files found (.cursor/mcp.json, mcp.json, .mcp.json, .vscode/mcp.json)",
          file: root,
        },
      ],
    });
  }

  const summary = {
    ok: 0,
    warn: 0,
    fail: 0,
    files: files.length,
    servers: servers.filter((s) => !s.name.startsWith("(")).length,
  };

  for (const s of servers) {
    if (s.status === "ok") summary.ok += 1;
    else if (s.status === "warn") summary.warn += 1;
    else summary.fail += 1;
  }

  return {
    scannedAt: new Date().toISOString(),
    root,
    files,
    servers,
    summary,
  };
}
