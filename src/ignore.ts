import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { worst } from "./probe.js";
import type { Finding, ServerReport, Severity } from "./types.js";

/** Scan-root file that lists accepted findings. It is not an MCP config. */
export const IGNORE_FILENAME = ".mcp-health.json";

/**
 * Codes this scan can emit. An ignore entry that names anything else is a
 * config-level warning and does not suppress a finding.
 * The ignore-file warnings themselves are not in this set, so the file cannot
 * hide a typo or a stale entry.
 */
const KNOWN_FINDING_CODES = new Set<string>([
  "AUTH_ENV_UNSET",
  "BAD_URL",
  "BAD_URL_PROTOCOL",
  "COMMAND_NOT_FOUND",
  "DISABLED",
  "EMPTY_NAME",
  "EMPTY_SERVERS",
  "EMPTY_TOOLS",
  "ENV_FILE_MISSING",
  "EXTENSION_SERVER",
  "FILE_NOT_FOUND",
  "HEALTHY",
  "MCP_SERVERS_IGNORED",
  "MISSING_TRANSPORT_TYPE",
  "NO_CONFIG",
  "NO_MCP_SECTION",
  "NO_TRANSPORT",
  "NPM_CURRENT",
  "NPM_DRIFT",
  "NPM_LATEST",
  "NPM_LOOKUP_FAILED",
  "NPX_NO_PACKAGE",
  "PARSE_ERROR",
  "PLACEHOLDER_ARG",
  "PLACEHOLDER_ENV",
  "PLACEHOLDER_HEADER",
  "PROMPTS_LIST_FAILED",
  "PROMPTS_OK",
  "PROBE_FAILED",
  "PROBE_HTTP_AUTH",
  "PROBE_HTTP_ERROR",
  "PROBE_HTTP_REACHABLE",
  "PROBE_INIT_ERROR",
  "PROBE_NO_RESULT",
  "PROBE_OAUTH",
  "PROBE_OK",
  "PROBE_SKIPPED",
  "RESOURCES_LIST_FAILED",
  "RESOURCES_OK",
  "ROOT_NOT_FOUND",
  "SCHEMA_ERROR",
  "SCRIPT_NOT_FOUND",
  "SDK_SERVER",
  "SKIPPED_NO_MCP",
  "TOOLS_LIST_FAILED",
  "TOOLS_OK",
  "UNKNOWN_FORMAT",
  "UNPINNED_PACKAGE",
  "UNRESOLVED_VARIABLE",
]);

type IgnoreEntry = {
  code: string;
  /** Omitted (or `"*"`) matches every server name. */
  server?: string;
  /** Omitted (or `"*"`) matches every config file. */
  file?: string;
};

type Classified =
  | { kind: "bad" }
  | { kind: "unknown"; entry: IgnoreEntry }
  | { kind: "entry"; entry: IgnoreEntry };

type LoadedIgnore = {
  path: string;
  problems: Finding[];
  items: Classified[];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function ignoreFile(root: string): string {
  return join(resolve(root), IGNORE_FILENAME);
}

function warning(file: string, code: string, message: string, server?: string): Finding {
  return {
    severity: "warn",
    code,
    message,
    ...(server ? { server } : {}),
    file,
  };
}

/**
 * A missing field and `"*"` both match every server or every file.
 * Any other present value must be a non-empty string, and it stays exact.
 */
function matchField(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!isNonEmptyString(value)) return { ok: false };
  if (value === "*") return { ok: true };
  return { ok: true, value };
}

function classifyEntry(value: unknown): Classified {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "bad" };
  const record = value as Record<string, unknown>;
  const server = matchField(record.server);
  const file = matchField(record.file);
  if (!isNonEmptyString(record.code) || !server.ok || !file.ok) return { kind: "bad" };
  const entry: IgnoreEntry = { code: record.code };
  if (server.value !== undefined) entry.server = server.value;
  if (file.value !== undefined) entry.file = file.value;
  if (!KNOWN_FINDING_CODES.has(entry.code)) return { kind: "unknown", entry };
  return { kind: "entry", entry };
}

function scopeLabel(value: string | undefined): string {
  return value ?? "*";
}

