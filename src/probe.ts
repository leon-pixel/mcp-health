import { spawn } from "node:child_process";
import type { Finding, ParsedServer, Severity } from "./types.js";

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-health", version: "0.3.0" },
  },
};

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export type ProbeResult = {
  status: Severity;
  findings: Finding[];
};

function redactEnv(
  env: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  // Pass through for the child, but we never log values.
  return { ...process.env, ...(env ?? {}) };
}

async function readJsonLine(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON response (${timeoutMs}ms)`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      cleanup();
      if (!line) {
        reject(new Error("Empty line from server"));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(
          new Error(
            `Non-JSON from server: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    };

    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onErr);
    };

    stream.on("data", onData);
    stream.on("error", onErr);
  });
}

export async function probeStdioServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string; cwd?: string },
): Promise<ProbeResult> {
  const findings: Finding[] = [];
  if (server.transport.kind !== "stdio") {
    return { status: "ok", findings };
  }

  const { command, args } = server.transport;
  const envRaw = server.raw.env as Record<string, string> | undefined;

  const child = spawn(command, args, {
    env: redactEnv(envRaw),
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
  });

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
    if (stderr.length > 2000) stderr = stderr.slice(0, 2000);
  });

  const killHard = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  try {
    const payload = `${JSON.stringify(INIT_REQUEST)}\n`;
    child.stdin?.write(payload);

    const response = (await readJsonLine(
      child.stdout!,
      options.timeoutMs,
    )) as {
      result?: unknown;
      error?: { message?: string };
      id?: unknown;
    };

    if (response.error) {
      findings.push({
        severity: "fail",
        code: "PROBE_INIT_ERROR",
        message: `Initialize error: ${response.error.message ?? "unknown"}`,
        server: server.name,
        file: options.file,
      });
      return { status: "fail", findings };
    }

    if (!response.result) {
      findings.push({
        severity: "fail",
        code: "PROBE_NO_RESULT",
        message: "Initialize response missing result",
        server: server.name,
        file: options.file,
      });
      return { status: "fail", findings };
    }

    // Best-effort initialized notification then close stdin
    try {
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin?.end();
    } catch {
      /* ignore */
    }

    findings.push({
      severity: "ok",
      code: "PROBE_OK",
      message: "stdio initialize handshake succeeded",
      server: server.name,
      file: options.file,
    });
    return { status: "ok", findings };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stderrHint = stderr.trim()
      ? ` stderr: ${stderr.trim().slice(0, 240)}`
      : "";
    findings.push({
      severity: "fail",
      code: "PROBE_FAILED",
      message: `${detail}${stderrHint}`,
      server: server.name,
      file: options.file,
    });
    return { status: "fail", findings };
  } finally {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(killHard, 500).unref?.();
    }
  }
}

export async function probeHttpServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string },
): Promise<ProbeResult> {
  const findings: Finding[] = [];
  if (server.transport.kind !== "http") {
    return { status: "ok", findings };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetch(server.transport.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    // Many gateways return 4xx without full MCP — treat reachable HTTP as warn if not JSON-RPC ok
    const text = await res.text();
    let json: { result?: unknown; error?: unknown } | undefined;
    try {
      json = JSON.parse(text) as { result?: unknown; error?: unknown };
    } catch {
      json = undefined;
    }

    if (json?.result) {
      findings.push({
        severity: "ok",
        code: "PROBE_OK",
        message: `HTTP initialize succeeded (${res.status})`,
        server: server.name,
        file: options.file,
      });
      return { status: "ok", findings };
    }

    if (res.ok || res.status < 500) {
      findings.push({
        severity: "warn",
        code: "PROBE_HTTP_REACHABLE",
        message: `HTTP endpoint responded ${res.status} but not a clear initialize result`,
        server: server.name,
        file: options.file,
      });
      return { status: "warn", findings };
    }

    findings.push({
      severity: "fail",
      code: "PROBE_HTTP_ERROR",
      message: `HTTP probe failed with status ${res.status}`,
      server: server.name,
      file: options.file,
    });
    return { status: "fail", findings };
  } catch (err) {
    findings.push({
      severity: "fail",
      code: "PROBE_FAILED",
      message: err instanceof Error ? err.message : String(err),
      server: server.name,
      file: options.file,
    });
    return { status: "fail", findings };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeServer(
  server: ParsedServer,
  options: { timeoutMs: number; file: string; cwd?: string },
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
