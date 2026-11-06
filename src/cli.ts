#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { formatStarter, resolveStarterClient, starterConfig, writeStarter } from "./init.js";
import { runCheck } from "./run.js";
import { exitCode, formatHuman, formatJson } from "./report.js";
import { buildSarif, formatAnnotations } from "./sarif.js";
import { VERSION } from "./version.js";

const program = new Command();

/** Positive milliseconds. Rejects NaN, zero, and negatives before a probe can start. */
function parseProbeTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(
      "--probe-timeout value must be a positive number of milliseconds",
    );
  }
  return parsed;
}

program
  .name("mcp-health")
  .description(
    "Scan MCP server configs and report health, missing commands, and unpinned packages",
  )
  .version(VERSION);

program
  .command("check")
  .description("Scan a project (or paths) for MCP config issues")
  .argument("[root]", "Project root to scan", ".")
  .option("-f, --file <path>", "Specific config file (repeatable)", collect, [])
  .option("--json", "Print JSON report", false)
  .option(
    "--no-user",
    "Skip user-level configs (Cursor, VS Code, Claude Code, Claude Desktop, Continue, Junie, Cline, Roo Code, Gemini CLI, Antigravity, Kiro, OpenCode, Amazon Q, Amp, Goose, Copilot, Windsurf, Devin, Zed, and Codex)",
  )
  .option(
    "--online",
    "Query npm for package drift, and PyPI for uvx (network required)",
    false,
  )
  .option(
    "--probe",
    "Attempt MCP initialize handshake (spawns local servers briefly)",
    false,
  )
  .option(
    "--probe-timeout <ms>",
    "Probe timeout in milliseconds",
    parseProbeTimeout,
    8000,
  )
  .option("--no-tools", "With --probe, skip tools/list")
  .option(
    "--sarif <file>",
    "Write warn and fail findings as SARIF 2.1.0",
  )
  .option(
    "--github-annotations",
    "Print GitHub Actions annotations on stderr",
    false,
  )
  .option(
    "--strict-variables",
    "Fail on ${input:…} and unset ${env:…} instead of warning",
    false,
  )
  .option(
    "--allow-missing",
    "Exit 0 when no MCP config file is found",
    false,
  )
  .option(
    "--recursive",
    "Scan project MCP configs in subdirectories. Skips node_modules, .git, dist, build, vendor, .venv, venv, and target, and does not follow a symlink outside the scan root",
    false,
  )
  .action(
    async (
      root: string,
      opts: {
        file: string[];
        json?: boolean;
        user?: boolean;
        online?: boolean;
        probe?: boolean;
        probeTimeout?: number;
        tools?: boolean;
        sarif?: string;
        githubAnnotations?: boolean;
        strictVariables?: boolean;
        allowMissing?: boolean;
        recursive?: boolean;
      },
    ) => {
      const report = await runCheck({
        root,
        files: opts.file.length
          ? opts.file.map((file) => resolve(process.cwd(), file))
          : undefined,
        includeUserConfig: opts.user !== false,
        online: Boolean(opts.online),
        probe: Boolean(opts.probe),
        probeTimeoutMs: opts.probeTimeout,
        probeListTools: opts.tools !== false,
        strictVariables: Boolean(opts.strictVariables),
        allowMissing: Boolean(opts.allowMissing),
        recursive: Boolean(opts.recursive),
      });

      if (opts.sarif) {
        writeFileSync(
          resolve(opts.sarif),
          `${JSON.stringify(buildSarif(report), null, 2)}\n`,
        );
      }
      if (opts.githubAnnotations) {
        process.stderr.write(formatAnnotations(report));
      }

      process.stdout.write(opts.json ? formatJson(report) : formatHuman(report));
      process.exitCode = exitCode(report);
    },
  );

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .command("init")
  .description(
    "Print a starter project MCP config and the path it belongs in. Does not create or modify a file unless --write is set",
  )
  .argument(
    "[client]",
    "Client to print: cursor (default, .cursor/mcp.json), vscode (.vscode/mcp.json, servers), or antigravity (.agents/mcp_config.json, serverUrl)",
  )
  .option(
    "--client <name>",
    "Same as the client argument: cursor, vscode, or antigravity",
  )
  .option(
    "--write",
    "Create the file only when that path does not exist, then print the path. An existing file is left unchanged and the command exits 1",
    false,
  )
  .action((client: string | undefined, opts: { client?: string; write?: boolean }) => {
    const resolved = resolveStarterClient(client, opts.client);
    if (!resolved.ok) {
      process.stderr.write(`mcp-health: ${resolved.message}\n`);
      process.exitCode = 1;
      return;
    }
    const starter = starterConfig(resolved.client);
    if (!opts.write) {
      process.stdout.write(formatStarter(starter));
      return;
    }
    const written = writeStarter(process.cwd(), starter);
    if (!written.ok) {
      process.stderr.write(`mcp-health: ${written.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${starter.path}\n`);
  });

await program.parseAsync(process.argv);
