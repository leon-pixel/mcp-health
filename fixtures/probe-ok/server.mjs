#!/usr/bin/env node
/**
 * Minimal stdio MCP-ish server for probe tests.
 * Reads newline-delimited JSON-RPC; answers initialize.
 */
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
    const response = {
      jsonrpc: "2.0",
      id: msg.id ?? 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "fixture-probe-server", version: "0.0.1" },
      },
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
