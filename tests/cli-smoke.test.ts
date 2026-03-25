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
  it("prints bash completion script via the compatibility subcommand", () => {
    const result = runCli(["completion", "bash"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("###-begin-git-agent-completions-###");
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
});
