# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Claude Code does not load `mcpServers` from `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json`. A present key is `MCP_SERVERS_IGNORED` (a failure) instead of a healthy server. Project servers belong in `.mcp.json`. User servers belong in `~/.claude.json`. A settings file with no `mcpServers` key is still skipped. The entries are not probed. A config-level failure that is not a server row explains exit 2 in the summary (#85).
- VS Code (`.vscode/mcp.json` and the user `mcp.json`), Copilot user `mcp-config.json`, Gemini CLI, and Codex use stdio `cwd` for relative command lookup and for `--probe`. A relative `cwd` is resolved from the scan root. `${workspaceFolder}` and the other config variables are expanded first. An omitted `cwd` stays the scan root. A value that still contains `${…}` does not change the directory. Other clients ignore `cwd`. The config file is not rewritten (#86).
- A script argument for `node`, `python`, `python3`, `bun`, `deno`, or `tsx`, including the `.exe` and `.cmd` names, that is not a file in that directory is `SCRIPT_NOT_FOUND`. The file is not read. `node -e`, `node --version`, `python -m`, and package-runner arguments stay as they are. `bun run dev` is a package script. `bun run src/index.ts` is a file (#86).
- Codex user config follows `CODEX_HOME`. A non-empty value reads `$CODEX_HOME/config.toml`. An unset or blank value stays `~/.codex/config.toml`. `--no-user` skips that file either way. A missing file is skipped, not `FILE_NOT_FOUND`. Project `.codex/config.toml` is unchanged (#87).
- The GitHub Action appends `args` after `--no-user`. Setting `args` to `--probe` or `--online` no longer drops `--no-user`. `include-user: true` scans the runner's user-level configs. Workflows that set `args` in order to read those configs need `include-user: true`. Passing `--no-user` inside `args` still skips them. Annotations, SARIF, and `fail-on-missing` are unchanged (#89).

## [1.5.0] - 2026-10-22

### Added

- Discover GitHub Copilot's committed `.github/mcp.json` (#68). Project scans, including `--no-user`, read it. A missing file is skipped, not `FILE_NOT_FOUND`. A `mcpServers` object uses the existing parser. A bare top-level object is a server map: `command` and `args` are stdio, `url` is HTTP, `type: "local"` still uses `command` and `args`, and `tools` is an allowlist, not a transport.

### Fixed

- VS Code (`.vscode/mcp.json` and the user `mcp.json`) appends a stdio server's `env.PATH` after the process PATH, and `--probe` spawns with that appended PATH. Other clients still replace PATH (#81).
- `ws:`, `wss:`, `unix:`, and `pipe:` MCP URLs are not `BAD_URL_PROTOCOL`. A fragment subpath such as `unix:///tmp/server.sock#/mcp/subpath` is part of that URL. `ftp:` and `file:` still fail. A URL that still contains `${…}` is unchanged.
- `--probe` does not POST a `ws:`, `wss:`, `unix:`, or `pipe:` URL. Those are `PROBE_SKIPPED`. `http:` and `https:` probes are unchanged.
- A VS Code `servers` env value may be a number or null. A number is checked as its decimal string. Null omits the variable. A boolean or object is still `SCHEMA_ERROR`. Other clients still reject a non-string env value.
- Cursor and VS Code stdio `envFile` warns `ENV_FILE_MISSING` when the expanded path is not a file. The file is not read. `.mcp.json` and `.github/mcp.json` do not warn.
- Expand Claude Code `${VAR}` and `${VAR:-default}` in command, args, env, url, and headers, and expand `${CLAUDE_PROJECT_DIR}` to the scan root. An unset `${VAR}` with no default is a warning, the same as an unset `${env:NAME}`. A URL that still contains `${…}` is not also `BAD_URL`. Expanded values are not printed.
- `name@latest`, `name@next`, and `name@*` are `UNPINNED_PACKAGE`. `--online` reports `NPM_LATEST` for those tags instead of calling them pinned. Exact versions and semver ranges stay pinned.
- Stdio command lookup uses the server's `env.PATH` when that value has no unresolved `${…}`. The probe spawns the absolute path found there. On Windows, `Path` is the same key. A PATH that still contains `${…}` stays on the variable check.
- Gemini CLI `httpUrl` is a remote URL. It wins over `url` and `command`.
- Doc placeholders in env, headers, and Cursor `auth` warn (`PLACEHOLDER_ENV`, `PLACEHOLDER_HEADER`).
- An unset Gemini CLI `$NAME` env reference warns `UNRESOLVED_VARIABLE`. On Windows, `%NAME%` does too. A set value is not printed.
- Claude Code `.mcp.json` and `~/.claude.json`: a `url` with no `type` is `MISSING_TRANSPORT_TYPE`. `type: "sdk"` is skipped instead of `NO_TRANSPORT`.

### Changed

- The install examples run `check --no-user`. Omitting the flag also reads user-level configs, and those rows are labeled `user`.

## [1.4.0] - 2026-10-17

### Added

- Discover Gemini CLI project `.gemini/settings.json` and user `~/.gemini/settings.json`. `GEMINI_CLI_HOME` selects `$GEMINI_CLI_HOME/.gemini/settings.json`. `mcpServers` uses the existing parser. A settings file with no `mcpServers` key is skipped. `--no-user` skips the user file. System settings are not scanned.
- Discover the VS Code user `mcp.json` (`servers`) and the Copilot user `mcp-config.json` (`mcpServers`). VS Code uses `~/Library/Application Support/Code/User/mcp.json` on macOS, `$XDG_CONFIG_HOME/Code/User/mcp.json` (default `~/.config/Code/User/mcp.json`) on Linux, and `%APPDATA%/Code/User/mcp.json` on Windows. `COPILOT_HOME` replaces `~/.copilot`. `--no-user` skips both. A missing file is skipped. Insiders and VSCodium are not scanned.
- Warn `UNPINNED_PACKAGE` when `uvx`, `bunx`, `pnpm dlx`, `pnpm exec`, or `yarn dlx` launches a package without a version. `name@version` and `uvx --from name@version` do not warn. `--online` looks up that same package. A registry miss stays `NPM_LOOKUP_FAILED`.

### Fixed

- Claude Code `projects` keys in `~/.claude.json` match the scan root when both paths are the same directory, including a symlink and macOS `/tmp` versus `/private/tmp`. A key for a different directory is still ignored. Trailing-slash and Windows case matching is unchanged.
- A relative stdio command is resolved from the scan root, and the probe spawns that absolute path. A command that exists only in the process working directory is still `COMMAND_NOT_FOUND`.
- On Windows, a bare command is searched in the scan root before `PATH`, with `PATHEXT`. An empty `PATH` entry is that directory on every platform. An unset `PATH` does not search it.
- SARIF URIs and GitHub annotation `file` paths are relative to the workspace when the scan root is the process working directory or a subdirectory of it. A scan root outside that directory stays relative to itself.

### Changed

- A scan with no MCP config still exits 1. The `NO_CONFIG` message names a project file to add (`.cursor/mcp.json` or `.vscode/mcp.json`) and `--allow-missing` to exit 0 when the repository is supposed to have no MCP config.
- Human-readable server rows say `project` or `user`. JSON keeps the file path and adds `scope`. Summary counts are unchanged.

## [1.3.0] - 2026-10-13

### Added

- Discover Claude Code user and local servers in `~/.claude.json`: top-level `mcpServers`, and `projects[<absolute path>].mcpServers` for the scan root only. Other projects in the file are ignored. `CLAUDE_CONFIG_DIR` selects the directory. On Windows the file is `%USERPROFILE%\.claude.json`. `--no-user` skips the file, including the per-project entry. A file with no servers for this root is skipped, not `NO_MCP_SECTION`. Values from the file are not printed.
- Discover Continue `.continue/mcpServers/*.{yaml,yml,json}` and an `mcpServers` list in `.continue/config.yaml` and `~/.continue/config.yaml` (user file skipped with `--no-user`). Each list entry is one server. `command` and `args` are stdio, `url` is HTTP, and neither is `NO_TRANSPORT`. A file with no `mcpServers` list is skipped. A missing `.continue/` directory is not a failure. Unpinned `npx` packages still warn `UNPINNED_PACKAGE`. A JSON object dropped in that directory uses the existing `mcpServers` parser.
- Discover Junie `.junie/mcp/mcp.json` and `~/.junie/mcp/mcp.json` (unless `--no-user`), using the existing `mcpServers` parser. A missing file is skipped.
- Discover Cline `~/.cline/data/settings/cline_mcp_settings.json` unless `--no-user` is set. `CLINE_MCP_SETTINGS_PATH` replaces that file. `CLINE_DATA_DIR` uses `<dir>/settings/cline_mcp_settings.json` when the settings path is unset. A missing file is skipped.

### Changed

- README states that npm `latest` and the `v1` Action tag track 1.2.1, and that `package.json` is 1.3.0 until the `v1.3.0` tag is pushed.
- README shows a monorepo `path`, `fail-on-missing`, a full SARIF upload workflow, and husky, lefthook, and pre-commit snippets.
- README lists Claude Code `~/.claude.json`, Continue, Junie, and Cline, including `CLAUDE_CONFIG_DIR`, `CLINE_MCP_SETTINGS_PATH`, and `CLINE_DATA_DIR`.
- `--no-user` help text names every user-level client it skips, including Continue, Junie, and Cline.

### Fixed

- An empty server map still exits 1, and the summary line says that config-level warning is why. Server counts still add up. `NO_CONFIG` is unchanged.
- `--probe-timeout` must be a positive number of milliseconds. A non-numeric, zero, or negative value exits before a probe starts. The default stays 8000.
- On Windows, the user-level scan includes the Claude Desktop MSIX config `%LOCALAPPDATA%/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json` when that file exists, along with `%APPDATA%/Claude/claude_desktop_config.json`.

## [1.2.1] - 2026-10-10

### Fixed

- `${input:…}` and an unset `${env:NAME}` are warnings. Unknown `${…}` tokens still fail. `--strict-variables` fails on the warnings too. A probe is not started while a variable is unresolved.
- Cursor `disabled: true` and Codex or Zed `enabled: false` are reported as disabled and are not checked.
- An HTTP 401 or 403 with an OAuth `WWW-Authenticate` challenge is `PROBE_OAUTH`, a warning. The MCP client signs in. A 401 without that challenge is still a failure.
- JSON configs accept comments and trailing commas.
- Codex `bearer_token_env_var` and `env_http_headers` are sent on probes. A missing variable is `AUTH_ENV_UNSET` and the value is not printed.
- Zed `"source": "extension"` servers are not `NO_TRANSPORT`.
- Relative `-f` paths resolve from the current directory. A missing file is `FILE_NOT_FOUND`. A missing scan root is `ROOT_NOT_FOUND`. HTTP connection failures include the cause, such as `ECONNREFUSED`.
- Summary `ok`, `warn`, and `fail` count servers only, so they add up. Skipped settings files are `skipped`.
- The Action does not fail a job that only has `NO_CONFIG`, unless `fail-on-missing` is true.
- Node.js 22.12 or newer is required, matching commander 15. CI, the release workflow, and the Action default use Node 22.

### Changed

- README and roadmap match the published package, the `v1` tag, and the Marketplace listing.
- The release workflow publishes the current changelog section, requests `id-token: write`, and publishes with provenance. `NPM_TOKEN` remains the fallback when trusted publishing is not configured.
- Workflows use `actions/checkout@v7`, `actions/setup-node@v7`, and `softprops/action-gh-release@v3`. The Action uses `actions/setup-node@v7` and `github/codeql-action/upload-sarif@v4`.

## [1.2.0] - 2026-10-10

### Added

- After a successful `--probe` handshake, call `tools/list`. An empty catalog is `EMPTY_TOOLS` (a warning). A tools/list error or timeout is `TOOLS_LIST_FAILED` (a warning). `--no-tools` skips the call. A catalog with at least one tool stays successful.
- Discover Windsurf (`.windsurf/mcp_config.json` and `serverUrl`), Zed (`.zed/settings.json` `context_servers`, including a command object), and Codex (`.codex/config.toml` `[mcp_servers.<name>]`). User-level paths for those clients are included unless `--no-user` is set. A missing file, or a Codex config with no `mcp_servers` table, is not a failure.
- `--sarif <file>` writes SARIF 2.1.0 for warn and fail findings. `--github-annotations` prints `::warning` and `::error` on stderr. The GitHub Action emits annotations and writes `mcp-health.sarif` by default, and uploads that file only when `upload-sarif` is `true`.

## [1.1.0] - 2026-10-10

### Fixed

- Expand `${workspaceFolder}`, `${userHome}`, `${pathSeparator}`, and `${env:NAME}` in commands, args, URLs, env, and headers. Unresolved `${input:…}` and other `${…}` tokens fail the server instead of reporting it healthy.
- Run stdio probes with the scan root as the working directory, so a config in `.vscode/` can launch a relative path from the project root.
- Fail a stdio probe when the server process exits, instead of waiting out `--probe-timeout`.
- Match stdio and SSE responses by JSON-RPC id. Log lines and notifications are skipped.
- Send HTTP `headers` from the config. 401 and 403 are failures. Streamable HTTP `text/event-stream` bodies are read as the handshake result.
- Advertise protocol `2025-11-25` on initialize. If that method is rejected, try `server/discover` on `2026-07-28`.
- Treat a semver range such as `^2025.1.0` as current when npm latest satisfies it.
- Report `SCHEMA_ERROR` when `mcpServers` is present but invalid (for example a numeric env value), instead of `NO_MCP_SECTION`.
- Omit `OK HEALTHY` when the same server also has a warning or a failure.
- On Windows, resolve commands with `PATHEXT` so `npx.cmd` is not reported missing, and spawn the resolved path.

### Changed

- npm package name is `@leon-pixel/mcp-health`. The unscoped name `mcp-health` was published and then unpublished, and npm will not release it again. The bin name is still `mcp-health`.
- The release workflow publishes that package when `NPM_TOKEN` is set, and it moves the `v1` tag to each stable `v1.x.y` release.

## [1.0.0] - 2026-08-08

0.1.0, 0.2.0, 0.3.0, and 1.0.0 were all cut on 2026-08-08, in the initial public commit series. They are one drop split into changelog sections, not four separately shipped milestones.

### Added

- Composite GitHub Action (`action.yml`) for CI scans
- Release workflow (GitHub Release on `v*` tags)
- npm publish workflow (requires `NPM_TOKEN` secret)
- Full v1 surface: static scan, client path matrix, `--online` drift, `--probe` smoke

### Included from the same-day 0.x sections

- `mcp-health check` CLI with human and JSON output
- Exit codes: 0 ok / 1 warn / 2 fail
- Cursor, Claude Desktop, Claude Code, and VS Code config discovery
- Fixtures, Vitest suite, CI on `main`

## [0.3.0] - 2026-08-08

Same day as 1.0.0. See the note under 1.0.0.

### Added

- `--probe` / `--probe-timeout` MCP initialize smoke checks (stdio and HTTP)

## [0.2.0] - 2026-08-08

Same day as 1.0.0. See the note under 1.0.0.

### Added

- Claude Desktop and Claude Code path matrix
- `--online` npm registry version drift checks

## [0.1.0] - 2026-08-08

Same day as 1.0.0. See the note under 1.0.0.

### Added

- Initial CLI, fixtures, MIT license, CI
