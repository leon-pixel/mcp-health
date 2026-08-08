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
  .version("0.2.0");

program
  .command("check")
  .description("Scan a project (or paths) for MCP config issues")
  .argument("[root]", "Project root to scan", ".")
  .option("-f, --file <path>", "Specific config file (repeatable)", collect, [])
  .option("--json", "Print JSON report", false)
  .option("--no-user", "Ignore user-level Cursor/Claude Desktop configs")
  .option(
    "--online",
    "Query npm registry for package drift (network required)",
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
      },
    ) => {
      const report = await runCheck({
        root,
        files: opts.file.length ? opts.file : undefined,
        includeUserConfig: opts.user !== false,
        online: Boolean(opts.online),
      });

      process.stdout.write(opts.json ? formatJson(report) : formatHuman(report));
      process.exitCode = exitCode(report);
    },
  );

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

await program.parseAsync(process.argv);
