import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { HookService, HookServiceLive, type HookInput } from "../src/services/hooks.ts";

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
    noCommitCoAuthor: false,
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

describe("HookService", () => {
  layer(HookServiceLive.pipe(Layer.provide(NodeServices.layer)))((it) => {
    it.effect(
      "fails when a configured shell hook is missing",
      Effect.fn(function* () {
        const dir = mkdtempSync(join(tmpdir(), "ai-commit-hooks-"));
        tempDirs.push(dir);
        const hookPath = join(dir, "missing-hook.sh");
        const hookService = yield* HookService;

        const error = yield* Effect.flip(hookService.execute([hookPath], hookInput));

        expect(error.message).toContain(`failed to read hook "${hookPath}"`);
      }),
    );

    it.effect(
      "fails for non-executable hook files",
      Effect.fn(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gai-commit-hooks-"));
        tempDirs.push(dir);
        const hookPath = join(dir, "hook.sh");
        writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
        chmodSync(hookPath, 0o644);
        const hookService = yield* HookService;

        const error = yield* Effect.flip(hookService.execute([hookPath], hookInput));

        expect(error.message).toBe(`hook is not executable: ${hookPath}`);
      }),
    );
  });
});
