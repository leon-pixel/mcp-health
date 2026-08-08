import { resolve } from "node:path";
import { discoverConfigPaths } from "./discover.js";
import { isOptionalMcpFile, parseConfigFile } from "./parse.js";
import { checkConfig, extractNpxPackage } from "./check.js";
import {
  fetchNpmLatest,
  isVersionDrift,
  splitPackageSpec,
} from "./npm.js";
import type {
  Finding,
  HealthReport,
  ServerReport,
  Severity,
} from "./types.js";

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export type RunOptions = {
  root: string;
  files?: string[];
  includeUserConfig?: boolean;
  /** Query npm registry for pinned package drift. */
  online?: boolean;
};

export async function runCheck(options: RunOptions): Promise<HealthReport> {
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

    if (parsed.format === "none" || parsed.format === "unknown") {
      let status: Severity = findings.some((f) => f.severity === "fail")
        ? "fail"
        : findings.some((f) => f.severity === "warn")
          ? "warn"
          : "ok";

      // Optional client settings without MCP section → soft skip
      if (
        parsed.format === "none" &&
        isOptionalMcpFile(path) &&
        findings.every((f) => f.code === "NO_MCP_SECTION")
      ) {
        status = "ok";
        servers.push({
          name: "(skipped)",
          file: path,
          transport: "unknown",
          status: "ok",
          findings: [
            {
              severity: "ok",
              code: "SKIPPED_NO_MCP",
              message: "No mcpServers section (ok for client settings files)",
              file: path,
            },
          ],
        });
        continue;
      }

      servers.push({
        name: "(config)",
        file: path,
        transport: "unknown",
        status,
        findings,
      });
      continue;
    }

    if (parsed.servers.length === 0) {
      const status: Severity = findings.some((f) => f.severity === "fail")
        ? "fail"
        : "warn";
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
        findings: [] as Finding[],
      };

      if (options.online && server.transport.kind === "stdio") {
        const pkg = extractNpxPackage(
          server.transport.command,
          server.transport.args,
        );
        if (pkg) {
          const { name, version } = splitPackageSpec(pkg);
          const latest = await fetchNpmLatest(name);
          if (!latest.ok) {
            result.findings.push({
              severity: "warn",
              code: "NPM_LOOKUP_FAILED",
              message: latest.error,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else if (!version) {
            result.findings.push({
              severity: "warn",
              code: "NPM_LATEST",
              message: `Unpinned; npm latest is ${latest.latest} (pin ${name}@${latest.latest})`,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else if (isVersionDrift(version, latest.latest)) {
            result.findings.push({
              severity: "warn",
              code: "NPM_DRIFT",
              message: `Pinned ${version} but npm latest is ${latest.latest}`,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else {
            result.findings.push({
              severity: "ok",
              code: "NPM_CURRENT",
              message: `Pinned ${version} matches npm latest`,
              server: server.name,
              file: path,
            });
          }
        }
      }

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
            "No MCP config files found (Cursor/Claude/VS Code project or user paths)",
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
