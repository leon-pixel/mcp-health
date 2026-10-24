import type { ConfigFile, Finding, ParsedServer, Severity } from "./types.js";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  isCopilotUserConfigFile,
  isVsCodeConfigFile,
  type LocateOptions,
} from "./discover.js";
import { isFloatingPin, splitPackageSpec } from "./npm.js";
import { CLAUDE_SETTINGS_MCP_SERVERS } from "./parse.js";
import { isBareEnvToken, lookupEnv } from "./vars.js";

const UNRESOLVED_VAR = /\$\{[^{}]+\}/g;

const HTTP_URL_PROTOCOLS = new Set(["http:", "https:"]);
const SOCKET_URL_PROTOCOLS = new Set(["ws:", "wss:", "unix:", "pipe:"]);

/** Remote HTTP, Claude Code WebSocket, and VS Code unix/pipe socket URLs. */
export function isAllowedMcpUrlProtocol(protocol: string): boolean {
  return HTTP_URL_PROTOCOLS.has(protocol) || SOCKET_URL_PROTOCOLS.has(protocol);
}

/** `ws:`, `wss:`, `unix:`, and `pipe:` are real MCP URLs the HTTP probe cannot speak. */
export function isSocketMcpUrl(url: string): boolean {
  try {
    return SOCKET_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function pathExtensions(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  return ["", ...exts];
}

function hasPathExtension(command: string, extensions: string[]): boolean {
  const lower = command.toLowerCase();
  return extensions.some(
    (ext) => ext.length > 0 && lower.endsWith(ext.toLowerCase()),
  );
}

function isRunnable(file: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(file)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `.cmd` and `.bat` files do not start via spawn() unless `shell` is set.
 * `.exe` does not need a shell.
 */
export function commandNeedsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

function findInDir(
  dir: string,
  names: string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const name of names) {
    const full = join(dir, name);
    if (isRunnable(full, platform)) return full;
  }
  return undefined;
}

/**
 * Resolve a command the way the host shell would.
 * On Windows, `npx` is `npx.cmd` / `npx.exe` and is found via PATHEXT.
 * A relative command is resolved from `cwd` (the scan root, or a
 * client `cwd` when that client uses one).
 * On Windows that directory is searched before PATH.
 * An empty PATH entry means that directory on every platform.
 * Returns an absolute path when the command is found.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): string | undefined {
  const base = cwd && cwd.trim() ? resolve(cwd) : process.cwd();
  const extensions = pathExtensions(env, platform);
  const names =
    platform === "win32" && !hasPathExtension(command, extensions)
      ? extensions.map((ext) => `${command}${ext}`)
      : [command];

  const direct =
    isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (direct) {
    for (const name of names) {
      const candidate = isAbsolute(name) ? name : join(base, name);
      if (isRunnable(candidate, platform)) return candidate;
    }
    return undefined;
  }

  if (platform === "win32") {
    const fromCwd = findInDir(base, names, platform);
    if (fromCwd) return fromCwd;
  }

  if (env.PATH === undefined) return undefined;
  for (const dir of env.PATH.split(pathDelimiter(platform))) {
    const fromDir = dir
      ? findInDir(dir, names, platform)
      : findInDir(base, names, platform);
    if (fromDir) return fromDir;
  }
  return undefined;
}

/** Where a config lives, so PATH lookup can follow that client's spawn rule. */
export type CommandPathContext = LocateOptions & {
  file?: string;
};

function serverPathValue(
  serverEnv: Record<string, unknown>,
  platform: NodeJS.Platform,
): unknown {
  if (platform === "win32") {
    let found: unknown;
    for (const [key, value] of Object.entries(serverEnv)) {
      if (key.toLowerCase() === "path") found = value;
    }
    return found;
  }
  return serverEnv.PATH;
}

function inheritedPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "win32") {
    if (typeof env.PATH === "string") return env.PATH;
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === "path" && typeof value === "string") return value;
    }
    return undefined;
  }
  return env.PATH;
}

