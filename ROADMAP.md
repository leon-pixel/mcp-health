# Roadmap to v1.0

## Product promise

`mcp-health` is the local/CI CLI that answers: **“Will my MCP servers actually load, or will agents fail on broken configs?”**

Not a registry UI. Not a hosted dashboard. A sharp check + optional probe.

## Definition of done — v1.0

| # | Capability | Status |
|---|------------|--------|
| 1 | Static config scan | Done |
| 2 | Client path matrix | Done |
| 3 | npm registry version drift (`--online`) | Done |
| 4 | Optional smoke probe (`--probe`) | Done |
| 5 | Reusable GitHub Action | Done (1.0.0) |
| 6 | Release workflow + npm publish path | Done (1.0.0) |
| 7 | Docs / changelog | Done |
| 8 | Portfolio case study | Next (separate repo) |

**Out of scope for v1.0:** hosted dashboard, auto-fix configs, registry browser UI, paid cloud.

## Post-1.0 ideas (optional)

- SARIF output for GitHub code scanning
- `--fix` suggestions (non-destructive report only first)
- Broader Windsurf / Continue path matrix
- Official npm publish once `NPM_TOKEN` is configured (or scoped rename if name tombstoned)

## Autonomy defaults

**Do without asking:** implement, test, commit, push, tag releases.  
**Ask only if:** npm name blocked requiring rename, breaking CLI redesign, secrets/SaaS scope.
