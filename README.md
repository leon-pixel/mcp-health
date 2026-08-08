# mcp-health

CLI that scans MCP (Model Context Protocol) server configs and reports **broken entries, missing commands, bad URLs, placeholder env vars, and unpinned npx packages**.

MCP configs are often copied from READMEs and left to rot. `mcp-health` is a local, no-API-key check you can run in a repo or CI before agents fail mysteriously.

## Install

```bash
# from source (dev)
npm install
npm run check -- --no-user fixtures/healthy

# after publish
npx mcp-health check .
```

Requires **Node 20+**.

## Usage

```bash
# Scan current project (also reads ~/.cursor/mcp.json unless --no-user)
npm run check -- .

# Fixture demo
npm run check -- --no-user fixtures/issues

# JSON for CI
npm run check -- --no-user --json fixtures/healthy

# Explicit file
npm run check -- --no-user -f path/to/mcp.json .
```
### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All ok |
| `1` | Warnings only (e.g. unpinned package) |
| `2` | Failures (missing command, bad URL, etc.) |

## What it scans

Project files (if present):

- `.cursor/mcp.json`
- `mcp.json`
- `.mcp.json`
- `.vscode/mcp.json`

Optional: `~/.cursor/mcp.json` (disable with `--no-user`).

Supports `mcpServers` and `servers` maps with stdio (`command`/`args`) or HTTP (`url`) transports.

## Checks (v0.1)

- Invalid / unknown JSON shape
- Missing `command` and `url`
- `command` not found on `PATH`
- Invalid HTTP(S) URL
- `npx`/`npm exec` without a package
- Unpinned package refs (warns: prefer `name@version`)
- Placeholder `env` / args (`YOUR_*`, `changeme`)

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

A ready workflow lives in `.github/workflows/ci.yml`.

## Tradeoffs

- **Local only:** does not probe remote MCP HTTP endpoints or run servers.
- **PATH-based:** if your IDE uses a different PATH than the terminal, results can differ — run inside the same environment you use for agents.
- **Pin heuristic:** version pinning is string-based (`pkg@1.2.3`); dist-tags like `@latest` still count as “pinned” textually but are not immutable.

## Roadmap

- Registry version drift vs npm
- MCP server smoke handshake
- Cursor / Claude config path matrix expansion

## License

MIT
