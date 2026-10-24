# mcp-health

CLI and GitHub Action that scans MCP (Model Context Protocol) server configs and reports **broken entries, missing commands, bad URLs, placeholder env vars, unpinned packages, npm drift, and optional initialize and tools/list probes**.

Catch rotten MCP configs before agents fail on them.

## Demo

Real `mcp-health check --no-user` output. The first run is `fixtures/issues` (exit 2). The second is `fixtures/healthy` (exit 0). The checkout path is shown as the fixture directory. After `npm run build`, regenerate it with `python3 scripts/render-demo-gif.py` (needs Pillow and a monospace font).

![mcp-health check on fixtures/issues, then fixtures/healthy](docs/demo.gif)

## Install

Node.js 22.12 or newer.

The npm package name is `@leon-pixel/mcp-health`. The unscoped name `mcp-health` was published by someone else and then unpublished, so npm will not let this project use it. The command name is still `mcp-health`.

Check a repository without reading configs in your home directory. `npx` is enough; a global install is optional.

```bash
npx @leon-pixel/mcp-health check --no-user .
```

```bash
npm i -g @leon-pixel/mcp-health
mcp-health check --no-user .
```

Omit `--no-user` to also read user-level configs (Cursor, Claude, VS Code, and the rest of the list below). Those rows are labeled `user`. A warning there is in the home-directory file, not in the repository.

From a checkout of this repository:

```bash
npm install
npm run check -- --no-user fixtures/healthy
```

## Usage

```bash
mcp-health check .
mcp-health check --no-user fixtures/issues
mcp-health check --no-user --online fixtures/healthy
mcp-health check --no-user --probe --probe-timeout 5000 fixtures/probe-ok
mcp-health check --no-user --probe --no-tools fixtures/probe-ok
mcp-health check --no-user --sarif mcp-health.sarif fixtures/issues
mcp-health check --no-user --github-annotations fixtures/issues
mcp-health check --no-user --json fixtures/healthy
mcp-health check --no-user -f path/to/mcp.json .
npx @leon-pixel/mcp-health check --no-user .
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All ok |
| `1` | Warnings only |
| `2` | Failures |

A directory with no MCP config exits 1. The message names a project file to add, such as `.cursor/mcp.json` or `.vscode/mcp.json`, and `--allow-missing`, which exits 0 when the repository is supposed to have no MCP config. The GitHub Action passes `--allow-missing` unless `fail-on-missing` is true.

Text output labels each server row `project` or `user`. JSON keeps the file path and adds `scope` (`"project"` or `"user"`). Summary counts are unchanged.

`--sarif` and `--github-annotations` do not change the exit code. They add a SARIF file and stderr annotations beside the usual report. Ok findings are left out of both.

## GitHub Action

```yaml
name: mcp-health
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: leon-pixel/mcp-health@v1
        with:
          path: .
```

`v1` is a moving tag. The [release workflow](.github/workflows/release.yml) points it at the latest stable `v1.x.y` release. It currently tracks the published 1.5.0 release and moves again when a newer stable tag is pushed.

The action is listed on the Marketplace as [mcp-health-doctor](https://github.com/marketplace/actions/mcp-health-doctor). `uses: leon-pixel/mcp-health@v1` installs that listing.

`path` is the scan root, relative to the job workspace. In a monorepo, point it at the package that holds the MCP config. Other packages are not scanned.

```yaml
- uses: leon-pixel/mcp-health@v1
  with:
    path: services/api
    args: --probe
```

The action always passes `--no-user`, so the job does not read the runner's user-level configs. `args` are additional flags. Setting `args` does not remove `--no-user`. The example above runs `check --no-user --probe`, plus the annotation, allow-missing, and SARIF flags the action adds itself.

`include-user: true` drops that `--no-user` and scans the runner's Cursor, Claude, VS Code, Codex, and other user configs. A GitHub-hosted runner usually has an empty home directory. A self-hosted runner reads that machine's user. An explicit `--no-user` inside `args` still skips user configs.

```yaml
- uses: leon-pixel/mcp-health@v1
  with:
    include-user: true
    args: --online
