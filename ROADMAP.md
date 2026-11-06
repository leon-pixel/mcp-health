# Roadmap

## Product promise

`mcp-health` is the local and CI check that answers: **will my MCP servers actually load, or will agents fail on a broken config?**

It is not a registry UI and not a hosted dashboard. It is a config scan plus an optional handshake.

## Shipped in 1.0.0

| # | Capability | Status |
|---|------------|--------|
| 1 | Static config scan | Shipped |
| 2 | Client path matrix (Cursor, VS Code, Claude Code, Claude Desktop) | Shipped |
| 3 | npm registry version drift (`--online`) | Shipped |
| 4 | Optional smoke probe (`--probe`) | Shipped |
| 5 | Reusable GitHub Action | Shipped. Listed as [mcp-health-doctor](https://github.com/marketplace/actions/mcp-health-doctor) |
| 6 | Release workflow | Shipped. `@leon-pixel/mcp-health` is on npm |
| 7 | Docs and changelog | Shipped |

0.1.0 through 1.0.0 were cut on the same day as the initial public commits. See the changelog.

## Shipped in 1.2.0

| # | Capability | Status |
|---|------------|--------|
| 1 | `tools/list` during `--probe`, with `EMPTY_TOOLS` as a warning | Shipped |
| 2 | Windsurf, Zed, and Codex project and user config paths | Shipped |
| 3 | SARIF 2.1.0 and GitHub Actions annotations | Shipped. Code scanning upload is opt-in |
| 4 | README demo and a comparison with Inspector, MCP Doctor, and mcp-healthcheck | Shipped |

## Shipped in 1.2.1

Patch release on top of the published 1.2.0 package. IDE input variables and disabled servers no longer fail a scan. OAuth remotes, JSONC configs, Codex auth env vars, and Zed extension servers are recognized. The Action ignores a repository with no MCP config unless asked not to. Node 22.12 is the minimum.

## Shipped in 1.3.0

| # | Capability | Status |
|---|------------|--------|
| 1 | Claude Code user and per-project servers in `~/.claude.json` | Shipped |
| 2 | Continue (`.continue/mcpServers` and `config.yaml`), Junie (`.junie/mcp/mcp.json`), and Cline (`~/.cline/data/settings/cline_mcp_settings.json`) | Shipped |
| 3 | Empty server map still exits 1, `--probe-timeout` rejects non-positive values, and the Windows Claude Desktop MSIX config is scanned | Shipped |

## Shipped in 1.4.0

| # | Capability | Status |
|---|------------|--------|
| 1 | Gemini CLI project and user `settings.json` | Shipped |
| 2 | VS Code user `mcp.json` and Copilot user `mcp-config.json` | Shipped |
| 3 | Unpinned `uvx`, `bunx`, `pnpm dlx`, `pnpm exec`, and `yarn dlx` | Shipped |
| 4 | Claude project paths match the real directory, relative commands resolve from the scan root, and annotation paths use the workspace | Shipped |
| 5 | A zero-config run names a project file to add and `--allow-missing` | Shipped |

## Next

npm `latest` and the `v1` Action tag track the published `1.5.0` release. `package.json` stays `1.5.0` until a release tag is pushed. `main` has the unreleased checks in [CHANGELOG.md](./CHANGELOG.md), including nested scans, finding suppression, `init`, and the clients added since 1.5.0.

Still open: [`.mcp-health.json` comments and code-wide matches](https://github.com/leon-pixel/mcp-health/issues/118), and [`resources/list` / `prompts/list` during `--probe`](https://github.com/leon-pixel/mcp-health/issues/119).

The report includes a copy-paste fix for a finding and does not write config files.

## Out of scope

Hosted dashboard, auto-fix that rewrites configs, registry browser, paid cloud.
