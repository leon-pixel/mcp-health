import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseJsonc } from "./jsonc.js";
import type { ConfigFile, ParsedServer, ServerTransport } from "./types.js";

const CommandObjectSchema = z.object({
  path: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const ServerEntrySchema = z
  .object({
    command: z.union([z.string(), CommandObjectSchema]).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    /** Gemini CLI streamable HTTP endpoint. Wins over `url` and `command`. */
    httpUrl: z.string().optional(),
    serverUrl: z.string().optional(),
    type: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
    source: z.string().optional(),
    settings: z.unknown().optional(),
    bearerTokenEnvVar: z.string().optional(),
    envHttpHeaders: z.record(z.string(), z.string()).optional(),
    /**
     * Stdio working directory for the clients that read it (VS Code,
     * Copilot user config, Gemini CLI, Codex). Other clients may still
     * carry the field; the checker decides whether to use it.
     */
    cwd: z.string().optional(),
  })
  .passthrough();

const McpServersDocSchema = z.object({
  mcpServers: z.record(z.string(), ServerEntrySchema),
});

const ServersDocSchema = z.object({
  servers: z.record(z.string(), ServerEntrySchema),
});

const ContextServersDocSchema = z.object({
  context_servers: z.record(z.string(), ServerEntrySchema),
});

const ContinueEntrySchema = ServerEntrySchema.extend({
  name: z.string(),
});

type ServerEntry = z.infer<typeof ServerEntrySchema>;

export type ParseOptions = {
  /** Scan root. Claude Code uses it to select `projects[<path>]`. */
  root?: string;
  platform?: NodeJS.Platform;
  /** Used to recognize a custom `OPENCODE_CONFIG` file. */
  env?: NodeJS.ProcessEnv;
};

function httpUrl(entry: ServerEntry): string | undefined {
  // Gemini CLI: httpUrl, then url, then command. serverUrl is Windsurf's name for url.
  const url =
    entry.httpUrl?.trim() || entry.url?.trim() || entry.serverUrl?.trim();
  return url || undefined;
}

function stdioCommand(
  entry: ServerEntry,
): { command: string; args: string[] } | undefined {
  if (typeof entry.command === "string" && entry.command.trim()) {
    return { command: entry.command.trim(), args: entry.args ?? [] };
  }
  if (entry.command && typeof entry.command === "object") {
    const command = entry.command.path.trim();
    if (!command) return undefined;
    return { command, args: entry.command.args ?? entry.args ?? [] };
  }
  return undefined;
}

function toTransport(entry: ServerEntry): ServerTransport {
  const url = httpUrl(entry);
  if (url) return { kind: "http", url };
  const stdio = stdioCommand(entry);
  if (stdio) return { kind: "stdio", ...stdio };
  return { kind: "unknown" };
}

function rawServer(entry: ServerEntry): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...entry };
  if (entry.command && typeof entry.command === "object") {
    const env = { ...(entry.env ?? {}), ...(entry.command.env ?? {}) };
    if (Object.keys(env).length > 0) raw.env = env;
  }
  return raw;
}

function mapServers(record: Record<string, ServerEntry>): ParsedServer[] {
  return Object.entries(record).map(([name, entry]) => ({
    name,
    transport: toTransport(entry),
    raw: rawServer(entry),
  }));
}

export function configHasServers(format: ConfigFile["format"]): boolean {
  return (
    format === "mcpServers" ||
    format === "servers" ||
    format === "contextServers" ||
    format === "codex" ||
    format === "opencode" ||
    format === "goose"
  );
}

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4);
  if (issues.length === 0) return error.message;
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    out[key] = entry;
  }
  return out;
}

