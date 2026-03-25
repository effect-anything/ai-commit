import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeHooks, type HookInput } from "../src/services/hooks";

const runEffect = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer) as Effect.Effect<A, unknown, never>);

const hookInput: HookInput = {
  diff: "",
  commitMessage:
    "feat(core): add hook tests\n\n- Add hook coverage\n\nThis verifies hook execution.",
  intent: undefined,
  stagedFiles: [],
  config: {
    scopes: [],
    hooks: [],
    maxDiffLines: 0,
    noGitAgentCoAuthor: false,
    noModelCoAuthor: false,
  },
};

const tempDirs: Array<string> = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("executeHooks", () => {
  it("fails when a configured shell hook is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-agent-hooks-"));
    tempDirs.push(dir);
    const hookPath = join(dir, "missing-hook.sh");

    await expect(runEffect(executeHooks([hookPath], hookInput))).rejects.toMatchObject({
      message: expect.stringContaining(`failed to read hook "${hookPath}"`),
    });
  });

  it("fails for non-executable hook files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-agent-hooks-"));
    tempDirs.push(dir);
    const hookPath = join(dir, "hook.sh");
    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    chmodSync(hookPath, 0o644);

    await expect(runEffect(executeHooks([hookPath], hookInput))).rejects.toMatchObject({
      message: `hook is not executable: ${hookPath}`,
    });
  });
});
