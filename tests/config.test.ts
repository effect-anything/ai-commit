import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultScopeForKey, normalizeValue, resolveKey } from "../src/config/keys.ts";
import { loadProjectConfig } from "../src/config/project.ts";

const tempDirs: Array<string> = [];

const runEffect = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer) as Effect.Effect<A, unknown, never>);

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("config keys", () => {
  it("normalizes kebab-case aliases", () => {
    expect(resolveKey("api-key")).toBe("api_key");
    expect(resolveKey("max-diff-lines")).toBe("max_diff_lines");
  });

  it("defaults provider keys to user scope", () => {
    expect(defaultScopeForKey("api_key")).toBe("user");
    expect(defaultScopeForKey("hook")).toBe("project");
  });

  it("normalizes slice values", () => {
    expect(normalizeValue("hook", "conventional, empty")).toBe("conventional,empty");
  });

  it("fails when project config contains malformed hook values", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ai-commit-config-"));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".ai-commit"), { recursive: true });
    writeFileSync(join(repoRoot, ".ai-commit", "config.yml"), "hook: 123\n");

    await expect(runEffect(loadProjectConfig(repoRoot))).rejects.toMatchObject({
      message: expect.stringContaining("invalid config"),
    });
    await expect(runEffect(loadProjectConfig(repoRoot))).rejects.toMatchObject({
      message: expect.stringContaining("hook"),
    });
  });
});
