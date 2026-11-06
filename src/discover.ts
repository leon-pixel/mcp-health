import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ConfigScope } from "./types.js";

const PROJECT_CANDIDATES = [
  ".cursor/mcp.json",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".github/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".gemini/settings.json",
  ".agents/mcp_config.json",
  ".kiro/settings/mcp.json",
  ".amazonq/mcp.json",
  ".amazonq/default.json",
  ".amp/settings.json",
  ".amp/settings.jsonc",
  "opencode.json",
  "opencode.jsonc",
  ".junie/mcp/mcp.json",
  ".roo/mcp.json",
  ".continue/config.yaml",
  ".windsurf/mcp_config.json",
  ".zed/settings.json",
  ".codex/config.toml",
] as const;

const CONTINUE_BLOCK = /\.(yaml|yml|json)$/i;

/**
 * Directory names the recursive walk does not enter.
 * `node_modules` and build output are where a monorepo scan would spend its time.
 */
const SKIP_DIR_NAMES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".venv",
  "venv",
  "target",
] as const;

/**
 * Directories below the scan root that `--recursive` still scans.
 * A config in a directory at this depth is found. One level deeper is not.
 */
const MAX_RECURSIVE_DEPTH = 8;

/** Package-family name of the official Claude Desktop MSIX install. */
const CLAUDE_DESKTOP_MSIX_FAMILY = "Claude_pzs8sxrjxfjjc";

export type LocateOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

function locate(options: LocateOptions = {}): {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    platform: options.platform ?? platform(),
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
  };
}

/** Unset and whitespace-only values are missing. A relative path is not. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Windows roaming config root.
 * A blank `APPDATA` is the same as an unset one: `%USERPROFILE%\AppData\Roaming`.
 */
function windowsRoaming(env: NodeJS.ProcessEnv, home: string): string {
  return nonBlank(env.APPDATA) ?? join(home, "AppData", "Roaming");
}

/**
 * Windows local config root.
 * A blank `LOCALAPPDATA` is missing, so the Claude Desktop MSIX path is skipped.
 */
function windowsLocal(env: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(env.LOCALAPPDATA);
}

/**
 * XDG config directory.
 * A blank or relative `XDG_CONFIG_HOME` is not a directory. Use `~/.config`
 * instead of resolving that value from the working directory.
 * An absolute value is used as given.
 */
function xdgConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = nonBlank(env.XDG_CONFIG_HOME);
  if (xdg && isAbsolute(xdg)) return xdg;
  return join(home, ".config");
}

function claudeDesktopPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  if (p === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    ];
  }
  if (p === "win32") {
    const appData = windowsRoaming(env, home);
    const paths = [join(appData, "Claude", "claude_desktop_config.json")];
    // The MSIX build reads a virtualized Roaming file. Skip it when LOCALAPPDATA is blank.
    const localAppData = windowsLocal(env);
    if (localAppData) {
      paths.push(
        join(
          localAppData,
          "Packages",
          CLAUDE_DESKTOP_MSIX_FAMILY,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        ),
      );
    }
    return paths;
  }
  // linux + others
  return [
    join(home, ".config", "Claude", "claude_desktop_config.json"),
  ];
}

function windsurfUserPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  const paths = [join(home, ".codeium", "windsurf", "mcp_config.json")];
  if (p === "win32") {
    paths.push(join(windowsRoaming(env, home), "devin", "mcp_config.json"));
  } else {
    paths.push(join(xdgConfigDir(env, home), "devin", "mcp_config.json"));
  }
  return paths;
}

function zedUserPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  if (p === "win32") {
    return [join(windowsRoaming(env, home), "Zed", "settings.json")];
  }
  if (p === "darwin") {
    return [
      join(home, "Library", "Application Support", "Zed", "settings.json"),
      join(home, ".config", "zed", "settings.json"),
    ];
  }
  return [join(xdgConfigDir(env, home), "zed", "settings.json")];
}

/**
 * Gemini CLI user settings.
 * `GEMINI_CLI_HOME` replaces the home directory; the file is still `.gemini/settings.json`.
 */
function geminiUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const geminiHome = env.GEMINI_CLI_HOME?.trim();
  return join(geminiHome || home, ".gemini", "settings.json");
}

/**
 * Google Antigravity user MCP config.
 * This is not Gemini CLI's `settings.json`. `GEMINI_CLI_HOME` does not move it.
 */
function antigravityUserPath(options: LocateOptions = {}): string {
  const { home } = locate(options);
  return join(home, ".gemini", "config", "mcp_config.json");
}

