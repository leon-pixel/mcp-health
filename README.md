# mcp-health

CLI + GitHub Action that scans MCP (Model Context Protocol) server configs and reports **broken entries, missing commands, bad URLs, placeholder env vars, unpinned packages, npm drift, and optional initialize probes**.

Catch rotten MCP configs before agents fail mysteriously.

## Install

```bash
# from source
npm install
npm run check -- --no-user fixtures/healthy

# from npm (after publish)
npm i -g mcp-health
mcp-health check .
# or
npx mcp-health check .
```

Requires **Node 20+**.

## Usage

```bash
npm run check -- .
npm run check -- --no-user fixtures/issues
npm run check -- --no-user --online fixtures/healthy
npm run check -- --no-user --probe --probe-timeout 5000 fixtures/probe-ok
npm run check -- --no-user --json fixtures/healthy
npm run check -- --no-user -f path/to/mcp.json .
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All ok |
| `1` | Warnings only |
| `2` | Failures |

## GitHub Action

```yaml
name: mcp-health
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: leon-pixel/mcp-health@v1
        with:
          path: .
          args: --no-user
```

Optional args: `--online`, `--probe`, `--probe-timeout 8000`, `--json`.

## What it scans

**Project:** `.cursor/mcp.json`, `mcp.json`, `.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`

**User-level** (disable with `--no-user`): `~/.cursor/mcp.json`, `~/.claude/settings.json`, Claude Desktop `claude_desktop_config.json`

## Checks

- Offline: JSON shape, PATH, URLs, pins, placeholders
- `--online`: npm latest vs pinned (`NPM_DRIFT`)
- `--probe`: MCP `initialize` handshake (stdio spawn / HTTP POST); never logs env values

## Example

```text
[FAIL] broken-binary  (stdio)
    - FAIL COMMAND_NOT_FOUND: Command not found on PATH: ...
[WARN] unpinned  (stdio)
    - WARN UNPINNED_PACKAGE: ...
```

## Publish / releases

- Tags `v*` create a GitHub Release (see `.github/workflows/release.yml`)
- npm publish runs when `NPM_TOKEN` is set on the repo; otherwise that step is skipped
- If the unscoped name is blocked on npm, publish as `@leon-pixel/mcp-health` instead

## Tradeoffs

- Default scan is offline (CI-safe)
- `--probe` runs real processes — avoid on untrusted configs
- IDE PATH may differ from CI/terminal

## Roadmap

See [ROADMAP.md](./ROADMAP.md) and [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
