# Roadmap to v1.0

## Product promise

`mcp-health` is the local/CI CLI that answers: **“Will my MCP servers actually load, or will agents fail on broken configs?”**

Not a registry UI. Not a hosted dashboard. A sharp check + optional probe.

## Definition of done — v1.0 (ship this)

| # | Capability | Status |
|---|------------|--------|
| 1 | Static config scan (paths, parse, PATH, URL, pins, placeholders) | Done (0.1.0) |
| 2 | Client path matrix: Cursor, Claude Desktop, Claude Code, VS Code | Done (0.2.0) |
| 3 | npm registry version drift (`--online`) | Done (0.2.0) |
| 4 | Optional stdio/HTTP smoke probe (`--probe`, timeout, no secrets logged) | Done (0.3.0) |
| 5 | Reusable GitHub Action (composite) + SARIF/annotations | Next |
| 6 | `npm publish` + versioned GitHub Release + changelog | Planned |
| 7 | Docs: install, CI recipes, security notes, troubleshooting | Planned |
| 8 | Portfolio case study link (separate repo work) | After 6 |

**Out of scope for v1.0** (defer unless demanded): hosted dashboard, MCP registry browser UI, auto-fix/rewrite configs, paid cloud.

## Phases

### Phase A — Config matrix + drift ✅
- Discover Claude Desktop `claude_desktop_config.json` (macOS/Windows/Linux)
- Discover Claude Code `.claude/settings*.json` + user settings
- Expand VS Code / Cursor variants
- `mcp-health check --online`: npm latest vs pinned; warn on drift / missing
- Tests + fixtures + README
- Shipped **0.2.0**

### Phase B — Smoke probe ✅
- `--probe`: spawn stdio servers briefly / initialize HTTP MCP where safe
- Hard timeouts, kill orphans, never print env values
- Exit codes stay: 0 ok / 1 warn / 2 fail
- Shipped **0.3.0**

### Phase C — Distribution (next)
- Composite GitHub Action `leon-pixel/mcp-health`
- CHANGELOG, release workflow on tag
- Publish to npm as `mcp-health` (or scoped if name taken)
- Bump **1.0.0** → push + tag

### Phase D — Portfolio hook
- Case study on leon-portfolio (separate workspace)
- Pin GitHub repo

## Autonomy defaults (little approval needed)

**I will do without asking:**
- Implement phases A→C in order
- Add tests, docs, CI updates
- Commit + push to `main` after each phase is green
- Patch/minor version bumps

**I will pause and ask only if:**
- npm package name is taken and needs a different public name
- You want a breaking CLI redesign (command renames)
- Probe behavior would require storing or transmitting secrets
- Scope creep into hosted SaaS / UI product

**Default decisions already chosen:**
- Language: TypeScript / Node 20+
- License: MIT
- Repo: public
- Network features opt-in (`--online`, `--probe`) so default stays offline-safe for CI secrets contexts
- Fail closed on parse/PATH/URL; warn on drift/unpinned

## Success metrics for “final”

1. `npx mcp-health check .` works for strangers
2. CI Action usable in other repos in &lt;2 minutes
3. README demos healthy + issues fixtures
4. At least one real scan of your own `~/.cursor/mcp.json` documented as a dogfood note