/**
 * Kiro user MCP config.
 * The file is `~/.kiro/settings/mcp.json` on macOS, Linux, and Windows.
 * It is not under `%APPDATA%`. `KIRO_HOME` and agent JSON are not scanned.
 */
function kiroUserPath(options: LocateOptions = {}): string {
  const { home } = locate(options);
  return join(home, ".kiro", "settings", "mcp.json");
}

/**
 * Amazon Q Developer user MCP config.
 * Global scope is `~/.aws/amazonq/mcp.json` and `~/.aws/amazonq/default.json`
 * on macOS, Linux, and Windows (`%USERPROFILE%\.aws\amazonq\`, not `%APPDATA%`).
 * `default.json` is the GUI agent file. A copy with no `mcpServers` key is skipped.
 */
function amazonQUserPaths(options: LocateOptions = {}): string[] {
  const { home } = locate(options);
  const dir = join(home, ".aws", "amazonq");
  return [join(dir, "mcp.json"), join(dir, "default.json")];
}

/**
 * Amp user settings.
 * The files are `~/.config/amp/settings.json` and `settings.jsonc` on macOS,
 * Linux, and Windows (`%USERPROFILE%\.config\amp\`, not `%APPDATA%`).
 * `XDG_CONFIG_HOME` selects Amp plugins, not these settings files.
 * Project `.amp/settings.json` is a different file.
 */
function ampUserPaths(options: LocateOptions = {}): string[] {
  const { home } = locate(options);
  const dir = join(home, ".config", "amp");
  return [join(dir, "settings.json"), join(dir, "settings.jsonc")];
}

/**
 * Goose user config.
 * macOS and Linux: `$XDG_CONFIG_HOME/goose/config.yaml` when that variable is
 * an absolute path, otherwise `~/.config/goose/config.yaml`. A blank or
 * relative `XDG_CONFIG_HOME` is ignored, matching Goose. Windows reads
 * `%APPDATA%\Block\goose\config\config.yaml` and does not use `XDG_CONFIG_HOME`.
 * A blank `APPDATA` uses `%USERPROFILE%\AppData\Roaming`.
 * There is no project config. `secrets.yaml` is not this file.
 * An absolute `GOOSE_PATH_ROOT` is not scanned.
 */
function gooseUserPath(options: LocateOptions = {}): string {
  const { platform: p, home, env } = locate(options);
  if (p === "win32") {
    return join(windowsRoaming(env, home), "Block", "goose", "config", "config.yaml");
  }
  return join(xdgConfigDir(env, home), "goose", "config.yaml");
}

/**
 * OpenCode user config.
 * OpenCode reads `opencode.json` and `opencode.jsonc` from
 * `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`) on macOS, Linux,
 * and Windows. It does not use `%APPDATA%`. A blank or relative
 * `XDG_CONFIG_HOME` keeps `~/.config`. A non-empty `OPENCODE_CONFIG`
 * replaces those files. A blank value keeps the defaults.
 * Project `opencode.json` is a different file.
 */
function opencodeUserPaths(options: LocateOptions = {}): string[] {
  const { home, env } = locate(options);
  const explicit = env.OPENCODE_CONFIG?.trim();
  if (explicit) return [explicit];
  const xdg = xdgConfigDir(env, home);
  return [
    join(xdg, "opencode", "opencode.json"),
    join(xdg, "opencode", "opencode.jsonc"),
  ];
}

/** Product directories that hold a VS Code-family user `mcp.json`. Stable is first. */
const VSCODE_USER_PRODUCTS = ["Code", "Code - Insiders", "VSCodium"] as const;

/**
 * Editors that can host the Roo Code extension.
 * Cursor is included because Roo's globalStorage follows the editor, not `~/.cursor/mcp.json`.
 * Windsurf is not in this list.
 */
const ROO_EDITOR_PRODUCTS = ["Code", "Code - Insiders", "VSCodium", "Cursor"] as const;

const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";

/** Current global file, then the legacy name still present on unmigrated installs. */
const ROO_SETTINGS_FILES = ["mcp_settings.json", "cline_mcp_settings.json"] as const;

function productDataDirs(
  products: readonly string[],
  options: LocateOptions = {},
): string[] {
  const { platform: p, home, env } = locate(options);
  if (p === "darwin") {
    const base = join(home, "Library", "Application Support");
    return products.map((product) => join(base, product));
  }
  if (p === "win32") {
    const base = windowsRoaming(env, home);
    return products.map((product) => join(base, product));
  }
  const base = xdgConfigDir(env, home);
  return products.map((product) => join(base, product));
}

/**
 * VS Code user MCP configs opened by "MCP: Open User Configuration".
 * Stable, Insiders, and VSCodium each have their own product directory.
 * The stable path is first.
 */