/**
 * PATH used to resolve a stdio command and to spawn `--probe`.
 * Other clients replace the process PATH with the server's `env.PATH`.
 * VS Code appends it: `extHostMcpNode` uses `existing + delimiter + value`
 * for `.vscode/mcp.json` and the VS Code user `mcp.json`.
 * A value that still contains `${…}` is not a directory list, so lookup
 * keeps the process PATH. On Windows, `Path` is the same variable.
 */
export function commandLookupEnv(
  serverEnv: unknown,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  context?: CommandPathContext,
): NodeJS.ProcessEnv {
  if (!serverEnv || typeof serverEnv !== "object" || Array.isArray(serverEnv)) {
    return baseEnv;
  }
  const pathValue = serverPathValue(serverEnv as Record<string, unknown>, platform);
  if (typeof pathValue !== "string") return baseEnv;
  if (unresolvedTokens(pathValue).length > 0) return baseEnv;
  const append = Boolean(
    context?.file &&
      isVsCodeConfigFile(context.file, {
        platform: context.platform ?? platform,
        home: context.home,
        env: context.env,
      }),
  );
  if (!append) return { ...baseEnv, PATH: pathValue };
  const current = inheritedPath(baseEnv, platform);
  const merged = current
    ? `${current}${pathDelimiter(platform)}${pathValue}`
    : pathValue;
  return { ...baseEnv, PATH: merged };
}

function commandOnPath(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return resolveCommandOnPath(command, env, process.platform, cwd) !== undefined;
}

function unresolvedTokens(value: string): string[] {
  return value.match(UNRESOLVED_VAR) ?? [];
}

function originalHttpUrl(server: ParsedServer): string {
  if (typeof server.raw.url === "string") return server.raw.url;
  if (typeof server.raw.serverUrl === "string") return server.raw.serverUrl;
  return server.transport.kind === "http" ? server.transport.url : "";
}

/** Cursor `disabled: true`, or Codex/Zed `enabled: false`. */
export function isServerDisabled(server: ParsedServer): boolean {
  return server.raw.disabled === true || server.raw.enabled === false;
}

/**
 * Zed extension context servers have `source: "extension"`, or the untagged
 * settings shape (a `settings` object and no command or URL). The extension
 * launches the process. A custom server with only `env` is not this.
 */
export function isExtensionProvided(server: ParsedServer): boolean {
  if (server.raw.source === "extension") return true;
  if (server.raw.source === "custom") return false;
  const settings = server.raw.settings;
  const settingsObject =
    settings !== null && typeof settings === "object" && !Array.isArray(settings);
  return settingsObject && server.transport.kind === "unknown";
}

function collectUnresolved(server: ParsedServer, includeCwd = false): string[] {
  const hits: string[] = [];
  const add = (where: string, value: string) => {
    for (const token of unresolvedTokens(value)) {
      hits.push(`${token} in ${where}`);
    }
  };

  if (server.transport.kind === "stdio") {
    add("command", server.transport.command);
    server.transport.args.forEach((arg, index) => add(`args[${index}]`, arg));
  } else if (server.transport.kind === "http") {
    add("url", server.transport.url);
  }

  const env = server.raw.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") add(`env.${key}`, value);
    }
  }

  const headers = server.raw.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") add(`headers.${key}`, value);
    }
  }

  if (typeof server.raw.envFile === "string") add("envFile", server.raw.envFile);
  if (includeCwd && typeof server.raw.cwd === "string") add("cwd", server.raw.cwd);
  return hits;
}

export function serverHasUnresolved(server: ParsedServer): boolean {
  return collectUnresolved(server).length > 0;
}

/**
 * `${input:…}`, `${env:…}`, and Claude `${VAR}` / `${VAR:-default}` are
 * references. `${foo.bar}` is not.
 */
