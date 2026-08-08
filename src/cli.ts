#!/usr/bin/env node
import { Command } from "commander";
import { runCheck } from "./run.js";
import { exitCode, formatHuman, formatJson } from "./report.js";

const program = new Command();

program
  .name("mcp-health")
  .description(
    "Scan MCP server configs and report health, missing commands, and unpinned packages",
  )
  .version("0.1.0");

program
  .command("check")
  .description("Scan a project (or paths) for MCP config issues")
  .argument("[root]", "Project root to scan", ".")
  .option("-f, --file <path>", "Specific config file (repeatable)", collect, [])
  .option("--json", "Print JSON report", false)
  .option("--no-user", "Ignore ~/.cursor/mcp.json outside the project")
  .action(
    (
      root: string,
      opts: { file: string[]; json?: boolean; user?: boolean },
    ) => {
      const report = runCheck({
        root,
        files: opts.file.length ? opts.file : undefined,
        includeUserConfig: opts.user !== false,
      });

      process.stdout.write(opts.json ? formatJson(report) : formatHuman(report));
      process.exitCode = exitCode(report);
    },
  );

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program.parse();