function vscodeUserMcpPaths(options: LocateOptions = {}): string[] {
  return productDataDirs(VSCODE_USER_PRODUCTS, options).map((dir) =>
    join(dir, "User", "mcp.json"),
  );
}

/** Stable VS Code user `mcp.json`. Insiders and VSCodium are separate paths. */
function vscodeUserMcpPath(options: LocateOptions = {}): string {
  return vscodeUserMcpPaths(options)[0] ?? "";
}

/**
 * Roo Code user MCP configs.
 * Each host editor stores `mcp_settings.json` under
 * `User/globalStorage/rooveterinaryinc.roo-cline/settings/`.
 * `cline_mcp_settings.json` is the legacy name in that same directory.
 * There is no `~/.roo/mcp.json`. Windsurf globalStorage and
 * `~/.vscode-server` are not included.
 */
function rooUserPaths(options: LocateOptions = {}): string[] {
  const paths: string[] = [];
  for (const dir of productDataDirs(ROO_EDITOR_PRODUCTS, options)) {
    const settings = join(
      dir,
      "User",
      "globalStorage",
      ROO_EXTENSION_ID,
      "settings",
    );
    for (const file of ROO_SETTINGS_FILES) paths.push(join(settings, file));
  }
  return paths;
}

/** Copilot portable user config. `COPILOT_HOME` replaces `~/.copilot`. */
function copilotUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const copilotHome = env.COPILOT_HOME?.trim();
  if (copilotHome) return join(copilotHome, "mcp-config.json");
  return join(home, ".copilot", "mcp-config.json");
}

/**
 * Codex user config. `CODEX_HOME` replaces `~/.codex` when it is non-empty.
 * A blank value keeps the default. Project `.codex/config.toml` is separate.
 */
function codexUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(codexHome, "config.toml");
  return join(home, ".codex", "config.toml");
}

/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set. */
function claudeCodeUserPath(options: LocateOptions = {}): string {
  const { platform: p, home, env } = locate(options);
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return join(configDir, ".claude.json");
  const userProfile = p === "win32" ? env.USERPROFILE?.trim() : undefined;
  return join(userProfile || home, ".claude.json");
}

/**
 * Cline reads one user file.
 * `CLINE_MCP_SETTINGS_PATH` replaces it.
 * Otherwise `CLINE_DATA_DIR` replaces `~/.cline/data`.
 */
function clineUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const explicit = env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  const dataDir = env.CLINE_DATA_DIR?.trim();
  if (dataDir) return join(dataDir, "settings", "cline_mcp_settings.json");
  return join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
}

function continueBlockFiles(root: string): string[] {
  const dir = join(root, ".continue", "mcpServers");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!CONTINUE_BLOCK.test(name)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    files.push(full);
  }
  return files;
}

function pathSegments(file: string): string[] {
  return file.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
}