```

Before this fix, `args` defaulted to `--no-user` and GitHub replaced that default when the workflow set the input. `args: --probe` ran without `--no-user`. A workflow that set `args` in order to read the runner's user configs should set `include-user: true` instead. A workflow that already passed `args: --no-user` (or `args: --no-user --probe`) still skips user configs. Repeating `--no-user` is safe.

A repository with no MCP config is `NO_CONFIG`. That warning does not fail the job unless `fail-on-missing` is `true`. Leave the default (`false`) for a repo that may have no MCP config. Set it when that directory is supposed to contain one:

```yaml
- uses: leon-pixel/mcp-health@v1
  with:
    path: services/api
    fail-on-missing: true
```

Annotations are on by default (`::error` and `::warning` in the job log). A SARIF 2.1.0 file is written to `mcp-health.sarif` unless `sarif-file` is `false`. Uploading that file to code scanning is off unless you opt in. The upload needs `security-events: write` on the job, and the repository has to have code scanning enabled.

```yaml
name: mcp-health
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v5
      - uses: leon-pixel/mcp-health@v1
        with:
          annotations: true
          sarif-file: mcp-health.sarif
          upload-sarif: true
```

The check step itself exits 0 so the upload can still run after findings. A following step exits with the real mcp-health code, so the job still fails on warnings and failures. The `exit-code` output is that code (`0`, `1`, or `2`).

Optional `args`: `--online`, `--probe`, `--no-tools`, `--strict-variables`, `--probe-timeout 8000`, `--json`. These are added after `--no-user`.

## Gate a commit

`check --no-user` does not start servers and does not read user-level configs. Warnings exit 1, so a hook fails on an unpinned package as well as a missing command.

husky, in `.husky/pre-commit`:

```sh
npx --yes @leon-pixel/mcp-health check --no-user
```

lefthook, in `lefthook.yml`:

```yaml
pre-commit:
  commands:
    mcp-health:
      run: npx --yes @leon-pixel/mcp-health check --no-user
```

pre-commit, in `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: mcp-health
        name: mcp-health
        entry: npx --yes @leon-pixel/mcp-health check --no-user
        language: system
        pass_filenames: false