function parseCodexToml(path: string, text: string): ConfigFile {
  let doc: Record<string, unknown>;
  try {
    const parsed = parseToml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, format: "unknown", servers: [] };
    }
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Invalid TOML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!("mcp_servers" in doc)) {
    return { path, format: "none", servers: [] };
  }

  const table = doc.mcp_servers;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return {
      path,
      format: "invalid",
      servers: [],
      error: "mcp_servers must be a table of servers",
    };
  }

  const record: Record<string, ServerEntry> = {};
  for (const [name, value] of Object.entries(table)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name} must be a table`,
      };
    }
    const entry = value as Record<string, unknown>;
    const args = entry.args === undefined ? undefined : asStringArray(entry.args);
    if (entry.args !== undefined && !args) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.args must be an array of strings`,
      };
    }
    const env = entry.env === undefined ? undefined : asStringRecord(entry.env);
    if (entry.env !== undefined && !env) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.env values must be strings`,
      };
    }
    const headers =
      entry.http_headers === undefined
        ? undefined
        : asStringRecord(entry.http_headers);
    if (entry.http_headers !== undefined && !headers) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.http_headers values must be strings`,
      };
    }
    if (entry.command !== undefined && typeof entry.command !== "string") {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.command must be a string`,
      };
    }
    if (entry.url !== undefined && typeof entry.url !== "string") {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.url must be a string`,
      };
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.enabled must be a boolean`,
      };
    }
    if (
      entry.bearer_token_env_var !== undefined &&
      typeof entry.bearer_token_env_var !== "string"
    ) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.bearer_token_env_var must be a string`,
      };
    }
    const envHeaders =
      entry.env_http_headers === undefined
        ? undefined
        : asStringRecord(entry.env_http_headers);
    if (entry.env_http_headers !== undefined && !envHeaders) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.env_http_headers values must be strings`,
      };
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      return {
        path,
        format: "invalid",
        servers: [],
        error: `mcp_servers.${name}.cwd must be a string`,
      };
    }
    record[name] = {
      command: typeof entry.command === "string" ? entry.command : undefined,
      args,
      url: typeof entry.url === "string" ? entry.url : undefined,
      env,
      headers,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      bearerTokenEnvVar:
        typeof entry.bearer_token_env_var === "string"
          ? entry.bearer_token_env_var
          : undefined,
      envHttpHeaders: envHeaders,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    };
  }

  return { path, format: "codex", servers: mapServers(record) };
}

function parseMcpServersValue(path: string, mcpServers: unknown): ConfigFile {
  const asMcp = McpServersDocSchema.safeParse({ mcpServers });
  if (asMcp.success) {
    return {
      path,
      format: "mcpServers",
      servers: mapServers(asMcp.data.mcpServers),
    };
  }
  return {
    path,
    format: "invalid",
    servers: [],
    error: formatZodError(asMcp.error),
  };
}

function invalidConfig(path: string, error: string): ConfigFile {
  return { path, format: "invalid", servers: [], error };
}

/** Compare Claude `projects` keys to the scan root, including Windows paths. */
function normalizeProjectPath(
  input: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  let normalized = pathApi.resolve(input);
  if (platform === "win32") normalized = normalized.toLowerCase();
  const root = pathApi.parse(normalized).root;
  if (
    normalized.length > root.length &&
    (normalized.endsWith("/") || normalized.endsWith("\\"))
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.replace(/\\/g, "/");
}

/**
 * Directory identity for a `projects` key.
 * Trailing-slash and Windows case behavior stay on the string form.
 * A path that exists on this machine is compared by its real path, so a
 * symlink and macOS `/tmp` versus `/private/tmp` match the same directory.
 */
function canonicalProjectPath(
  input: string,
  platform: NodeJS.Platform,
): string {
  const normalized = normalizeProjectPath(input, platform);
  if (platform !== process.platform) return normalized;
  try {
    if (!existsSync(normalized)) return normalized;
    return normalizeProjectPath(realpathSync(normalized), platform);
  } catch {
    return normalized;
  }
}

function isClaudeUserConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".claude.json" || normalized.endsWith("/.claude.json");
}

/**
 * Marker on `ConfigFile.error` when a Claude settings file has `mcpServers`.
 * Claude Code does not load that key. The checker turns it into a finding.
 */
export const CLAUDE_SETTINGS_MCP_SERVERS = "MCP_SERVERS_IGNORED";

/**
 * `.claude/settings.json` and `.claude/settings.local.json`, including
 * `~/.claude/settings.json`. Not `.mcp.json` and not `~/.claude.json`.
 */
export function isClaudeSettingsFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(normalized);
}

/** Copilot's committed project file. Not the user `mcp-config.json`. */
function isCopilotProjectConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".github/mcp.json" || normalized.endsWith("/.github/mcp.json")
  );
}

function isContinueConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized === ".continue/config.yaml" ||
    normalized.endsWith("/.continue/config.yaml")
  ) {
    return true;
  }
  return /(?:^|\/)\.continue\/mcpServers\/[^/]+\.(yaml|yml|json)$/i.test(
    normalized,
  );
}

function readJson(path: string, text: string): unknown {
  try {
    return parseJsonc(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readYaml(path: string, text: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseContinueList(path: string, section: unknown[]): ConfigFile {
  const parsed = z.array(ContinueEntrySchema).safeParse(section);
  if (!parsed.success) {
    return invalidConfig(path, formatZodError(parsed.error));
  }
  const record: Record<string, ServerEntry> = {};
  for (const [index, entry] of parsed.data.entries()) {
    if (entry.name in record) {
      return invalidConfig(
        path,
        `mcpServers.${index}.name duplicates an earlier entry`,
      );
    }
    record[entry.name] = entry;
  }
  return { path, format: "mcpServers", servers: mapServers(record) };
}

/**
 * Continue stores `mcpServers` as a list. A JSON file dropped in
 * `.continue/mcpServers/` may instead be a Cursor-style object; that form
 * uses the existing parser. A document with no `mcpServers` key is skipped.
 */
function parseContinueDocument(path: string, doc: unknown): ConfigFile {
  if (doc === null || doc === undefined) {
    return { path, format: "none", servers: [] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = doc as Record<string, unknown>;
  if (!("mcpServers" in obj)) {
    return { path, format: "none", servers: [] };
  }
  const section = obj.mcpServers;
  if (Array.isArray(section)) return parseContinueList(path, section);
  if (section && typeof section === "object") {
    return parseMcpServersValue(path, section);
  }
  return invalidConfig(path, "mcpServers must be a list of servers");
}

function parseContinueFile(path: string, text: string): ConfigFile {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const doc = normalized.endsWith(".json")
    ? readJson(path, text)
    : readYaml(path, text);
  return parseContinueDocument(path, doc);
}

/**
 * `~/.claude.json` holds user servers at the top level and local servers under
 * `projects[<absolute path>]`. Only the scan root's project entry is read.
 * The key matches when it is the same directory, including a symlink.
 * A project entry with the same server name replaces the user entry.
 * With neither section, the file is skipped.
 */
function parseClaudeUserFile(
  path: string,
  text: string,
  options: ParseOptions,
): ConfigFile {
  const json = readJson(path, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = json as Record<string, unknown>;
  const platform = options.platform ?? process.platform;
  const sections: unknown[] = [];

  if ("mcpServers" in obj) sections.push(obj.mcpServers);

  const projects = obj.projects;
  if (
    options.root &&
    projects &&
    typeof projects === "object" &&
    !Array.isArray(projects)
  ) {
    const wanted = canonicalProjectPath(options.root, platform);
    for (const [key, value] of Object.entries(projects)) {
      if (canonicalProjectPath(key, platform) !== wanted) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return invalidConfig(path, "projects entry must be an object");
      }
      if ("mcpServers" in value) sections.push(value.mcpServers);
      break;
    }
  }

  if (sections.length === 0) {
    return { path, format: "none", servers: [] };
  }

  const merged = new Map<string, ParsedServer>();
  for (const section of sections) {
    const parsed = parseMcpServersValue(path, section);
    if (parsed.format !== "mcpServers") return parsed;
    for (const server of parsed.servers) merged.set(server.name, server);
  }
  return { path, format: "mcpServers", servers: [...merged.values()] };
}

/**
 * `.github/mcp.json` is either a `mcpServers` object or a bare map of server
 * entries. `type: "local"` still carries `command` and `args`. `tools` is an
 * allowlist, not a transport. A missing file is never discovered.
 */
function parseCopilotProjectFile(path: string, text: string): ConfigFile {
  const json = readJson(path, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = json as Record<string, unknown>;
  if ("mcpServers" in obj) {
    return parseMcpServersValue(path, obj.mcpServers);
  }
  const parsed = z.record(z.string(), ServerEntrySchema).safeParse(obj);
  if (!parsed.success) {
    return invalidConfig(path, formatZodError(parsed.error));
  }
  return { path, format: "mcpServers", servers: mapServers(parsed.data) };
}

/**
 * VS Code allows stdio env values that are numbers or null.
 * A number is the decimal string the host passes to the process.
 * Null unsets the variable, so the key is dropped.
 * Booleans and objects stay invalid. Other clients still require strings.
 */
function coerceVsCodeEnvValues(doc: Record<string, unknown>): void {
  const servers = doc.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const entry of Object.values(servers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const env = (entry as Record<string, unknown>).env;
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    const record = env as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        record[key] = String(value);
      } else if (value === null) {
        delete record[key];
      }
    }
  }
}

function parseJsonDocument(path: string, text: string): ConfigFile {
  const json = readJson(path, text);

  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;

    // Claude Code ignores this key. Do not grade the entries as live servers.
    if (isClaudeSettingsFile(path) && "mcpServers" in obj) {
      return {
        path,
        format: "invalid",
        servers: [],
        error: CLAUDE_SETTINGS_MCP_SERVERS,
      };
    }

    if ("mcpServers" in obj) {
      return parseMcpServersValue(path, obj.mcpServers);
    }

    if ("servers" in obj) {
      coerceVsCodeEnvValues(obj);
      const asServers = ServersDocSchema.safeParse(json);
      if (asServers.success) {
        return {
          path,
          format: "servers",
          servers: mapServers(asServers.data.servers),
        };
      }
      return {
        path,
        format: "invalid",
        servers: [],
        error: formatZodError(asServers.error),
      };
    }

    if ("context_servers" in obj) {
      const asContext = ContextServersDocSchema.safeParse(json);
      if (asContext.success) {
        return {
          path,
          format: "contextServers",
          servers: mapServers(asContext.data.context_servers),
        };
      }
      return {
        path,
        format: "invalid",
        servers: [],
        error: formatZodError(asContext.error),
      };
    }

    return { path, format: "none", servers: [] };
  }

  return { path, format: "unknown", servers: [] };
}

export function parseConfigFile(path: string, options: ParseOptions = {}): ConfigFile {
  const text = readFileSync(path, "utf8");
  if (path.replace(/\\/g, "/").endsWith(".toml")) {
    return parseCodexToml(path, text);
  }
  if (isContinueConfig(path)) return parseContinueFile(path, text);
  if (isClaudeUserConfig(path)) return parseClaudeUserFile(path, text, options);
  if (isCopilotProjectConfig(path)) return parseCopilotProjectFile(path, text);
  if (isOpenCodeConfigFile(path, options)) return parseOpenCodeFile(path, text);
  if (isAmazonQConfig(path)) return parseAmazonQFile(path, text);
  if (isAmpSettings(path)) return parseAmpFile(path, text);
  if (isGooseConfig(path)) return parseGooseFile(path, text);
  return parseJsonDocument(path, text);
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? normalized;
}

function sameConfigPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  let a = resolve(left);
  let b = resolve(right);
  if (platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/**
 * OpenCode `opencode.json` / `opencode.jsonc`, including a file selected by
 * `OPENCODE_CONFIG`. The basename check covers project and default user files.
 */
function isOpenCodeConfigFile(path: string, options: ParseOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  let name = fileName(path);
  if (platform === "win32") name = name.toLowerCase();
  if (name === "opencode.json" || name === "opencode.jsonc") return true;
  const explicit = (options.env ?? process.env).OPENCODE_CONFIG?.trim();
  if (!explicit) return false;
  return sameConfigPath(path, explicit, platform);
}

/**
 * OpenCode stores servers under `mcp`, not `mcpServers`.
 * `type: "local"` command is `[program, ...args]`. Env is `environment`.
 * `type: "remote"` uses `url`. An entry that is only `{ "enabled": true }`
 * opts into a remote default this scan does not load, so it is not a server.
 * `{ "enabled": false }` with no command or URL is disabled and not checked.
 * `tools`, `agent`, `plugin`, and `$schema` are not servers.
 */
function parseOpenCodeFile(path: string, text: string): ConfigFile {
  const json = readJson(path, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = json as Record<string, unknown>;
  if (!("mcp" in obj)) {
    return { path, format: "none", servers: [] };
  }
  const mcp = obj.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    return invalidConfig(path, "mcp must be an object of servers");
  }

  const record: Record<string, ServerEntry> = {};
  for (const [name, value] of Object.entries(mcp)) {
    const parsed = parseOpenCodeEntry(name, value);
    if (parsed.kind === "error") return invalidConfig(path, parsed.error);
    if (parsed.kind === "skip") continue;
    record[name] = parsed.entry;
  }
  return { path, format: "opencode", servers: mapServers(record) };
}

function parseOpenCodeEntry(
  name: string,
  value: unknown,
):
  | { kind: "server"; entry: ServerEntry }
  | { kind: "skip" }
  | { kind: "error"; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", error: `mcp.${name} must be an object` };
  }
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { kind: "error", error: `mcp.${name}.enabled must be a boolean` };
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const type = raw.type;

  if (type === undefined) {
    if (raw.command === undefined && raw.url === undefined) {
      if (enabled === false) return { kind: "server", entry: { enabled: false } };
      if (enabled === true) return { kind: "skip" };
    }
    return {
      kind: "error",
      error: `mcp.${name}.type must be "local" or "remote"`,
    };
  }
  if (type !== "local" && type !== "remote") {
    return {
      kind: "error",
      error: `mcp.${name}.type must be "local" or "remote"`,
    };
  }

  const environment =
    raw.environment === undefined ? undefined : asStringRecord(raw.environment);
  if (raw.environment !== undefined && !environment) {
    return {
      kind: "error",
      error: `mcp.${name}.environment values must be strings`,
    };
  }
  const headers = raw.headers === undefined ? undefined : asStringRecord(raw.headers);
  if (raw.headers !== undefined && !headers) {
    return {
      kind: "error",
      error: `mcp.${name}.headers values must be strings`,
    };
  }

  if (type === "local") {
    const command = asStringArray(raw.command);
    if (!command || command.length === 0 || !command[0]?.trim()) {
      return {
        kind: "error",
        error: `mcp.${name}.command must be a non-empty array of strings`,
      };
    }
    return {
      kind: "server",
      entry: {
        type: "local",
        command: command[0].trim(),
        args: command.slice(1),
        env: environment,
        headers,
        enabled,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      },
    };
  }

  if (raw.url !== undefined && typeof raw.url !== "string") {
    return { kind: "error", error: `mcp.${name}.url must be a string` };
  }
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  return {
    kind: "server",
    entry: {
      type: "remote",
      url: url || undefined,
      env: environment,
      headers,
      enabled,
    },
  };
}

/**
 * Antigravity `mcp_config.json` (project `.agents/` or user `~/.gemini/config/`).
 * A file with no `mcpServers` key is normal. Windsurf and Devin `mcp_config.json`
 * paths do not match.
 */
function isAntigravityMcpConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".agents/mcp_config.json" ||
    normalized.endsWith("/.agents/mcp_config.json") ||
    normalized === ".gemini/config/mcp_config.json" ||
    normalized.endsWith("/.gemini/config/mcp_config.json")
  );
}

/**
 * Kiro workspace and user `mcp.json`. A file with no `mcpServers` key is normal.
 * Other `mcp.json` files do not match.
 */
function isKiroMcpConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".kiro/settings/mcp.json" ||
    normalized.endsWith("/.kiro/settings/mcp.json")
  );
}

/**
 * Amazon Q Developer `.amazonq/mcp.json`, `.amazonq/default.json`, and the
 * user copies under `~/.aws/amazonq/`. Only `mcpServers` is a server map.
 * Other agent keys, including a `servers` key, are not MCP servers.
 */
function isAmazonQConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(?:^|\/)\.?amazonq\/(?:mcp|default)\.json$/.test(normalized);
}

/** GUI agent file. A copy with no `mcpServers` key stores non-MCP settings. */
function isAmazonQDefaultConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(?:^|\/)\.?amazonq\/default\.json$/.test(normalized);
}

function parseAmazonQFile(path: string, text: string): ConfigFile {
  const json = readJson(path, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = json as Record<string, unknown>;
  if (!("mcpServers" in obj)) return { path, format: "none", servers: [] };
  return parseMcpServersValue(path, obj.mcpServers);
}

/**
 * Amp project `.amp/settings.json` / `.amp/settings.jsonc` and user
 * `~/.config/amp/settings.json` / `settings.jsonc`. Servers are `amp.mcpServers`.
 * Other `amp.*` keys are not servers.
 */
function isAmpSettings(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    /(?:^|\/)\.amp\/settings\.jsonc?$/.test(normalized) ||
    /(?:^|\/)\.config\/amp\/settings\.jsonc?$/.test(normalized)
  );
}

function parseAmpFile(path: string, text: string): ConfigFile {
  const json = readJson(path, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = json as Record<string, unknown>;
  if (!("amp.mcpServers" in obj)) return { path, format: "none", servers: [] };
  const parsed = parseMcpServersValue(path, obj["amp.mcpServers"]);
  if (parsed.format === "invalid" && parsed.error) {
    return {
      ...parsed,
      error: parsed.error.replaceAll("mcpServers", "amp.mcpServers"),
    };
  }
  return parsed;
}

/**
 * Goose user `config.yaml`. `extensions` is the map. `type: stdio` uses `cmd`
 * and `args`. `type: streamable_http` uses `uri`. `builtin` and `platform`
 * are not MCP commands. `envs` is checked like `env`. A file with no
 * `extensions` key is skipped. This does not match a project `.goose/` path.
 */
function isGooseConfig(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    /(?:^|\/)goose\/config\.yaml$/.test(normalized) ||
    /(?:^|\/)goose\/config\/config\.yaml$/.test(normalized)
  );
}

function parseGooseFile(path: string, text: string): ConfigFile {
  const doc = readYaml(path, text);
  if (doc === null || doc === undefined) {
    return { path, format: "none", servers: [] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { path, format: "unknown", servers: [] };
  }
  const obj = doc as Record<string, unknown>;
  if (!("extensions" in obj)) return { path, format: "none", servers: [] };
  const extensions = obj.extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) {
    return invalidConfig(path, "extensions must be a map of extensions");
  }

  const record: Record<string, ServerEntry> = {};
  for (const [name, value] of Object.entries(extensions)) {
    const parsed = parseGooseEntry(name, value);
    if (parsed.kind === "error") return invalidConfig(path, parsed.error);
    if (parsed.kind === "skip") continue;
    record[name] = parsed.entry;
  }
  return { path, format: "goose", servers: mapServers(record) };
}

function parseGooseEntry(
  name: string,
  value: unknown,
):
  | { kind: "server"; entry: ServerEntry }
  | { kind: "skip" }
  | { kind: "error"; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", error: `extensions.${name} must be an object` };
  }
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { kind: "error", error: `extensions.${name}.enabled must be a boolean` };
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const type = raw.type;
  if (type === "builtin" || type === "platform") return { kind: "skip" };
  if (type !== "stdio" && type !== "streamable_http") {
    return {
      kind: "error",
      error: `extensions.${name}.type must be stdio, streamable_http, builtin, or platform`,
    };
  }

  const envs = raw.envs === undefined ? undefined : asStringRecord(raw.envs);
  if (raw.envs !== undefined && !envs) {
    return { kind: "error", error: `extensions.${name}.envs values must be strings` };
  }
  const headers = raw.headers === undefined ? undefined : asStringRecord(raw.headers);
  if (raw.headers !== undefined && !headers) {
    return { kind: "error", error: `extensions.${name}.headers values must be strings` };
  }

  if (type === "stdio") {
    if (raw.cmd !== undefined && typeof raw.cmd !== "string") {
      return { kind: "error", error: `extensions.${name}.cmd must be a string` };
    }
    const args = raw.args === undefined ? undefined : asStringArray(raw.args);
    if (raw.args !== undefined && !args) {
      return {
        kind: "error",
        error: `extensions.${name}.args must be an array of strings`,
      };
    }
    const command = typeof raw.cmd === "string" ? raw.cmd.trim() : "";
    return {
      kind: "server",
      entry: {
        type: "stdio",
        command: command || undefined,
        args: args ?? [],
        env: envs,
        headers,
        enabled,
      },
    };
  }

  if (raw.uri !== undefined && typeof raw.uri !== "string") {
    return { kind: "error", error: `extensions.${name}.uri must be a string` };
  }
  const uri = typeof raw.uri === "string" ? raw.uri.trim() : "";
  return {
    kind: "server",
    entry: {
      type: "streamable_http",
      url: uri || undefined,
      env: envs,
      headers,
      enabled,
    },
  };
}

/**
 * Roo Code project `.roo/mcp.json`, and the user globalStorage files
 * `mcp_settings.json` and legacy `cline_mcp_settings.json`.
 * A copy with no `mcpServers` key is normal. Other `mcp.json` files do not match.
 */
function isRooMcpFile(path: string, options: ParseOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  let normalized = path.replace(/\\/g, "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  if (normalized === ".roo/mcp.json" || normalized.endsWith("/.roo/mcp.json")) {
    return true;
  }
  return (
    normalized.endsWith(
      "/rooveterinaryinc.roo-cline/settings/mcp_settings.json",
    ) ||
    normalized.endsWith(
      "/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json",
    )
  );
}

/** Settings-style files may exist without an MCP section — don't hard-fail. */
export function isOptionalMcpFile(
  path: string,
  options: ParseOptions = {},
): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.endsWith("/settings.json") ||
    normalized.endsWith("/settings.local.json") ||
    normalized.endsWith("/claude_desktop_config.json") ||
    normalized.endsWith(".codex/config.toml") ||
    isAntigravityMcpConfig(path) ||
    isKiroMcpConfig(path) ||
    isAmazonQDefaultConfig(path) ||
    isAmpSettings(path) ||
    isGooseConfig(path) ||
    isOpenCodeConfigFile(path, options) ||
    isRooMcpFile(path, options) ||
    isClaudeUserConfig(path) ||
    isContinueConfig(path)
  );
}
