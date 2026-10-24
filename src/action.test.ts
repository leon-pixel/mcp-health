import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));

type ActionInput = { description?: string; default?: string };
type ActionDoc = {
  inputs: Record<string, ActionInput>;
  runs: { steps: Array<{ id?: string; run?: string }> };
};

function loadAction(): ActionDoc {
  return parse(readFileSync(join(repo, "action.yml"), "utf8")) as ActionDoc;
}

function runStep(overrides: Record<string, string>): string[] {
  const doc = loadAction();
  const step = doc.runs.steps.find((item) => item.id === "run");
  if (!step?.run) throw new Error("action.yml is missing the run step");
  const inputs: Record<string, string> = {};
  for (const [name, input] of Object.entries(doc.inputs)) {
    inputs[name] = input.default ?? "";
  }
  Object.assign(inputs, overrides);

  const dir = mkdtempSync(join(tmpdir(), "mcp-health-action-"));
  try {
    const record = join(dir, "argv.txt");
    const output = join(dir, "github-output.txt");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const node = join(bin, "node");
    writeFileSync(
      node,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 0\n`,
    );
    chmodSync(node, 0o755);
    const rendered = step.run
      .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, dir)
      .replace(/\$\{\{\s*inputs\.([A-Za-z0-9-]+)\s*\}\}/g, (_, name: string) => inputs[name] ?? "");
    const result = spawnSync("bash", ["-c", rendered], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: output,
      },
    });
    const argv = existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
      : [];
    if (argv.length === 0) {
      throw new Error(`action script produced no argv\n${result.stderr}\n${rendered}`);
    }
    return argv;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("GitHub Action args", () => {
  it("appends args after --no-user and opts back in with include-user", () => {
    const doc = loadAction();
    expect(doc.inputs.args?.default).toBe("");
    expect(doc.inputs.args?.description ?? "").toMatch(/additional/i);
    expect(doc.inputs.args?.description ?? "").toMatch(/does not replace --no-user/i);
    expect(doc.inputs["include-user"]?.default).toBe("false");
    expect(doc.inputs["include-user"]?.description ?? "").toMatch(/--no-user/);

    const defaults = runStep({});
    expect(defaults).toContain("--no-user");
    expect(defaults.filter((arg) => arg === "--no-user")).toEqual(["--no-user"]);
    expect(defaults).toContain("--allow-missing");
    expect(defaults).toContain("--github-annotations");
    expect(defaults).toContain("--sarif");
    expect(defaults).toContain("mcp-health.sarif");
    expect(defaults.at(-1)).toBe(".");

    const probe = runStep({ args: "--probe" });
    expect(probe).toContain("--no-user");
    expect(probe).toContain("--probe");
    expect(probe.filter((arg) => arg === "--no-user")).toEqual(["--no-user"]);

    const online = runStep({ args: "--online --probe" });
    expect(online).toContain("--no-user");
    expect(online).toContain("--online");
    expect(online).toContain("--probe");

    const explicit = runStep({ args: "--no-user --probe" });
    expect(explicit.filter((arg) => arg === "--no-user").length).toBeGreaterThan(0);
    expect(explicit).toContain("--probe");

    const user = runStep({ "include-user": "true" });
    expect(user).not.toContain("--no-user");
    expect(user).toContain("--allow-missing");
    expect(user).toContain("--github-annotations");

    const userOnline = runStep({ "include-user": "true", args: "--online" });
    expect(userOnline).not.toContain("--no-user");
    expect(userOnline).toContain("--online");

    const userStillSkipped = runStep({
      "include-user": "true",
      args: "--no-user --online",
    });
    expect(userStillSkipped).toContain("--no-user");
    expect(userStillSkipped).toContain("--online");

    const strictMissing = runStep({ "fail-on-missing": "true" });
    expect(strictMissing).not.toContain("--allow-missing");
    expect(strictMissing).toContain("--no-user");

    const quiet = runStep({ annotations: "false", "sarif-file": "false" });
    expect(quiet).not.toContain("--github-annotations");
    expect(quiet).not.toContain("--sarif");
    expect(quiet).toContain("--no-user");

    const readme = readFileSync(join(repo, "README.md"), "utf8");
    expect(readme).toContain("`args` are additional flags");
    expect(readme).toContain("include-user: true");
    expect(readme).toContain("does not remove `--no-user`");
    expect(readme).toContain("args: --probe");
  });

  it("accepts a repeated --no-user from the action plus args", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-dup-no-user-"));
    try {
      const tsx = join(repo, "node_modules", ".bin", "tsx");
      const result = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--no-user", "--json", dir],
        { encoding: "utf8" },
      );
      expect(result.stderr).not.toMatch(/error:/i);
      expect(result.stdout).toContain("NO_CONFIG");
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
