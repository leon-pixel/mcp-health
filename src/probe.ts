import { spawn, type ChildProcess } from "node:child_process";
import { commandNeedsShell, resolveCommandOnPath } from "./check.js";
import type { Finding, ParsedServer, Severity } from "./types.js";
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  VERSION,
} from "./version.js";

const METHOD_NOT_FOUND = -32601;
const UNSUPPORTED_PROTOCOL = -32022;
const MAX_HTTP_BODY = 1_000_000;

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export type ProbeResult = {
  status: Severity;
  findings: Finding[];
};

type RpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
};

function clientInfo() {
  return { name: "mcp-health", version: VERSION };
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: clientInfo(),
    },
  };
}

function toolsListRequest(modern: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (modern) {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": clientInfo(),
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params,
  };
}

function discoverRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": clientInfo(),
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function asRpc(value: unknown): RpcMessage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RpcMessage;
}

function idMatches(message: RpcMessage, id: number): boolean {
  return message.id === id || message.id === String(id);
}

function isDiscoverFallback(message: RpcMessage | undefined): boolean {
  const code = message?.error?.code;
  return code === METHOD_NOT_FOUND || code === UNSUPPORTED_PROTOCOL;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function redactEnv(
  env: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

type Waiter = {
  id: number;
  resolve: (message: RpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Newline-delimited JSON-RPC reader. Log lines, notifications, and
 * responses for a different id are skipped. The wait ends on a matching
 * id, on process close, or on timeout — not only on timeout.
 */
class StdioRpcReader {
  private buffer = "";
  private pending: RpcMessage[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private exitLabel = "closed";

  constructor(child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain(false);
    });
    child.on("close", (code, signal) => {
      this.closed = true;
      this.exitLabel = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
      this.drain(true);
      this.rejectRemaining(
        new Error(`Server exited (${this.exitLabel}) before a JSON-RPC response`),
      );
    });
  }

  waitFor(id: number, timeoutMs: number): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        id,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          resolve(message);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(
            new Error(
              `Timed out waiting for JSON-RPC response id ${id} (${timeoutMs}ms)`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      this.drain(false);
      if (this.closed && this.waiters.includes(waiter)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.reject(
          new Error(
            `Server exited (${this.exitLabel}) before a JSON-RPC response for id ${id}`,
          ),
        );
      }
    });
  }

  private drain(finalFlush: boolean) {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.consume(line);
      newline = this.buffer.indexOf("\n");
    }
    if (finalFlush && this.buffer.trim()) {
      const line = this.buffer.trim();
      this.buffer = "";
      this.consume(line);
    }
    this.matchWaiters();
  }

  private consume(line: string) {
    if (!line) return;
    try {
      const message = asRpc(JSON.parse(line));
      if (message) this.pending.push(message);
    } catch {
      // stdout log line — keep reading for the real response
    }
  }

  private matchWaiters() {
    this.waiters = this.waiters.filter((waiter) => {
      const index = this.pending.findIndex((message) =>
        idMatches(message, waiter.id),
      );
      if (index === -1) return true;
      const message = this.pending[index];
      if (!message) return true;
      this.pending.splice(index, 1);
      waiter.resolve(message);
      return false;
    });
  }

  private rejectRemaining(err: Error) {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.reject(err);
  }
}

function finding(
  severity: Severity,
  code: string,
  message: string,
  server: string,
  file: string,
): ProbeResult {
  return {
    status: severity,
    findings: [{ severity, code, message, server, file }],
  };
}

function toolsFinding(
  message: RpcMessage | undefined,
  server: ParsedServer,
  file: string,
  fallback: string,
): Finding {
  if (!message) {
    return {
      severity: "warn",
      code: "TOOLS_LIST_FAILED",
      message: fallback,
      server: server.name,
      file,
    };
  }
  if (message.error) {
    return {
      severity: "warn",
      code: "TOOLS_LIST_FAILED",
      message: `tools/list error: ${message.error.message ?? "unknown"}`,
      server: server.name,
      file,
    };
  }
  const result = message.result;
  const tools =
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Array.isArray((result as { tools?: unknown }).tools)
      ? (result as { tools: unknown[] }).tools
      : undefined;
  if (!tools) {
    return {
      severity: "warn",
      code: "TOOLS_LIST_FAILED",
      message: "tools/list result has no tools array",
      server: server.name,
      file,
    };
  }
  if (tools.length === 0) {
    return {
      severity: "warn",
      code: "EMPTY_TOOLS",
      message: "Server exposes no tools",
      server: server.name,
      file,
    };
  }
  return {
    severity: "ok",
    code: "TOOLS_OK",
    message: `Server exposes ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
    server: server.name,
    file,
  };
}

function withTools(base: ProbeResult, extra: Finding): ProbeResult {
  return {
    status: worst(base.status, extra.severity),
    findings: [...base.findings, extra],
  };
}

function fromRpc(
  response: RpcMessage,
  server: ParsedServer,
  file: string,
  okMessage: string,
): ProbeResult {
  if (response.error) {
    return finding(
      "fail",
      "PROBE_INIT_ERROR",
      `Initialize error: ${response.error.message ?? "unknown"}`,
      server.name,
      file,
    );
  }
  if (response.result === undefined) {
    return finding(
      "fail",
      "PROBE_NO_RESULT",
      "Initialize response missing result",
      server.name,
      file,
    );
  }
  return finding("ok", "PROBE_OK", okMessage, server.name, file);
}

export async function probeStdioServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string; cwd?: string; listTools?: boolean },
): Promise<ProbeResult> {
  if (server.transport.kind !== "stdio") {
    return { status: "ok", findings: [] };
  }

  const { command, args } = server.transport;
  const envRaw = server.raw.env as Record<string, string> | undefined;
  const resolved = resolveCommandOnPath(command);
  const executable = resolved ?? command;
  const child = spawn(executable, args, {
    env: redactEnv(envRaw),
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
    shell: commandNeedsShell(executable),
  });
  child.stdin?.on("error", () => {
    /* process already exited */
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 2000) stderr = stderr.slice(0, 2000);
  });

  const killHard = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => Math.max(50, deadline - Date.now());
  const reader = new StdioRpcReader(child);
  const write = (payload: Record<string, unknown>) => {
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* ignore */
    }
  };

  try {
    write(initializeRequest());
    let response = await reader.waitFor(1, remaining());
    let viaDiscover = false;

    if (isDiscoverFallback(response)) {
      viaDiscover = true;
      write(discoverRequest());
      response = await reader.waitFor(2, remaining());
    }

    const base = fromRpc(
      response,
      server,
      options.file,
      viaDiscover
        ? "stdio server/discover handshake succeeded"
        : "stdio initialize handshake succeeded",
    );
    if (base.status !== "ok") return base;

    if (!viaDiscover) {
      try {
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
      } catch {
        /* ignore */
      }
    }

    if (options.listTools === false) {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      return base;
    }

    try {
      write(toolsListRequest(viaDiscover));
      const toolsResponse = await reader.waitFor(3, remaining());
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      return withTools(
        base,
        toolsFinding(toolsResponse, server, options.file, "tools/list returned no message"),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return withTools(base, {
        severity: "warn",
        code: "TOOLS_LIST_FAILED",
        message: detail,
        server: server.name,
        file: options.file,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stderrHint = stderr.trim()
      ? ` stderr: ${stderr.trim().slice(0, 240)}`
      : "";
    return finding(
      "fail",
      "PROBE_FAILED",
      `${detail}${stderrHint}`,
      server.name,
      options.file,
    );
  } finally {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(killHard, 500).unref?.();
    }
  }
}

function takeSseMessages(buffer: string): {
  messages: RpcMessage[];
  rest: string;
} {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const messages: RpcMessage[] = [];
  for (const part of parts) {
    const dataLines: string[] = [];
    for (const line of part.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      let payload = line.slice("data:".length);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      dataLines.push(payload);
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data) continue;
    try {
      const message = asRpc(JSON.parse(data));
      if (message) messages.push(message);
    } catch {
      /* ignore non-JSON SSE data */
    }
  }
  return { messages, rest };
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}

async function readMatchingRpc(
  res: Response,
  id: number,
): Promise<RpcMessage | undefined> {
  const contentType = res.headers.get("content-type");
  if (!isEventStream(contentType)) {
    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      const message = asRpc(JSON.parse(trimmed));
      if (!message) return undefined;
      if (idMatches(message, id)) return message;
      if (
        message.id === undefined &&
        (message.result !== undefined || message.error !== undefined)
      ) {
        return message;
      }
      return undefined;
    } catch {
      const parsed = takeSseMessages(`${trimmed}\n\n`);
      return parsed.messages.find((message) => idMatches(message, id));
    }
  }

  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MAX_HTTP_BODY) {
          throw new Error(
            "HTTP probe response exceeded 1MB before a matching JSON-RPC message",
          );
        }
        buf += decoder.decode(value, { stream: !done });
      }
      const parsed = takeSseMessages(buf);
      buf = parsed.rest;
      const match = parsed.messages.find((message) => idMatches(message, id));
      if (match) {
        await reader.cancel().catch(() => undefined);
        return match;
      }
      if (done) {
        if (!buf.trim()) return undefined;
        const tail = takeSseMessages(`${buf}\n\n`);
        return tail.messages.find((message) => idMatches(message, id));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already cancelled */
    }
  }
}

type HttpExchange = {
  status: number;
  message?: RpcMessage;
};

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    const id = typeof body.id === "number" ? body.id : 1;
    let message: RpcMessage | undefined;
    try {
      message = await readMatchingRpc(res, id);
    } catch (err) {
      if (res.status === 401 || res.status === 403) {
        return { status: res.status };
      }
      throw err;
    }
    return { status: res.status, message };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out waiting for HTTP response (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requestHeaders(
  server: ParsedServer,
  protocol: string,
): Record<string, string> {
  return {
    ...stringRecord(server.raw.headers),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocol,
  };
}

function httpOutcome(
  exchange: HttpExchange,
  server: ParsedServer,
  file: string,
): ProbeResult {
  const { status, message } = exchange;
  if (status === 401 || status === 403) {
    const configured = Object.keys(stringRecord(server.raw.headers));
    const headerNote =
      configured.length > 0
        ? ` Config headers were sent (${configured.join(", ")}).`
        : " No headers are set on this server.";
    return finding(
      "fail",
      "PROBE_HTTP_AUTH",
      `HTTP probe unauthorized (${status}).${headerNote}`,
      server.name,
      file,
    );
  }

  if (message?.result !== undefined) {
    return finding(
      "ok",
      "PROBE_OK",
      `HTTP initialize succeeded (${status})`,
      server.name,
      file,
    );
  }

  if (message?.error) {
    return finding(
      "fail",
      "PROBE_INIT_ERROR",
      `Initialize error: ${message.error.message ?? "unknown"}`,
      server.name,
      file,
    );
  }

  if (status >= 500) {
    return finding(
      "fail",
      "PROBE_HTTP_ERROR",
      `HTTP probe failed with status ${status}`,
      server.name,
      file,
    );
  }

  if (status > 0 && status < 500) {
    return finding(
      "warn",
      "PROBE_HTTP_REACHABLE",
      `HTTP endpoint responded ${status} but not a clear initialize result`,
      server.name,
      file,
    );
  }

  return finding(
    "fail",
    "PROBE_FAILED",
    "HTTP probe produced no response",
    server.name,
    file,
  );
}

async function withHttpTools(
  base: ProbeResult,
  server: ParsedServer,
  options: { timeoutMs: number; file: string; listTools?: boolean },
  modern: boolean,
  remaining: () => number,
): Promise<ProbeResult> {
  if (base.status !== "ok" || options.listTools === false) return base;
  if (server.transport.kind !== "http") return base;
  try {
    const exchange = await postJson(
      server.transport.url,
      toolsListRequest(modern),
      requestHeaders(server, modern ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION),
      remaining(),
    );
    if (exchange.status === 401 || exchange.status === 403) {
      return withTools(base, {
        severity: "warn",
        code: "TOOLS_LIST_FAILED",
        message: `tools/list unauthorized (${exchange.status})`,
        server: server.name,
        file: options.file,
      });
    }
    return withTools(
      base,
      toolsFinding(
        exchange.message,
        server,
        options.file,
        `tools/list returned HTTP ${exchange.status} without a tools array`,
      ),
    );
  } catch (err) {
    return withTools(base, {
      severity: "warn",
      code: "TOOLS_LIST_FAILED",
      message: err instanceof Error ? err.message : String(err),
      server: server.name,
      file: options.file,
    });
  }
}

export async function probeHttpServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string; listTools?: boolean },
): Promise<ProbeResult> {
  if (server.transport.kind !== "http") {
    return { status: "ok", findings: [] };
  }

  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => Math.max(50, deadline - Date.now());

  try {
    let exchange = await postJson(
      server.transport.url,
      initializeRequest(),
      requestHeaders(server, LEGACY_PROTOCOL_VERSION),
      remaining(),
    );

    const tryDiscover =
      exchange.status !== 401 &&
      exchange.status !== 403 &&
      exchange.message?.result === undefined &&
      (isDiscoverFallback(exchange.message) ||
        (exchange.status === 400 && exchange.message?.result === undefined));

    if (tryDiscover) {
      const discovered = await postJson(
        server.transport.url,
        discoverRequest(),
        requestHeaders(server, MODERN_PROTOCOL_VERSION),
        remaining(),
      );
      if (discovered.message?.result !== undefined) {
        return withHttpTools(
          finding(
            "ok",
            "PROBE_OK",
            `HTTP server/discover handshake succeeded (${discovered.status})`,
            server.name,
            options.file,
          ),
          server,
          options,
          true,
          remaining,
        );
      }
      if (discovered.status === 401 || discovered.status === 403) {
        return httpOutcome(discovered, server, options.file);
      }
      if (!exchange.message?.error) exchange = discovered;
    }

    return withHttpTools(
      httpOutcome(exchange, server, options.file),
      server,
      options,
      false,
      remaining,
    );
  } catch (err) {
    return finding(
      "fail",
      "PROBE_FAILED",
      err instanceof Error ? err.message : String(err),
      server.name,
      options.file,
    );
  }
}

export async function probeServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string; cwd?: string; listTools?: boolean },
): Promise<ProbeResult> {
  if (server.transport.kind === "stdio") {
    return probeStdioServer(server, options);
  }
  if (server.transport.kind === "http") {
    return probeHttpServer(server, options);
  }
  return {
    status: "warn",
    findings: [
      {
        severity: "warn",
        code: "PROBE_SKIPPED",
        message: "No transport to probe",
        server: server.name,
        file: options.file,
      },
    ],
  };
}

export { worst };
