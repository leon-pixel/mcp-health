import { resolve } from "node:path";
import { discoverConfigPaths } from "./discover.js";
import { configHasServers, isOptionalMcpFile, parseConfigFile } from "./parse.js";
import { checkConfig, extractNpxPackage } from "./check.js";
import {
  fetchNpmLatest,
  isRangePin,
  isVersionDrift,
  splitPackageSpec,
} from "./npm.js";
import { probeServer, worst } from "./probe.js";
import { expandServerVariables } from "./vars.js";
import type {
  Finding,
  HealthReport,
  ServerReport,
  Severity,
} from "./types.js";

/** Drop the static HEALTHY line once a real warning or failure exists. */
export function omitStaleHealthy(findings: Finding[]): Finding[] {
  if (findings.some((finding) => finding.severity === "warn" || finding.severity === "fail")) {
    return findings.filter((finding) => finding.code !== "HEALTHY");
  }
  return findings;
}

export type RunOptions = {
  root: string;
  files?: string[];
  includeUserConfig?: boolean;
  /** Query npm registry for pinned package drift. */
  online?: boolean;
  /** Attempt MCP initialize handshake. */
  probe?: boolean;
  probeTimeoutMs?: number;
  /** With probe, call tools/list. Defaults to true. */
  probeListTools?: boolean;
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
  const probeTimeoutMs = options.probeTimeoutMs ?? 8_000;

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

    if (configHasServers(parsed.format)) {
      parsed = {
        ...parsed,
        servers: parsed.servers.map((server) =>
          expandServerVariables(server, { root }),
        ),
      };
    }

    const { perServer, findings } = checkConfig(parsed);

    if (
      parsed.format === "none" ||
      parsed.format === "unknown" ||
      parsed.format === "invalid"
    ) {
      let status: Severity = findings.some((f) => f.severity === "fail")
        ? "fail"
        : findings.some((f) => f.severity === "warn")
          ? "warn"
          : "ok";

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
              message: "No MCP server section (ok for client settings files)",
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
            const message = isRangePin(version)
              ? `Pinned range ${version} does not include npm latest ${latest.latest}`
              : `Pinned ${version} but npm latest is ${latest.latest}`;
            result.findings.push({
              severity: "warn",
              code: "NPM_DRIFT",
              message,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else {
            const message = isRangePin(version)
              ? `Pinned range ${version} includes npm latest ${latest.latest}`
              : `Pinned ${version} matches npm latest`;
            result.findings.push({
              severity: "ok",
              code: "NPM_CURRENT",
              message,
              server: server.name,
              file: path,
            });
          }
        }
      }

      if (options.probe && result.status !== "fail") {
        const probed = await probeServer(server, {
          timeoutMs: probeTimeoutMs,
          file: path,
          cwd: root,
          listTools: options.probeListTools !== false,
        });
        result.findings.push(...probed.findings);
        result.status = worst(result.status, probed.status);
      } else if (options.probe && result.status === "fail") {
        result.findings.push({
          severity: "warn",
          code: "PROBE_SKIPPED",
          message: "Skipped probe because static checks failed",
          server: server.name,
          file: path,
        });
      }

      const findingsForReport = omitStaleHealthy(result.findings);
      const status = findingsForReport.reduce<Severity>(
        (current, item) => worst(current, item.severity),
        "ok",
      );
      servers.push({
        name: server.name,
        file: path,
        transport: server.transport.kind,
        status,
        findings: findingsForReport,
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
            "No MCP config files found (Cursor, VS Code, Claude, Windsurf, Zed, or Codex project or user paths)",
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
