#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg?.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "tools-error", version: "0.0.1" },
        },
      })}\n`,
    );
    return;
  }
  if (msg?.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? 3,
        error: { code: -32602, message: "tools unavailable" },
      })}\n`,
    );
  }
});