function softUnresolved(token: string): boolean {
  return (
    /^\$\{input:/i.test(token) ||
    /^\$\{env:/i.test(token) ||
    isBareEnvToken(token)
  );
}

function unresolvedVariableFinding(
  server: ParsedServer,
  file: string,
  strict: boolean,
  includeCwd = false,
): Finding | undefined {
  const hits = collectUnresolved(server, includeCwd);
  if (hits.length === 0) return undefined;
  const hard = hits.some((hit) => !softUnresolved(hit.slice(0, hit.indexOf(" in "))));
  const severity: Severity = hard || strict ? "fail" : "warn";
  const note = strict
    ? " --strict-variables is set"
    : " ${input:…}, unset ${env:…}, and unset ${VAR} are warnings; other ${…} tokens fail";
  return {
    severity,
    code: "UNRESOLVED_VARIABLE",
    message: `Unresolved config variable ${hits.join("; ")}.${note}`,
    server: server.name,
    file,
  };
}

/**
 * True when the package spec names one version or range.
 * `name@latest`, `name@next`, and `name@*` float, so they are not pins.
 */
export function isVersionPinned(pkg: string): boolean {
  const { version } = splitPackageSpec(pkg);
  if (!version) return false;
  return !isFloatingPin(version);
}

/** `npx`, `npx.cmd`, and `C:\\path\\npx.exe` all share one launcher name. */
function commandBasename(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command;
  return base.replace(/\.(cmd|exe)$/i, "");
}

const PACKAGE_RUNNERS = new Set(["npx", "npm", "uvx", "bunx", "pnpm", "yarn"]);

/**
 * Flags whose next argument is not the package.
 * `uvx -p` is a Python version. `npx -p` is the package, so it is not listed here.
 */
const NON_PACKAGE_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  uvx: new Set([
    "--with",
    "--with-editable",
    "--with-requirements",
    "--python",
    "-p",
    "--index",
    "--default-index",
    "--index-url",
    "--extra-index-url",
    "--find-links",
    "--config-file",
    "--python-preference",
    "--keyring-provider",
    "--index-strategy",
    "--prerelease",
  ]),
  pnpm: new Set(["--config", "--reporter", "--dir", "-C"]),
};

function explicitFromPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--from") {
      const next = args[i + 1];
      if (next && next !== "--" && !next.startsWith("-")) return next;
      continue;
    }
    if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (value) return value;
    }
  }
  return undefined;
}

function firstPackageArg(args: string[], launcher: string): string | undefined {
  const skipValue = NON_PACKAGE_VALUE_FLAGS[launcher];
  const skipSubcommand = launcher === "pnpm" || launcher === "yarn";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" || arg === "--from") continue;
    if (arg.startsWith("--from=")) continue;
    if (skipValue?.has(arg)) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (skipSubcommand && (arg === "dlx" || arg === "exec")) continue;
    return arg;
  }
  return undefined;
}

/**
 * Package spec launched by npx, npm exec, uvx, bunx, pnpm dlx, pnpm exec, or yarn dlx.
 * `--from <spec>` wins. Flags (`-y`, `--yes`, `--quiet`) and the `dlx` / `exec`
 * subcommands are not the package.
 */
export function extractNpxPackage(command: string, args: string[]): string | undefined {
  const base = commandBasename(command);
  if (!PACKAGE_RUNNERS.has(base)) return undefined;

  let rest = args;
  if (base === "npm") {
    const execIdx = rest.indexOf("exec");
    if (execIdx === -1) return undefined;
    rest = rest.slice(execIdx + 1);
  } else if (base === "pnpm") {
    const idx = rest.findIndex((arg) => arg === "dlx" || arg === "exec");
    if (idx === -1) return undefined;
    rest = rest.slice(idx + 1);
  } else if (base === "yarn") {
    const idx = rest.indexOf("dlx");
    if (idx === -1) return undefined;
    rest = rest.slice(idx + 1);
  }

  return explicitFromPackage(rest) ?? firstPackageArg(rest, base);
}

const INTERPRETERS = new Set(["node", "python", "python3", "bun", "deno", "tsx"]);

/**
 * Node flags whose next argument is not the script.
 * `--require ./preload.cjs server.mjs` still checks `server.mjs`.
 */
const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--experimental-default-type",
  "--conditions",
  "-C",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--env-file",
  "--env-file-if-exists",
  "--cpu-prof-dir",
  "--heap-prof-dir",
  "--diagnostic-dir",
  "--report-dir",
  "--report-filename",
  "--experimental-policy",
  "--title",
  "--openssl-config",
  "--redirect-warnings",
  "--trace-event-file-pattern",
  "--watch-path",
  "--test-reporter",
  "--test-reporter-destination",
]);

