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
        error: { code: -32601, message: "Method not found" },
      })}\n`,
    );
    return;
  }

  if (msg?.method === "server/discover") {
    const version = msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (version !== "2026-07-28") {
      process.stderr.write(`unexpected protocol ${version ?? ""}\n`);
      process.exit(5);
    }
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? 2,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: {},
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
        result: { tools: [{ name: "echo", description: "fixture tool" }] },
      })}\n`,
    );
  }
});