```

`npx` needs Node.js 22.12 or newer on `PATH`. `pass_filenames: false` matters because the hook checks the repo, not the staged file list.

## What it scans

**Project** (a missing file is skipped):

| Client | Path | Shape |
|--------|------|--------|
| Cursor | `.cursor/mcp.json`, `mcp.json`, `.mcp.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` | `servers`. An `env` value may be a string, a number, or null. `unix:` and `pipe:` URLs are socket transports, including a fragment subpath. `cwd` is the stdio working directory and defaults to the workspace folder |
| Copilot | `.github/mcp.json` | `mcpServers`, or a bare object whose keys are server names. `command` and `args` are stdio. `url` is HTTP. `type: "local"` still uses `command` and `args`. `tools` is an allowlist |
| Claude Code | `.claude/settings.json`, `.claude/settings.local.json` | Permissions and hooks, not servers. An `mcpServers` key is a failure, `MCP_SERVERS_IGNORED`. Project servers belong in `.mcp.json`. A settings file with no `mcpServers` key is skipped |
| Gemini CLI | `.gemini/settings.json` | `mcpServers`. `httpUrl` is streamable HTTP and wins over `url` and `command`. `$NAME` in an env value is an environment reference. `cwd` is the stdio working directory, relative to the project. A file with no `mcpServers` key is skipped |
| Continue | `.continue/config.yaml`, `.continue/mcpServers/*.{yaml,yml,json}` | `mcpServers` list of `{ name, command, args, env, url }`. A JSON file in that directory may instead be a `mcpServers` object. A file with no `mcpServers` list is skipped |
| Junie | `.junie/mcp/mcp.json` | `mcpServers` |
| Windsurf | `.windsurf/mcp_config.json` | `mcpServers`. Remote URLs may be `serverUrl` or `url` |
| Zed | `.zed/settings.json` | `context_servers`. `command` may be a string or `{ "path", "args", "env" }`. `"source": "extension"` is an extension server. Comments and trailing commas are allowed |
| Codex | `.codex/config.toml` | `[mcp_servers.<name>]` with `command`, `args`, `cwd`, `url`, `env`, `http_headers`, `bearer_token_env_var`, `env_http_headers`, `enabled` |

A Codex `config.toml`, a `~/.claude.json` with no servers for this scan root, a Continue file with no `mcpServers` list, a Gemini CLI `settings.json` with no `mcpServers` key, or another settings file with no MCP section is skipped. It is not a failed scan. A Claude Code settings file that does contain `mcpServers` is `MCP_SERVERS_IGNORED`, because Claude Code does not load servers from that file.

**User-level** (disable with `--no-user`):

- Cursor `~/.cursor/mcp.json`
- VS Code user `mcp.json` (`servers`): `~/Library/Application Support/Code/User/mcp.json` on macOS, `$XDG_CONFIG_HOME/Code/User/mcp.json` (default `~/.config/Code/User/mcp.json`) on Linux, or `%APPDATA%/Code/User/mcp.json` on Windows. Insiders and VSCodium are not scanned
- Copilot `mcp-config.json` (`mcpServers`): `$COPILOT_HOME/mcp-config.json`, or `~/.copilot/mcp-config.json` when `COPILOT_HOME` is unset. `cwd` is the stdio working directory. Project `.github/mcp.json` does not use `cwd`
- Claude Code `~/.claude/settings.json` is permissions and hooks, not a server list. An `mcpServers` key is `MCP_SERVERS_IGNORED`. User and per-project servers are in `~/.claude.json`
- Gemini CLI `~/.gemini/settings.json`. When `GEMINI_CLI_HOME` is set, the file is `$GEMINI_CLI_HOME/.gemini/settings.json`. Shape `mcpServers`, including `httpUrl` and `cwd` (relative to the project). A file with no `mcpServers` key is skipped. System settings are not scanned
- Claude Code `~/.claude.json`: top-level `mcpServers`, and `projects[<absolute path>].mcpServers` for this scan root only. A key matches when it is the same directory as the scan root, including a symlink and macOS `/tmp` versus `/private/tmp`. Other projects in the file are ignored. `CLAUDE_CONFIG_DIR` is the directory that holds `.claude.json` instead of the home directory. On Windows the file is `%USERPROFILE%\.claude.json`
- Continue `~/.continue/config.yaml` (`mcpServers` list)
- Junie `~/.junie/mcp/mcp.json`
- Cline `~/.cline/data/settings/cline_mcp_settings.json`. `CLINE_MCP_SETTINGS_PATH` replaces that file. When it is unset, `CLINE_DATA_DIR` reads `<CLINE_DATA_DIR>/settings/cline_mcp_settings.json`
- Claude Desktop `claude_desktop_config.json` under `~/Library/Application Support/Claude/` on macOS, or `~/.config/Claude/` on Linux. On Windows, `%APPDATA%/Claude/claude_desktop_config.json` and, when that file exists, the MSIX path `%LOCALAPPDATA%/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json`
- Windsurf `~/.codeium/windsurf/mcp_config.json`
- Devin Desktop `mcp_config.json` under `$XDG_CONFIG_HOME/devin/` (default `~/.config/devin/`), or `%APPDATA%/devin/` on Windows
- Zed `settings.json` under `$XDG_CONFIG_HOME/zed/` on Linux, plus `~/Library/Application Support/Zed/settings.json` and `~/.config/zed/settings.json` on macOS, or `%APPDATA%/Zed/settings.json` on Windows
- Codex `$CODEX_HOME/config.toml` when `CODEX_HOME` is a non-empty path, otherwise `~/.codex/config.toml`. A missing file is skipped. Project `.codex/config.toml` is a different file

## Checks

- Offline: JSON, YAML, and TOML shape, PATH (including Windows `PATHEXT`), URLs, pins, placeholders. `npx`, `npm exec`, `uvx`, `bunx`, `pnpm dlx`, `pnpm exec`, and `yarn dlx` warn `UNPINNED_PACKAGE` unless the package is `name@version` (`uvx --from name@version` counts as pinned). `name@latest`, `name@next`, and `name@*` are not pins. `-y`, `--yes`, `--quiet`, `dlx`, and `exec` are not the package name. A stdio command is resolved from the scan root, or from `cwd` when that client uses it. When the server sets `env.PATH` and that value has no `${…}` left, VS Code appends it to the process PATH (`.vscode/mcp.json` and the VS Code user `mcp.json`), and `--probe` spawns with that appended PATH. Other clients replace the process PATH. On Windows, `Path` is the same variable. A value that still contains `${…}` stays on the process PATH
- Stdio `cwd` is used for VS Code (`.vscode/mcp.json` and the user `mcp.json`), Copilot user `mcp-config.json`, Gemini CLI, and Codex. A relative `cwd` is resolved from the scan root. `${workspaceFolder}` and the other config variables are expanded first. An omitted `cwd` stays the scan root. A value that still contains `${…}` does not change the directory and warns `UNRESOLVED_VARIABLE`. Other clients ignore `cwd`. The config file is not rewritten
- A script argument for `node`, `python`, `python3`, `bun`, `deno`, or `tsx` (including the `.exe` and `.cmd` names) that is not a file in that directory is `SCRIPT_NOT_FOUND`. The file is not read. `node -e`, `node --version`, `python -m`, and `npx` / `uvx` / `bunx` / `pnpm` / `yarn` package arguments are not script paths. `bun run dev` is a package script. `bun run src/index.ts` is a file
- URL protocols: `http:` and `https:` are remote URLs. Claude Code WebSocket (`type: "ws"`) may use `ws:` or `wss:`. VS Code may use a Unix socket (`unix:///tmp/server.sock`) or a Windows named pipe (`pipe:///pipe/named-pipe`), including a fragment subpath such as `unix:///tmp/server.sock#/mcp/subpath`. Any other protocol (`ftp:`, `file:`) is `BAD_URL_PROTOCOL`. A URL that still contains `${…}` is not also `BAD_URL` or `BAD_URL_PROTOCOL`
- In a VS Code `servers` config, an `env` value may be a string, a number, or null. A number is checked as its decimal string. Null omits the variable and is not `PLACEHOLDER_ENV`. A boolean or object is still `SCHEMA_ERROR`. Other clients still require string env values
- Cursor stdio (`.cursor/mcp.json` and project `mcp.json`) and VS Code stdio `envFile` warn `ENV_FILE_MISSING` when the expanded path is not a file. The finding is a warning. The file is not read. A value that still contains `${…}` is not also `ENV_FILE_MISSING`. HTTP servers, `.mcp.json`, and `.github/mcp.json` do not use `envFile`
- Config variables: `${workspaceFolder}`, `${userHome}`, `${pathSeparator}`, `${CLAUDE_PROJECT_DIR}`, a set `${env:NAME}`, and Claude `${VAR}` / `${VAR:-default}` are expanded. `${input:…}`, an unset `${env:NAME}`, and an unset `${VAR}` with no default are warnings (`UNRESOLVED_VARIABLE`), not failures. Any other leftover `${…}` token fails the server. A URL that still contains `${…}` is not also `BAD_URL`. `--strict-variables` fails on the warnings too. Values are never printed
- `disabled: true` (Cursor) and `enabled: false` (Codex, Zed) are reported as disabled and are not checked
- Zed `"source": "extension"` is an extension-provided server. It is not a missing command
- `--online`: npm latest vs the pinned version or semver range (`NPM_DRIFT` only when latest is outside the pin). The lookup uses the same package those launchers run. A registry miss is `NPM_LOOKUP_FAILED`
- `--probe`: MCP handshake (stdio spawn, or HTTP POST). Stdio is spawned in the scan root, or in `cwd` when that client uses it. Stdio matches the JSON-RPC id and skips logs and notifications. HTTP sends the config headers, plus Codex `bearer_token_env_var` and `env_http_headers` when those variables are set. The HTTP probe speaks `http:` and `https:` only. `ws:`, `wss:`, `unix:`, and `pipe:` are `PROBE_SKIPPED`. A 401 with an OAuth `WWW-Authenticate` challenge is a warning (`PROBE_OAUTH`); the editor signs in and this probe does not. Env values are never printed
- After a successful handshake, `--probe` also calls `tools/list`. One or more tools is `TOOLS_OK`. An empty list is a warning, `EMPTY_TOOLS`, not a failure and not `HEALTHY`. A tools/list error or timeout is a warning, `TOOLS_LIST_FAILED`. `--no-tools` skips that call
- Doc placeholders warn in env (`PLACEHOLDER_ENV`), headers, and Cursor `auth` (`PLACEHOLDER_HEADER`): `your-key-here`, `your-token-here`, `your-api-token`, `your-oauth-client-id`, `your-client-secret`, `<token>`, `YOUR_`, `REPLACE_`, empty, and `changeme`. A real token is not a placeholder and is not printed
- Gemini CLI `$NAME` in an env value is `UNRESOLVED_VARIABLE` when that variable is unset, because the CLI substitutes an empty string. `%NAME%` is the same check on Windows. Other clients do not expand `$NAME`
- In `.mcp.json` and `~/.claude.json`, a `url` with no `type` is `MISSING_TRANSPORT_TYPE`. Claude Code skips that entry until the type is `http`, `sse`, `ws`, or `streamable-http`. `type: "sdk"` is skipped, not `NO_TRANSPORT`. Cursor `.cursor/mcp.json` remote servers still omit `type`
- Claude Code does not load `mcpServers` from `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json`. A present key is `MCP_SERVERS_IGNORED` (a failure). Those entries are not checked and are not probed. Move project servers to `.mcp.json` and user servers to `~/.claude.json`. A settings file with no `mcpServers` key is skipped

The initialize request uses protocol revision `2025-11-25`. If the server rejects that method, the probe tries `server/discover` on `2026-07-28`, then `tools/list` on that same revision.

## How this differs from Inspector and other health tools

mcp-health reads the MCP config files already in a repo (and, unless you pass `--no-user`, the user-level files above) and reports whether those entries will load: missing commands, bad URLs, unpinned packages, optional registry drift, and an optional handshake that includes `tools/list`. The GitHub Action is the CI form of that scan, with annotations and SARIF.

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`@modelcontextprotocol/inspector`) is the interactive debugger for one server you already know how to start. Its web, CLI, and TUI clients connect to that server so you can inspect and call tools, resources, and prompts. It does not scan Cursor, VS Code, Claude, Continue, Junie, Cline, Gemini CLI, Copilot, Windsurf, Zed, or Codex config files.

[MCP Doctor](https://mcpdoctor.ai/) (`npx mcpdoctor test …`) grades one server command against the MCP spec. [mcp-healthcheck](https://github.com/SiluPanda/mcp-healthcheck) is a liveness probe for one server URL or stdio command, including Kubernetes-style checks. mcp-health does not call tools, score spec compliance, or watch a running server. It checks the configs an agent will load.

## Example

```text
[FAIL] broken-binary  (stdio)  project  mcp.json
    - FAIL COMMAND_NOT_FOUND: ...
[WARN] unpinned  (stdio)  user  ~/.cursor/mcp.json
    - WARN UNPINNED_PACKAGE: ...
```

## Releases

`@leon-pixel/mcp-health@1.5.0` is the current npm `latest`. The Marketplace listing is [mcp-health-doctor](https://github.com/marketplace/actions/mcp-health-doctor). This repository is `1.5.0` in `package.json`, and the `v1.5.0` tag is published and `v1` points to it.

Pushing a stable tag `vX.Y.Z` that matches `version` in `package.json` runs [`.github/workflows/release.yml`](.github/workflows/release.yml). That workflow:

1. Runs the test suite and build
2. Creates a GitHub Release whose body is only that version's section of `CHANGELOG.md`
3. Moves the major tag (`v1` for a `v1.x.y` release) to that commit
4. Publishes `@leon-pixel/mcp-health` to npm with provenance

npm may hold the new version under Staged Packages until a maintainer approves it. Approval is what makes the version installable and moves the `latest` tag. The GitHub Release can exist before that approval.

### Trusted publishing

The workflow requests `id-token: write` and tries npm trusted publishing (OIDC) first. `NPM_TOKEN` is the fallback when that is not configured.

To switch this package off the token:

1. Open `@leon-pixel/mcp-health` on npmjs.com and add a trusted publisher.
2. Choose GitHub Actions. Organization or user: `leon-pixel`. Repository: `mcp-health`. Workflow filename: `release.yml`.
3. Allow `npm publish` for that publisher. If the package only allows staged publishes, the workflow's `npm publish` will fail until direct publish is allowed, and the version still has to be approved in Staged Packages.
4. Remove the `NPM_TOKEN` repository secret after a tag publishes without it.

Provenance is requested with `--provenance`. Trusted publishing adds it on its own when the token is absent. The publish step installs npm 11 first, which is what trusted publishing requires.

## Tradeoffs

- The default scan is offline, so it is safe in CI
- `--probe` runs real processes. Do not point it at configs you do not trust
- IDE `PATH` can differ from the PATH in CI or a terminal
- `${input:…}` values are not prompted. They are a warning, because the editor prompts for them
- SARIF upload is opt-in because many repositories do not have code scanning

## Roadmap

See [ROADMAP.md](./ROADMAP.md) and [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