const NODE_NO_SCRIPT = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-v",
  "--version",
  "-h",
  "--help",
]);

const PYTHON_VALUE_FLAGS = new Set(["-W", "-X", "--check-hash-based-pycs"]);

const PYTHON_NO_SCRIPT = new Set(["-h", "--help", "-V", "--version", "-"]);

const SCRIPT_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|pyw)$/i;

function looksLikeScriptPath(arg: string): boolean {
  if (
    arg === "." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith(".\\") ||
    arg.startsWith("..\\")
  ) {
    return true;
  }
  if (arg.includes("/") || arg.includes("\\")) return true;
  return SCRIPT_EXT.test(arg);
}

/**
 * First positional argument, or undefined when a flag means there is no script file.
 * `--` ends flag parsing. `--flag=value` does not consume the next argument.
 */
function firstPositional(
  args: string[],
  valueFlags: ReadonlySet<string>,
  stop: ReadonlySet<string>,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      const next = args[i + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (stop.has(arg)) return undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const name = arg.slice(0, arg.indexOf("="));
      if (stop.has(name)) return undefined;
      continue;
    }
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

function pythonHasNoScript(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "-m" || arg === "--module" || arg.startsWith("--module=")) return true;
    if (arg === "-c" || (arg.startsWith("-c") && !arg.startsWith("--"))) return true;
    if (arg.startsWith("-m") && !arg.startsWith("--")) return true;
  }
  return false;
}

function denoScriptArg(args: string[]): string | undefined {
  const valueFlags = new Set([
    "--config",
    "-c",
    "--import-map",
    "--lock",
    "--cert",
    "--env-file",
    "--preload",
  ]);
  const noFile = new Set([
    "eval",
    "repl",
    "task",
    "upgrade",
    "completions",
    "help",
    "doc",
    "lint",
    "fmt",
    "install",
    "uninstall",
    "cache",
    "compile",
    "info",
    "test",
    "bench",
  ]);
  const fileSub = new Set(["run", "serve", "check"]);
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      const next = args[i + 1];
      return next;
    }
    if (!arg.startsWith("-")) break;
    if (valueFlags.has(arg)) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) i += 1;
    }
  }
  const sub = args[i];
  if (!sub) return undefined;
  if (noFile.has(sub)) return undefined;
  if (fileSub.has(sub)) {
    return firstPositional(args.slice(i + 1), valueFlags, new Set(["-h", "--help", "--version"]));
  }
  return looksLikeScriptPath(sub) ? sub : undefined;
}

