#!/usr/bin/env node
import { replyToInitialize } from "../support/stdio-reply.mjs";

if (process.env.MCP_HEALTH_SECRET !== "super-secret-tool-token") {
  process.stderr.write("missing secret\n");
  process.exit(4);
}

replyToInitialize({
  tools: [{ name: "echo", description: "fixture tool" }],
});
