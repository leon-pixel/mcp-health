# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