function samePathSegment(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * VS Code project `.vscode/mcp.json`, and the user `mcp.json` from
 * "MCP: Open User Configuration" for stable, Insiders, and VSCodium.
 */
export function isVsCodeConfigFile(
  file: string,
  options: LocateOptions = {},
): boolean {
  const parts = pathSegments(file);
  const name = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  const osPlatform = options.platform ?? platform();
  if (
    name &&
    parent &&
    samePathSegment(name, "mcp.json", osPlatform) &&
    samePathSegment(parent, ".vscode", osPlatform)
  ) {
    return true;
  }
  const wanted = configPathIdentity(file);
  return vscodeUserMcpPaths(options).some(
    (entry) => configPathIdentity(entry) === wanted,
  );
}

/** Copilot user `mcp-config.json`, not the project `.github/mcp.json`. */
export function isCopilotUserConfigFile(
  file: string,
  options: LocateOptions = {},
): boolean {
  return configPathIdentity(file) === configPathIdentity(copilotUserPath(options));
}

/** Stable identity for labeling a config file as project or user. */
function configPathIdentity(input: string): string {
  let normalized = resolve(input);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  try {
    if (existsSync(normalized)) {
      normalized = realpathSync(normalized);
      if (process.platform === "win32") normalized = normalized.toLowerCase();
    }
  } catch {
    // Keep the resolved path when the file cannot be canonicalized.
  }
  return normalized.replace(/\\/g, "/");
}

/**
 * `user` when `file` is one of the user-level configs (`~/.cursor/mcp.json`,
 * `~/.claude.json`, and the rest). Every other config file is `project`.
 */
export function configFileScope(
  file: string,
  options: LocateOptions = {},
): ConfigScope {
  const wanted = configPathIdentity(file);
  for (const entry of userLevelPaths(options)) {
    if (configPathIdentity(entry) === wanted) return "user";
  }
  return "project";
}

function userLevelPaths(options: LocateOptions = {}): string[] {
  const { home } = locate(options);
  return [
    join(home, ".cursor", "mcp.json"),
    ...vscodeUserMcpPaths(options),
    copilotUserPath(options),
    join(home, ".claude", "settings.json"),
    claudeCodeUserPath(options),
    ...claudeDesktopPaths(options),
    geminiUserPath(options),
    antigravityUserPath(options),
    kiroUserPath(options),
    ...amazonQUserPaths(options),
    ...ampUserPaths(options),
    gooseUserPath(options),
    ...opencodeUserPaths(options),
    ...windsurfUserPaths(options),
    ...zedUserPaths(options),
    codexUserPath(options),
    join(home, ".continue", "config.yaml"),
    join(home, ".junie", "mcp", "mcp.json"),
    clineUserPath(options),
    ...rooUserPaths(options),
  ];
}

function pathIdentity(file: string): string {
  const normalized = resolve(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function skippedDirName(name: string): boolean {
  if ((SKIP_DIR_NAMES as readonly string[]).includes(name)) return true;
  if (process.platform !== "win32") return false;
  const lower = name.toLowerCase();
  return SKIP_DIR_NAMES.some((skip) => skip.toLowerCase() === lower);
}

/** True when `candidate` is `root` or a path inside it. Both are real paths. */
function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rememberConfig(found: Map<string, string>, full: string): void {
  if (!existsSync(full)) return;
  let key: string;
  try {
    key = pathIdentity(realpathSync(full));
  } catch {
    key = pathIdentity(full);
  }
  if (!found.has(key)) found.set(key, full);
}

function collectProjectConfigs(dir: string, found: Map<string, string>): void {
  for (const rel of PROJECT_CANDIDATES) {
    rememberConfig(found, join(dir, rel));
  }
  for (const full of continueBlockFiles(dir)) {
    rememberConfig(found, full);
  }
}

/**
 * Visit subdirectories of `scanRoot` and call `visit` on each one.
 * The scan root itself is not visited here.
 * A symlink whose real path is outside the scan root is not entered.
 * A symlink that points at a directory already visited is not entered again.
 */
function walkProjectDirs(scanRoot: string, visit: (dir: string) => void): void {
  let rootReal: string;
  try {
    rootReal = realpathSync(scanRoot);
  } catch {
    return;
  }
  const seen = new Set<string>([pathIdentity(rootReal)]);

  const descend = (dir: string, depth: number): void => {
    if (depth > MAX_RECURSIVE_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skippedDirName(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathSync(full);
        } catch {
          continue;
        }
        if (!isInsideRoot(rootReal, resolved)) continue;
        let linked;
        try {
          linked = statSync(resolved);
        } catch {
          continue;
        }
        if (!linked.isDirectory()) continue;
        const id = pathIdentity(resolved);
        if (seen.has(id)) continue;
        seen.add(id);
        visit(full);
        descend(full, depth + 1);
        continue;
      }
      if (!entry.isDirectory()) continue;
      let id = pathIdentity(full);
      try {
        id = pathIdentity(realpathSync(full));
      } catch {
        // Keep the path we have when the directory cannot be canonicalized.
      }
      if (seen.has(id)) continue;
      seen.add(id);
      visit(full);
      descend(full, depth + 1);
    }
  };

  descend(scanRoot, 1);
}

export function discoverConfigPaths(
  root: string,
  options: { includeUserConfig?: boolean; recursive?: boolean } & LocateOptions = {},
): string[] {
  const absRoot = resolve(root);
  const found = new Map<string, string>();

  collectProjectConfigs(absRoot, found);
  if (options.recursive) {
    walkProjectDirs(absRoot, (dir) => collectProjectConfigs(dir, found));
  }

  // User configs are read once for the whole scan, not once per subdirectory.
  if (options.includeUserConfig !== false) {
    for (const full of userLevelPaths(options)) {
      rememberConfig(found, full);
    }
  }

  return [...found.values()].sort();
}

export const __testing = {
  claudeDesktopPaths,
  claudeCodeUserPath,
  clineUserPath,
  geminiUserPath,
  antigravityUserPath,
  kiroUserPath,
  amazonQUserPaths,
  ampUserPaths,
  gooseUserPath,
  opencodeUserPaths,
  vscodeUserMcpPath,
  vscodeUserMcpPaths,
  rooUserPaths,
  copilotUserPath,
  codexUserPath,
  userLevelPaths,
  PROJECT_CANDIDATES,
  SKIP_DIR_NAMES,
  MAX_RECURSIVE_DEPTH,
};
