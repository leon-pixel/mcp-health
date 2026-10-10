import readline from "node:readline";

const DEFAULT_TOOLS = [{ name: "echo", description: "fixture tool" }];

/**
 * Answer initialize and tools/list on stdin.
 * Pass `{ tools: [] }` for an empty catalog.
 */
export function replyToInitialize(options = {}) {
  const tools = options.tools ?? DEFAULT_TOOLS;
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
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "fixture-probe-server", version: "0.0.1" },
        },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
    if (msg?.method === "tools/list") {
      const response = {
        jsonrpc: "2.0",
        id: msg.id ?? 3,
        result: { tools },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