/** Missing file means the scan is unchanged. A broken file is a config warning. */
function loadIgnore(root: string): LoadedIgnore | undefined {
  const path = ignoreFile(root);
  if (!existsSync(path)) return undefined;

  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      path,
      items: [],
      problems: [warning(path, "IGNORE_CONFIG", `Could not read .mcp-health.json: ${detail}`)],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      path,
      items: [],
      problems: [warning(path, "IGNORE_CONFIG", `Could not parse .mcp-health.json: ${detail}`)],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      path,
      items: [],
      problems: [
        warning(
          path,
          "IGNORE_CONFIG",
          ".mcp-health.json must be a JSON object with an ignore array",
        ),
      ],
    };
  }

  const ignore = (parsed as Record<string, unknown>).ignore;
  if (!Array.isArray(ignore)) {
    return {
      path,
      items: [],
      problems: [warning(path, "IGNORE_CONFIG", ".mcp-health.json ignore must be an array")],
    };
  }

  return { path, items: ignore.map((entry) => classifyEntry(entry)), problems: [] };
}

/**
 * A present `file` is relative to the scan root.
 * `mcp.json` and `services/api/mcp.json` are different files.
 * The finding message is not compared.
 */
function sameConfigFile(root: string, findingFile: string, entryFile: string): boolean {
  const expected = resolve(root, entryFile.replace(/\\/g, "/"));
  const actual = resolve(findingFile);
  return process.platform === "win32"
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}

function matches(root: string, finding: Finding, entry: IgnoreEntry): boolean {
  if (finding.code !== entry.code) return false;
  if (entry.server !== undefined && finding.server !== entry.server) return false;
  if (entry.file === undefined) return true;
  if (!finding.file) return false;
  return sameConfigFile(root, finding.file, entry.file);
}

function healthyFinding(server: ServerReport): Finding {
  return {
    severity: "ok",
    code: "HEALTHY",
    message: "No issues detected",
    server: server.name,
    file: server.file,
  };
}

/**
 * Omit findings that match an ignore entry.
 * `code` is required. An omitted `server` or `file` (or `"*"`) matches every
 * server or config file. A missing `.mcp-health.json` returns the same server list.
 * Unknown codes and entries that match nothing are config-level warnings.
 * A server with nothing left is ok.
 */
export function applyIgnoreFile(root: string, servers: ServerReport[]): ServerReport[] {
  const loaded = loadIgnore(root);
  if (!loaded) return servers;

  const warnings = [...loaded.problems];
  const usable: IgnoreEntry[] = [];
  if (loaded.problems.length === 0) {
    for (const item of loaded.items) {
      if (item.kind === "bad") {
        warnings.push(
          warning(
            loaded.path,
            "IGNORE_CONFIG",
            'Ignore entry must set a non-empty code. server and file, when present, must be "*" or a non-empty string',
          ),
        );
        continue;
      }
      if (item.kind === "unknown") {
        const { entry } = item;
        warnings.push(
          warning(
            loaded.path,
            "UNKNOWN_IGNORE",
            `Ignore entry names an unknown code "${entry.code}" (server "${scopeLabel(entry.server)}", file "${scopeLabel(entry.file)}")`,
            entry.server,
          ),
        );
        continue;
      }
      usable.push(item.entry);
    }
  }

  const used = new Set<number>();
  const updated = servers.map((server) => {
    if (usable.length === 0) return server;
    const kept = server.findings.filter((finding) => {
      let suppress = false;
      for (let index = 0; index < usable.length; index += 1) {
        const entry = usable[index];
        if (!entry || !matches(root, finding, entry)) continue;
        used.add(index);
        suppress = true;
      }
      return !suppress;
    });
    if (kept.length === server.findings.length) return server;
    const findings =
      !server.name.startsWith("(") && kept.length === 0 ? [healthyFinding(server)] : kept;
    const status = findings.reduce<Severity>(
      (current, finding) => worst(current, finding.severity),
      "ok",
    );
    return { ...server, findings, status };
  });

  for (let index = 0; index < usable.length; index += 1) {
    if (used.has(index)) continue;
    const entry = usable[index];
    if (!entry) continue;
    warnings.push(
      warning(
        loaded.path,
        "STALE_IGNORE",
        `Ignore entry matched no finding (code "${entry.code}", server "${scopeLabel(entry.server)}", file "${scopeLabel(entry.file)}")`,
        entry.server,
      ),
    );
  }

  if (warnings.length === 0) return updated;
  return [
    ...updated,
    {
      name: "(config)",
      file: loaded.path,
      scope: "project",
      transport: "unknown",
      status: "warn",
      findings: warnings,
    },
  ];
}
