import readline from "node:readline";

const DEFAULT_TOOLS = [{ name: "echo", description: "fixture tool" }];

/**
 * Answer initialize, tools/list, resources/list, and prompts/list on stdin.
 * Pass `{ tools: [] }` for an empty tool catalog. Empty resources and prompts
 * are the default and add no probe finding.
 */
export function replyToInitialize(options = {}) {
  const tools = options.tools ?? DEFAULT_TOOLS;
  const resources = options.resources ?? [];
  const prompts = options.prompts ?? [];
  const resourcesError = options.resourcesError;
  const promptsError = options.promptsError;
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
      return;
    }
    if (msg?.method === "resources/list") {
      const response = resourcesError
        ? { jsonrpc: "2.0", id: msg.id ?? 4, error: resourcesError }
        : { jsonrpc: "2.0", id: msg.id ?? 4, result: { resources } };
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
    if (msg?.method === "prompts/list") {
      const response = promptsError
        ? { jsonrpc: "2.0", id: msg.id ?? 5, error: promptsError }
        : { jsonrpc: "2.0", id: msg.id ?? 5, result: { prompts } };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
