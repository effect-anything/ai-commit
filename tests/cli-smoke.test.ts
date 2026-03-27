import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const tempDirs: Array<string> = [];

const runCli = (
  args: ReadonlyArray<string>,
  options?:
    | {
        readonly cwd?: string | undefined;
        readonly env?: Record<string, string | undefined> | undefined;
      }
    | undefined,
) =>
  spawnSync("node", ["src/cli.ts", ...args], {
    cwd: options?.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options?.env,
    },
  });

const newGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ai-commit-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe.concurrent("cli smoke", () => {
  it("prints the package version", () => {
    const result = runCli(["version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(result.stderr).toBe("");
  });

  it("does not leak ShowHelp internals when invoked without a subcommand", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stderr).not.toContain("~effect/cli/CliError/ShowHelp");
    expect(result.stderr).not.toContain("Help requested");
  });

  it("does not leak ShowHelp internals for unknown subcommands", () => {
    const result = runCli(["wat"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown subcommand "wat" for "ai-commit"');
    expect(result.stderr).not.toContain("~effect/cli/CliError/ShowHelp");
    expect(result.stderr).not.toContain("Help requested");
  });

  it("config get prefers local hook over project hook", () => {
    const dir = newGitRepo();
    mkdirSync(join(dir, ".ai-commit"), { recursive: true });
    writeFileSync(join(dir, ".ai-commit", "config.yml"), "hook:\n  - conventional\n");
    writeFileSync(join(dir, ".ai-commit", "config.local.yml"), "hook:\n  - empty\n");

    const result = runCli(["config", "get", "--cwd", dir, "hook"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("empty");
    expect(result.stdout).toContain("local");
  });

  it("fails when config set hook points to a missing file", () => {
    const dir = newGitRepo();
    const result = runCli([
      "config",
      "set",
      "--cwd",
      dir,
      "--scope",
      "project",
      "hook",
      join(dir, "missing-hook.sh"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reading hook file");
  });

  it("config show resolves provider settings from environment", () => {
    const dir = newGitRepo();
    const xdgHome = mkdtempSync(join(tmpdir(), "ai-commit-xdg-"));
    tempDirs.push(xdgHome);

    const result = runCli(["config", "show", "--cwd", dir], {
      env: {
        XDG_CONFIG_HOME: xdgHome,
        OPENAI_COMPACT_API_KEY: "",
        OPENAI_COMPACT_API_BASE_URL: "",
        OPENAI_COMPACT_MODEL: "",
        GIT_AGENT_BUILD_API_KEY: "",
        GIT_AGENT_BUILD_BASE_URL: "https://build.example/v1",
        GIT_AGENT_BUILD_MODEL: "build-model",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("api_key:  (not set)");
    expect(result.stdout).toContain("model:    build-model");
    expect(result.stdout).toContain("base_url: https://build.example/v1");
  });

  it("init --local rejects runs that do not request any action", () => {
    const dir = newGitRepo();
    const result = runCli(["init", "--cwd", dir, "--local"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--local requires at least one action flag");
  });

  it("init --local reports the local config path when it already exists", () => {
    const dir = newGitRepo();
    mkdirSync(join(dir, ".ai-commit"), { recursive: true });
    writeFileSync(join(dir, ".ai-commit", "config.local.yml"), "hook:\n  - conventional\n");

    const result = runCli(["init", "--cwd", dir, "--local", "--hook", "conventional"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, ".ai-commit", "config.local.yml"));
    expect(result.stderr).not.toContain(join(dir, ".ai-commit", "config.yml"));
  });
});