function bunScriptArg(args: string[]): string | undefined {
  if (
    args.includes("-e") ||
    args.includes("--eval") ||
    args.some((arg) => arg.startsWith("--eval="))
  ) {
    return undefined;
  }
  if (
    args.length > 0 &&
    args.every((arg) => arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h")
  ) {
    return undefined;
  }
  const valueFlags = new Set([
    "--cwd",
    "--config",
    "--preload",
    "--port",
    "--origin",
    "--define",
    "--target",
    "--outdir",
    "--outfile",
    "--external",
    "--filter",
    "--env-file",
    "--bunfile",
  ]);
  const notAFile = new Set([
    "x",
    "install",
    "add",
    "remove",
    "test",
    "create",
    "init",
    "update",
    "upgrade",
    "pm",
    "link",
    "unlink",
    "outdated",
    "why",
    "exec",
    "repl",
    "build",
  ]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      const next = args[i + 1];
      if (next) positional.push(next);
      break;
    }
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  const first = positional[0];
  if (!first) return undefined;
  if (notAFile.has(first)) return undefined;
  if (first === "run") {
    const script = positional[1];
    if (!script || !looksLikeScriptPath(script)) return undefined;
    return script;
  }
  return looksLikeScriptPath(first) ? first : undefined;
}

/**
 * Script path a stdio interpreter will open, when that argument is a file.
 * `node -e`, `node --version`, `python -m`, and package-runner args return
 * undefined. `.exe` and `.cmd` names use the same interpreter.
 */
export function interpreterScriptArg(
  command: string,
  args: string[],
): string | undefined {
  const base = commandBasename(command).toLowerCase();
  if (!INTERPRETERS.has(base)) return undefined;
  if (base === "python" || base === "python3") {
    if (pythonHasNoScript(args)) return undefined;
    return firstPositional(args, PYTHON_VALUE_FLAGS, PYTHON_NO_SCRIPT);
  }
  if (base === "deno") return denoScriptArg(args);
  if (base === "bun") return bunScriptArg(args);
  const rest = base === "tsx" && args[0] === "watch" ? args.slice(1) : args;
  return firstPositional(rest, NODE_VALUE_FLAGS, NODE_NO_SCRIPT);
}

/**
 * VS Code, Copilot's user file, Gemini CLI, and Codex start stdio in `cwd`.
 * Copilot's project file and every other client do not.
 */
function honorsConfiguredCwd(
  file: Pick<ConfigFile, "path" | "format">,
  options: LocateOptions = {},
): boolean {
  if (file.format === "codex") return true;
  if (isVsCodeConfigFile(file.path, options)) return true;
  if (isGeminiSettings(file.path)) return true;
  if (isCopilotUserConfigFile(file.path, options)) return true;
  return false;
}

/**
 * Directory for relative command lookup and for the `--probe` spawn.
 * An omitted `cwd`, or one that still contains `${…}`, stays the scan root.
 * A relative `cwd` is resolved from that root. The config file is not rewritten.
 */
export function stdioWorkingDirectory(
  server: ParsedServer,
  file: Pick<ConfigFile, "path" | "format">,
  options: {
    cwd?: string;
    platform?: NodeJS.Platform;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const base = options.cwd && options.cwd.trim() ? resolve(options.cwd) : process.cwd();
  if (server.transport.kind !== "stdio") return base;
  if (!honorsConfiguredCwd(file, options)) return base;
  const configured = server.raw.cwd;
  if (typeof configured !== "string") return base;
  const value = configured.trim();
  if (!value || unresolvedTokens(value).length > 0) return base;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

/**
 * A relative interpreter script that is not a file in the working directory.
 * Absolute paths are checked too. The file is not read.
 */
function missingScriptFinding(
  command: string,
  args: string[],
  workDir: string,
  server: string,
  file: string,
): Finding | undefined {
  if (unresolvedTokens(command).length > 0) return undefined;
  const script = interpreterScriptArg(command, args);
  if (!script || unresolvedTokens(script).length > 0) return undefined;
  const candidate = isAbsolute(script) ? script : resolve(workDir, script);
  if (isExistingFile(candidate)) return undefined;
  return {
    severity: "fail",
    code: "SCRIPT_NOT_FOUND",
    message: `Script not found: ${script}`,
    server,
    file,
  };
}

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function checkConfig(
  file: ConfigFile,
  options: {
    strictVariables?: boolean;
    cwd?: string;
    platform?: NodeJS.Platform;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): {
  findings: Finding[];
  perServer: Map<string, { status: Severity; findings: Finding[] }>;
} {
  const findings: Finding[] = [];
  const perServer = new Map<
    string,
    { status: Severity; findings: Finding[] }
  >();

  if (file.format === "invalid") {
    if (file.error === CLAUDE_SETTINGS_MCP_SERVERS) {
      findings.push({
        severity: "fail",
        code: "MCP_SERVERS_IGNORED",
        message: claudeSettingsIgnoredMessage(file.path),
        file: file.path,
      });
      return { findings, perServer };
    }
    findings.push({
      severity: "fail",
      code: "SCHEMA_ERROR",
      message: file.error ?? "MCP config failed schema validation",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.format === "unknown") {
    findings.push({
      severity: "fail",
      code: "UNKNOWN_FORMAT",
      message:
        "Config is not a JSON object with mcpServers/servers (or was invalid shape)",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.format === "none") {
    findings.push({
      severity: "warn",
      code: "NO_MCP_SECTION",
      message: "JSON has no mcpServers or servers key",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.servers.length === 0) {
    findings.push({
      severity: "warn",
      code: "EMPTY_SERVERS",
      message: "Config contains an empty server map",
      file: file.path,
    });
  }

  for (const server of file.servers) {
    const local: Finding[] = [];
    let status: Severity = "ok";

    if (isServerDisabled(server)) {
      local.push({
        severity: "ok",
        code: "DISABLED",
        message: "Disabled in config; not checked",
        server: server.name,
        file: file.path,
      });
      findings.push(...local);
      perServer.set(server.name, { status: "ok", findings: local });
      continue;
    }

    if (isExtensionProvided(server)) {
      local.push({
        severity: "ok",
        code: "EXTENSION_SERVER",
        message: "Extension-provided server; the extension launches it",
        server: server.name,
        file: file.path,
      });
      findings.push(...local);
      perServer.set(server.name, { status: "ok", findings: local });
      continue;
    }

    if (
      isClaudeCodeEntryFile(file.path) &&
      claudeEntryType(server.raw.type) === "sdk"
    ) {
      local.push({
        severity: "ok",
        code: "SDK_SERVER",
        message: 'Claude Code skips type "sdk"; only an SDK host starts it',
        server: server.name,
        file: file.path,
      });
      findings.push(...local);
      perServer.set(server.name, { status: "ok", findings: local });
      continue;
    }

    if (!server.name.trim()) {
      local.push({
        severity: "fail",
        code: "EMPTY_NAME",
        message: "Server name is empty",
        server: server.name,
        file: file.path,
      });
    }

    const useCwd =
      server.transport.kind === "stdio" && honorsConfiguredCwd(file, options);
    const unresolved = unresolvedVariableFinding(
      server,
      file.path,
      Boolean(options.strictVariables),
      useCwd,
    );
    if (unresolved) local.push(unresolved);

    if (server.transport.kind === "unknown") {
      local.push({
        severity: "fail",
        code: "NO_TRANSPORT",
        message: "Server has neither command nor url",
        server: server.name,
        file: file.path,
      });
    }

    if (server.transport.kind === "http") {
      // A leftover ${…} is the finding. The URL is not known yet.
      if (unresolvedTokens(server.transport.url).length === 0) {
        try {
          const u = new URL(server.transport.url);
          if (!isAllowedMcpUrlProtocol(u.protocol)) {
            local.push({
              severity: "fail",
              code: "BAD_URL_PROTOCOL",
              message: `URL protocol ${u.protocol} is not supported (use http, https, ws, wss, unix, or pipe)`,
              server: server.name,
              file: file.path,
            });
          }
        } catch {
          const original = originalHttpUrl(server);
          local.push({
            severity: "fail",
            code: "BAD_URL",
            message:
              original !== server.transport.url
                ? "Invalid URL after expanding config variables"
                : `Invalid URL: ${server.transport.url}`,
            server: server.name,
            file: file.path,
          });
        }
      }
    }

    if (server.transport.kind === "stdio") {
      const { command, args } = server.transport;
      const commandUnresolved = unresolvedTokens(command).length > 0;
      const workDir = stdioWorkingDirectory(server, file, options);

      if (
        !commandUnresolved &&
        !commandOnPath(
          command,
          workDir,
          commandLookupEnv(server.raw.env, process.env, process.platform, {
            file: file.path,
            platform: options.platform,
            home: options.home,
            env: options.env,
          }),
        )
      ) {
        local.push({
          severity: "fail",
          code: "COMMAND_NOT_FOUND",
          message: `Command not found on PATH: ${command}`,
          server: server.name,
          file: file.path,
        });
      }

      const missingScript = missingScriptFinding(
        command,
        args,
        workDir,
        server.name,
        file.path,
      );
      if (missingScript) local.push(missingScript);

      const base = commandBasename(command);
      if (!commandUnresolved && PACKAGE_RUNNERS.has(base)) {
        const pkg = extractNpxPackage(command, args);
        if (!pkg) {
          // pnpm/yarn without dlx or exec are not package launches.
          if (base === "npx" || base === "npm") {
            local.push({
              severity: "warn",
              code: "NPX_NO_PACKAGE",
              message: "npx/npm exec invoked without a clear package argument",
              server: server.name,
              file: file.path,
            });
          }
        } else if (!isVersionPinned(pkg)) {
          local.push({
            severity: "warn",
            code: "UNPINNED_PACKAGE",
            message: `Package "${pkg}" is not version-pinned (recommend name@version)`,
            server: server.name,
            file: file.path,
          });
        }
      }

      if (args.some((a) => a.includes("YOUR_") || a.includes("REPLACE_"))) {
        local.push({
          severity: "warn",
          code: "PLACEHOLDER_ARG",
          message: "Args look like unresolved placeholders",
          server: server.name,
          file: file.path,
        });
      }
    }

    if (
      isClaudeCodeEntryFile(file.path) &&
      server.transport.kind === "http" &&
      claudeEntryType(server.raw.type) === ""
    ) {
      local.push({
        severity: "fail",
        code: "MISSING_TRANSPORT_TYPE",
        message:
          'Claude Code skips a url entry with no type. Add "type": "http", "sse", or "ws".',
        server: server.name,
        file: file.path,
      });
    }

    const env = server.raw.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const unsetRefs: string[] = [];
      const gemini = isGeminiSettings(file.path);
      const platform = options.platform ?? process.platform;
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue;
        if (isPlaceholder(value)) {
          local.push({
            severity: "warn",
            code: "PLACEHOLDER_ENV",
            message: `Env ${key} looks unset or placeholder`,
            server: server.name,
            file: file.path,
          });
        }
        if (!gemini) continue;
        for (const ref of unsetGeminiEnvRefs(value, process.env, platform)) {
          const label = `${ref} in env.${key}`;
          if (!unsetRefs.includes(label)) unsetRefs.push(label);
        }
      }
      if (unsetRefs.length > 0) {
        const strict = Boolean(options.strictVariables);
        local.push({
          severity: strict ? "fail" : "warn",
          code: "UNRESOLVED_VARIABLE",
          message: `Unset Gemini env reference ${unsetRefs.join("; ")}. Gemini CLI substitutes an empty string.${
            strict ? " --strict-variables is set" : ""
          }`,
          server: server.name,
          file: file.path,
        });
      }
    }

    warnPlaceholderFields(server, file.path, local, "headers", "Header");
    warnPlaceholderFields(server, file.path, local, "auth", "Auth");

    const bearer = server.raw.bearerTokenEnvVar;
    const authEnvNames: string[] = [];
    if (typeof bearer === "string" && bearer.trim()) authEnvNames.push(bearer.trim());
    const envHeaders = server.raw.envHttpHeaders;
    if (envHeaders && typeof envHeaders === "object" && !Array.isArray(envHeaders)) {
      for (const envName of Object.values(envHeaders)) {
        if (typeof envName === "string" && envName.trim()) authEnvNames.push(envName.trim());
      }
    }
    for (const envName of authEnvNames) {
      if (lookupEnv(envName, process.env, process.platform) === undefined) {
        local.push({
          severity: "warn",
          code: "AUTH_ENV_UNSET",
          message: `Auth env ${envName} is not set`,
          server: server.name,
          file: file.path,
        });
      }
    }

    const envFile = missingEnvFileFinding(server, file, options.cwd);
    if (envFile) local.push(envFile);

    for (const f of local) {
      status = worst(status, f.severity);
    }

    if (local.length === 0) {
      local.push({
        severity: "ok",
        code: "HEALTHY",
        message: "No issues detected",
        server: server.name,
        file: file.path,
      });
    }

    findings.push(...local);
    perServer.set(server.name, { status, findings: local });
  }

  return { findings, perServer };
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Cursor stdio `envFile`, and the same field on a VS Code `servers` config.
 * Portable `.mcp.json` and Copilot `.github/mcp.json` do not read it.
 * The file is not opened.
 */
function readsEnvFile(file: string, format: ConfigFile["format"]): boolean {
  if (format === "servers") return true;
  const normalized = file.replace(/\\/g, "/");
  if (
    normalized === ".cursor/mcp.json" ||
    normalized.endsWith("/.cursor/mcp.json")
  ) {
    return true;
  }
  if (normalized !== "mcp.json" && !normalized.endsWith("/mcp.json")) return false;
  const ignored = new Set([
    ".junie",
    ".continue",
    ".github",
    ".vscode",
    ".gemini",
    ".windsurf",
    ".zed",
    ".codex",
    ".claude",
    ".cline",
  ]);
  return !normalized.split("/").some((part) => ignored.has(part));
}

function missingEnvFileFinding(
  server: ParsedServer,
  file: ConfigFile,
  cwd: string | undefined,
): Finding | undefined {
  if (!readsEnvFile(file.path, file.format)) return undefined;
  if (server.transport.kind !== "stdio") return undefined;
  const value = server.raw.envFile;
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (unresolvedTokens(value).length > 0) return undefined;
  const base = cwd && cwd.trim() ? resolve(cwd) : process.cwd();
  const resolved = isAbsolute(value) ? value : resolve(base, value);
  if (isExistingFile(resolved)) return undefined;
  return {
    severity: "warn",
    code: "ENV_FILE_MISSING",
    message: `envFile is not a file: ${value}`,
    server: server.name,
    file: file.path,
  };
}

/**
 * Claude Code does not read `mcpServers` from a settings file.
 * The basename keeps `settings.local.json` distinct from `settings.json`.
 */
export function claudeSettingsIgnoredMessage(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() || "settings.json";
  return `Claude Code does not load mcpServers from ${base}. Move project servers to .mcp.json and user servers to ~/.claude.json. This file is only for permissions and hooks.`;
}

/** `.mcp.json` and `~/.claude.json`, the files Claude Code reads as MCP JSON. */
function isClaudeCodeEntryFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".mcp.json" ||
    normalized.endsWith("/.mcp.json") ||
    normalized === ".claude.json" ||
    normalized.endsWith("/.claude.json")
  );
}

function isGeminiSettings(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".gemini/settings.json" ||
    normalized.endsWith("/.gemini/settings.json")
  );
}

function claudeEntryType(type: unknown): string {
  return typeof type === "string" ? type.trim().toLowerCase() : "";
}

/**
 * Doc placeholders copied from Cursor, Gemini CLI, Zed, and Claude Code.
 * `your-company` is a real prefix and is not a match.
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.includes("YOUR_") || trimmed.includes("REPLACE_")) return true;
  if (trimmed.toLowerCase() === "changeme") return true;
  const withoutBearer = trimmed.replace(/^bearer\s+/i, "").trim();
  if (withoutBearer !== trimmed) return isPlaceholder(withoutBearer);
  if (/^<[^<>\s]+>$/.test(trimmed)) return true;
  return /^your[-_](?:key|token|api[-_]token|secret|password|client[-_]secret|client[-_]id|oauth[-_]client[-_]id)(?:[-_]here)?$/i.test(
    trimmed,
  );
}

/**
 * Gemini CLI `$NAME` references in an env value, plus Windows `%NAME%`.
 * A set variable is omitted. The value is never returned.
 * `${...}` is left to the braced-variable check.
 */
export function unsetGeminiEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const refs: string[] = [];
  const add = (ref: string, name: string) => {
    if (refs.includes(ref)) return;
    const found = lookupEnv(name, env, platform);
    if (found === undefined) refs.push(ref);
  };
  for (const match of value.matchAll(/(?<!\{)\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (name) add(`$${name}`, name);
  }
  if (platform === "win32") {
    for (const match of value.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
      const name = match[1];
      if (name) add(`%${name}%`, name);
    }
  }
  return refs;
}

function warnPlaceholderFields(
  server: ParsedServer,
  file: string,
  local: Finding[],
  field: "headers" | "auth",
  label: "Header" | "Auth",
): void {
  const record = server.raw[field];
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || !isPlaceholder(value)) continue;
    local.push({
      severity: "warn",
      code: "PLACEHOLDER_HEADER",
      message: `${label} ${key} looks like a placeholder`,
      server: server.name,
      file,
    });
  }
}
