import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
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
    serverUrl: z.string().optional(),
    type: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
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

type ServerEntry = z.infer<typeof ServerEntrySchema>;

function httpUrl(entry: ServerEntry): string | undefined {
  const url = entry.url?.trim() || entry.serverUrl?.trim();
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
    format === "codex"
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
    record[name] = {
      command: typeof entry.command === "string" ? entry.command : undefined,
      args,
      url: typeof entry.url === "string" ? entry.url : undefined,
      env,
      headers,
    };
  }

  return { path, format: "codex", servers: mapServers(record) };
}

export function parseConfigFile(path: string): ConfigFile {
  const text = readFileSync(path, "utf8");
  if (path.replace(/\\/g, "/").endsWith(".toml")) {
    return parseCodexToml(path, text);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;

    if ("mcpServers" in obj) {
      const asMcp = McpServersDocSchema.safeParse(json);
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

    if ("servers" in obj) {
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

/** Settings-style files may exist without an MCP section — don't hard-fail. */
export function isOptionalMcpFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.endsWith("/settings.json") ||
    normalized.endsWith("/settings.local.json") ||
    normalized.endsWith("/claude_desktop_config.json") ||
    normalized.endsWith(".codex/config.toml")
  );
}
