# Changelog

All notable changes to this project are documented in this file.

## [1.0.0] - 2026-08-08

### Added
- Composite GitHub Action (`action.yml`) for CI scans
- Release workflow (GitHub Release on `v*` tags)
- npm publish workflow (requires `NPM_TOKEN` secret)
- Full v1 surface: static scan, client path matrix, `--online` drift, `--probe` smoke

### Includes from 0.x
- `mcp-health check` CLI with human + JSON output
- Exit codes: 0 ok / 1 warn / 2 fail
- Cursor, Claude Desktop/Code, VS Code config discovery
- Fixtures, Vitest suite, CI on `main`

## [0.3.0] - 2026-08-08

### Added
- `--probe` / `--probe-timeout` MCP initialize smoke checks (stdio + HTTP)

## [0.2.0] - 2026-08-08

### Added
- Claude Desktop / Claude Code path matrix
- `--online` npm registry version drift checks

## [0.1.0] - 2026-08-08

### Added
- Initial CLI, fixtures, MIT license, CI
