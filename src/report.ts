import type { HealthReport } from "./types.js";

const icons = { ok: "OK", warn: "WARN", fail: "FAIL" } as const;

export function formatHuman(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`mcp-health — scanned ${report.root}`);
  lines.push(
    `files: ${report.summary.files}  servers: ${report.summary.servers}  ok: ${report.summary.ok}  warn: ${report.summary.warn}  fail: ${report.summary.fail}`,
  );
  lines.push("");

  if (report.files.length) {
    lines.push("Configs:");
    for (const f of report.files) lines.push(`  - ${f}`);
    lines.push("");
  }

  for (const server of report.servers) {
    lines.push(
      `[${icons[server.status]}] ${server.name}  (${server.transport})  ${server.file}`,
    );
    for (const finding of server.findings) {
      lines.push(
        `    - ${icons[finding.severity]} ${finding.code}: ${finding.message}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function formatJson(report: HealthReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function exitCode(report: HealthReport): number {
  if (report.summary.fail > 0) return 2;
  if (report.summary.warn > 0) return 1;
  return 0;
}
