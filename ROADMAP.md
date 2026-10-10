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
| 5 | Reusable GitHub Action | Shipped in the repo. Not listed on the Marketplace yet |
| 6 | Release workflow | Shipped. npm publish runs when `NPM_TOKEN` is set. The package is not on npm yet |
| 7 | Docs and changelog | Shipped |

0.1.0 through 1.0.0 were cut on the same day as the initial public commits. See the changelog.

## Shipped in 1.2.0

| # | Capability | Status |
|---|------------|--------|
| 1 | `tools/list` during `--probe`, with `EMPTY_TOOLS` as a warning | Shipped |
| 2 | Windsurf, Zed, and Codex project and user config paths | Shipped |
| 3 | SARIF 2.1.0 and GitHub Actions annotations | Shipped. Code scanning upload is opt-in |
| 4 | README demo and a comparison with Inspector, MCP Doctor, and mcp-healthcheck | Shipped |

## Next

- Publish `@leon-pixel/mcp-health` by adding `NPM_TOKEN` and tagging a stable release
- List the Action on the GitHub Marketplace from that release

## Out of scope

Hosted dashboard, auto-fix that rewrites configs, registry browser, paid cloud.
