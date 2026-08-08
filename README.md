# mcp-health

CLI that scans MCP (Model Context Protocol) server configs and reports **broken entries, missing commands, bad URLs, placeholder env vars, unpinned npx packages, and (optional) npm version drift**.

MCP configs are often copied from READMEs and left to rot. `mcp-health` is a local check you can run in a repo or CI before agents fail mysteriously.

## Install

```bash
# from source
npm install
npm run check -- --no-user fixtures/healthy

# after publish
npx mcp-health check .
```

Requires **Node 20+**.

## Usage

```bash
# Scan project (also user-level Cursor / Claude Desktop unless --no-user)
npm run check -- .

# Offline fixture demo
npm run check -- --no-user fixtures/issues

# npm registry drift (network)
npm run check -- --no-user --online fixtures/healthy

# JSON for CI
npm run check -- --no-user --json fixtures/healthy

# Explicit file
npm run check -- --no-user -f path/to/mcp.json .
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All ok |
| `1` | Warnings only (e.g. unpinned package, npm drift) |
| `2` | Failures (missing command, bad URL, etc.) |

## What it scans

**Project (if present):**

- `.cursor/mcp.json`
- `mcp.json` / `.mcp.json`
- `.vscode/mcp.json`
- `.claude/settings.json` / `.claude/settings.local.json`

**User-level (disable with `--no-user`):**

- `~/.cursor/mcp.json`
- `~/.claude/settings.json`
- Claude Desktop `claude_desktop_config.json` (macOS / Windows / Linux paths)

Supports `mcpServers` and `servers` maps with stdio (`command`/`args`) or HTTP (`url`) transports. Client settings files without an MCP section are skipped (ok), not failed.

## Checks

**Always (offline):**

- Invalid JSON / unexpected shape
- Missing `command` and `url`
- `command` not found on `PATH`
- Invalid HTTP(S) URL
- `npx`/`npm exec` without a package
- Unpinned package refs
- Placeholder `env` / args (`YOUR_*`, `changeme`)

**With `--online`:**

- Lookup package on npm registry
- Warn if unpinned (suggest latest) or pinned version ≠ latest (`NPM_DRIFT`)

## Example output

```text
mcp-health — scanned /path/to/fixtures/issues
files: 1  servers: 4  ok: 0  warn: 1  fail: 3

[FAIL] broken-binary  (stdio)  .../mcp.json
    - FAIL COMMAND_NOT_FOUND: Command not found on PATH: definitely-not-a-real-mcp-binary-xyz

[WARN] unpinned  (stdio)  .../mcp.json
    - WARN UNPINNED_PACKAGE: Package "@modelcontextprotocol/server-memory" is not version-pinned ...
```

## GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: "20"
- run: npm ci && npm run build
- run: node dist/cli.js check --no-user .
```

Workflow: `.github/workflows/ci.yml`.

## Tradeoffs

- Default scan is **offline** (CI-safe). `--online` needs network.
- Does not start MCP servers unless/until `--probe` (roadmap Phase B).
- PATH may differ from your IDE — run in the same environment agents use.
- Dist-tags like `@latest` are treated as drift-prone vs concrete latest.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the path to **v1.0** (probe, reusable Action, npm publish).

## License

MIT
