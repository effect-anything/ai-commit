import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const tempDirs: Array<string> = [];

const runCli = (args: ReadonlyArray<string>) =>
  spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

const newGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "git-agent-cli-"));
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

describe("cli smoke", () => {
  it("prints the package version", () => {
    const result = runCli(["version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
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
    expect(result.stderr).toContain('Unknown subcommand "wat" for "git-agent"');
    expect(result.stderr).not.toContain("~effect/cli/CliError/ShowHelp");
    expect(result.stderr).not.toContain("Help requested");
  });

  it("config get prefers local hook over project hook", () => {
    const dir = newGitRepo();
    mkdirSync(join(dir, ".git-agent"), { recursive: true });
    writeFileSync(join(dir, ".git-agent", "config.yml"), "hook:\n  - conventional\n");
    writeFileSync(join(dir, ".git-agent", "config.local.yml"), "hook:\n  - empty\n");

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

  it("init --local reports the local config path when it already exists", () => {
    const dir = newGitRepo();
    mkdirSync(join(dir, ".git-agent"), { recursive: true });
    writeFileSync(join(dir, ".git-agent", "config.local.yml"), "hook:\n  - conventional\n");

    const result = runCli(["init", "--cwd", dir, "--local", "--hook", "conventional"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, ".git-agent", "config.local.yml"));
    expect(result.stderr).not.toContain(join(dir, ".git-agent", "config.yml"));
  });
});
