import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  configFileScope,
  discoverConfigPaths,
  type LocateOptions,
} from "./discover.js";
import { configHasServers, isOptionalMcpFile, parseConfigFile } from "./parse.js";
import {
  checkConfig,
  extractNpxPackage,
  isExtensionProvided,
  isServerDisabled,
  packageRegistry,
  serverHasUnresolved,
  stdioWorkingDirectory,
} from "./check.js";
import {
  fetchNpmLatest,
  fetchPypiLatest,
  isFloatingPin,
  isRangePin,
  isVersionDrift,
  splitPackageSpec,
} from "./npm.js";
import { probeServer, worst } from "./probe.js";
import { applyIgnoreFile } from "./ignore.js";
import { configWarningFindings } from "./report.js";
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
  /** Query npm, or PyPI for uvx, for pinned package drift. */
  online?: boolean;
  /** Attempt MCP initialize handshake. */
  probe?: boolean;
  probeTimeoutMs?: number;
  /** With probe, call tools/list, resources/list, and prompts/list. Defaults to true. */
  probeListTools?: boolean;
  /** Treat ${input:…} and unset ${env:…} as failures. */
  strictVariables?: boolean;
  /** A scan that finds no config is ok instead of a warning. */
  allowMissing?: boolean;
  /** Also scan project MCP configs in subdirectories of the root. */
  recursive?: boolean;
} & LocateOptions;

function emptyReport(
  root: string,
  row: ServerReport,
): HealthReport {
  return {
    scannedAt: new Date().toISOString(),
    root,
    files: [],
    servers: [row],
    summary: {
      ok: 0,
      warn: 0,
      fail: 0,
      files: 0,
      servers: 0,
      skipped: 0,
      configWarnings: 0,
    },
  };
}

export async function runCheck(options: RunOptions): Promise<HealthReport> {
  const root = resolve(options.root);
  if (!existsSync(root)) {
    return emptyReport(root, {
      name: "(scan)",
      file: root,
      transport: "unknown",
      status: "fail",
      findings: [
        {
          severity: "fail",
          code: "ROOT_NOT_FOUND",
          message: `Scan root does not exist: ${root}`,
          file: root,
        },
      ],
    });
  }
  const paths =
    options.files && options.files.length > 0
      ? options.files.map((f) => resolve(root, f))
      : discoverConfigPaths(root, {
          includeUserConfig: options.includeUserConfig,
          recursive: options.recursive,
          platform: options.platform,
          home: options.home,
          env: options.env,
        });

  const servers: ServerReport[] = [];
  const files: string[] = [];
  const probeTimeoutMs = options.probeTimeoutMs ?? 8_000;

  for (const path of paths) {
    files.push(path);
    const scope = configFileScope(path, {
      platform: options.platform,
      home: options.home,
      env: options.env,
    });
    if (!existsSync(path)) {
      servers.push({
        name: "(file)",
        file: path,
        scope,
        transport: "unknown",
        status: "fail",
        findings: [
          {
            severity: "fail",
            code: "FILE_NOT_FOUND",
            message: `Config file not found: ${path}`,
            file: path,
          },
        ],
      });
      continue;
    }
    let parsed;
    try {
      parsed = parseConfigFile(path, {
        root,
        platform: options.platform,
        env: options.env,
      });
    } catch (err) {
      servers.push({
        name: "(file)",
        file: path,
        scope,
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

    const { perServer, findings } = checkConfig(parsed, {
      strictVariables: options.strictVariables,
      cwd: root,
      platform: options.platform,
      home: options.home,
      env: options.env,
    });

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
        isOptionalMcpFile(path, {
          platform: options.platform,
          env: options.env,
        }) &&
        findings.every((f) => f.code === "NO_MCP_SECTION")
      ) {
        status = "ok";
        servers.push({
          name: "(skipped)",
          file: path,
          scope,
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
        scope,
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
        scope,
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
          const registry = packageRegistry(server.transport.command);
          const latest =
            registry === "pypi" ? await fetchPypiLatest(name) : await fetchNpmLatest(name);
          const source = registry === "pypi" ? "PyPI" : "npm";
          if (!latest.ok) {
            result.findings.push({
              severity: "warn",
              code: "NPM_LOOKUP_FAILED",
              message: latest.error,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else if (!version || isFloatingPin(version)) {
            result.findings.push({
              severity: "warn",
              code: "NPM_LATEST",
              message: `Unpinned; ${source} latest is ${latest.latest} (pin ${name}@${latest.latest})`,
              server: server.name,
              file: path,
            });
            result.status = worst(result.status, "warn");
          } else if (isVersionDrift(version, latest.latest)) {
            const message = isRangePin(version)
              ? `Pinned range ${version} does not include ${source} latest ${latest.latest}`
              : `Pinned ${version} but ${source} latest is ${latest.latest}`;
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
              ? `Pinned range ${version} includes ${source} latest ${latest.latest}`
              : `Pinned ${version} matches ${source} latest`;
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

      const leaveUnprobed =
        isServerDisabled(server) || isExtensionProvided(server);
      if (options.probe && result.status !== "fail" && !leaveUnprobed) {
        if (serverHasUnresolved(server)) {
          result.findings.push({
            severity: "warn",
            code: "PROBE_SKIPPED",
            message: "Skipped probe because a config variable is unresolved",
            server: server.name,
            file: path,
          });
          result.status = worst(result.status, "warn");
        } else {
          const probed = await probeServer(server, {
            timeoutMs: probeTimeoutMs,
            file: path,
            cwd: stdioWorkingDirectory(
              server,
              { path, format: parsed.format },
              {
                cwd: root,
                platform: options.platform,
                home: options.home,
                env: options.env,
              },
            ),
            listTools: options.probeListTools !== false,
            platform: options.platform,
            home: options.home,
            env: options.env,
          });
          result.findings.push(...probed.findings);
          result.status = worst(result.status, probed.status);
        }
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
        scope,
        transport: server.transport.kind,
        status,
        findings: findingsForReport,
      });
    }
  }

  if (files.length === 0) {
    const severity: Severity = options.allowMissing ? "ok" : "warn";
    servers.push({
      name: "(scan)",
      file: root,
      transport: "unknown",
      status: severity,
      findings: [
        {
          severity,
          code: "NO_CONFIG",
          message:
            "No MCP config files found (Cursor, VS Code, Claude, Continue, Junie, Cline, Roo Code, Gemini CLI, Antigravity, Kiro, OpenCode, Amazon Q, Amp, Goose, Copilot, Windsurf, Zed, or Codex project or user paths). Add a project file such as .cursor/mcp.json or .vscode/mcp.json, run mcp-health init to print a starter config, or pass --allow-missing to exit 0 when this repository is supposed to have no MCP config.",
          file: root,
        },
      ],
    });
  }

  const reported = applyIgnoreFile(root, servers);

  const real = reported.filter((server) => !server.name.startsWith("("));
  const summary = {
    ok: 0,
    warn: 0,
    fail: 0,
    files: files.length,
    servers: real.length,
    skipped: reported.filter((server) =>
      server.findings.some((finding) => finding.code === "SKIPPED_NO_MCP"),
    ).length,
    configWarnings: configWarningFindings(reported).length,
  };

  for (const server of real) {
    if (server.status === "ok") summary.ok += 1;
    else if (server.status === "warn") summary.warn += 1;
    else summary.fail += 1;
  }

  return {
    scannedAt: new Date().toISOString(),
    root,
    files,
    servers: reported,
    summary,
  };
}
