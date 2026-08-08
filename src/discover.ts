import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const RELATIVE_CANDIDATES = [
  ".cursor/mcp.json",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
] as const;

export function discoverConfigPaths(
  root: string,
  options: { includeUserConfig?: boolean } = {},
): string[] {
  const absRoot = resolve(root);
  const found = new Set<string>();

  for (const rel of RELATIVE_CANDIDATES) {
    const full = join(absRoot, rel);
    if (existsSync(full)) found.add(full);
  }

  if (options.includeUserConfig !== false) {
    const userCursor = join(homedir(), ".cursor", "mcp.json");
    if (existsSync(userCursor)) found.add(userCursor);
  }

  return [...found].sort();
}
