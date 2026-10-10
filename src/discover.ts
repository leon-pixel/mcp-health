import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_CANDIDATES = [
  ".cursor/mcp.json",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".windsurf/mcp_config.json",
  ".zed/settings.json",
  ".codex/config.toml",
] as const;

function claudeDesktopPaths(): string[] {
  const home = homedir();
  const p = platform();
  if (p === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    ];
  }
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Claude", "claude_desktop_config.json")];
  }
  // linux + others
  return [
    join(home, ".config", "Claude", "claude_desktop_config.json"),
  ];
}

function windsurfUserPaths(): string[] {
  const home = homedir();
  const paths = [join(home, ".codeium", "windsurf", "mcp_config.json")];
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    paths.push(join(appData, "devin", "mcp_config.json"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    paths.push(join(xdg, "devin", "mcp_config.json"));
  }
  return paths;
}

function zedUserPaths(): string[] {
  const home = homedir();
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Zed", "settings.json")];
  }
  if (platform() === "darwin") {
    return [
      join(home, "Library", "Application Support", "Zed", "settings.json"),
      join(home, ".config", "zed", "settings.json"),
    ];
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(xdg, "zed", "settings.json")];
}

function userLevelPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".cursor", "mcp.json"),
    join(home, ".claude", "settings.json"),
    ...claudeDesktopPaths(),
    ...windsurfUserPaths(),
    ...zedUserPaths(),
    join(home, ".codex", "config.toml"),
  ];
}

export function discoverConfigPaths(
  root: string,
  options: { includeUserConfig?: boolean } = {},
): string[] {
  const absRoot = resolve(root);
  const found = new Set<string>();

  for (const rel of PROJECT_CANDIDATES) {
    const full = join(absRoot, rel);
    if (existsSync(full)) found.add(full);
  }

  if (options.includeUserConfig !== false) {
    for (const full of userLevelPaths()) {
      if (existsSync(full)) found.add(full);
    }
  }

  return [...found].sort();
}

export const __testing = { claudeDesktopPaths, userLevelPaths, PROJECT_CANDIDATES };
