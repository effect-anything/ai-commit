import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultScopeForKey, normalizeValue, resolveKey } from "../src/config/keys.ts";
import { ConfigService, ConfigServiceLive } from "../src/config/service.ts";

const configEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

const tempDirs: Array<string> = [];

const runEffect = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      ConfigServiceLive.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: configEnv }))),
      ),
    ) as Effect.Effect<A, unknown, never>,
  );

const loadProjectConfig = (repoRoot: string) =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return yield* config.loadProjectConfig(repoRoot);
  });

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
    expect(Effect.runSync(resolveKey("api-key"))).toBe("api_key");
    expect(Effect.runSync(resolveKey("max-diff-lines"))).toBe("max_diff_lines");
  });

  it("defaults provider keys to user scope", () => {
    expect(defaultScopeForKey("api_key")).toBe("user");
    expect(defaultScopeForKey("hook")).toBe("project");
  });

  it("normalizes slice values", () => {
    expect(Effect.runSync(normalizeValue("hook", "conventional, empty"))).toBe(
      "conventional,empty",
    );
  });

  it("fails when project config contains malformed hook values", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ai-commit-config-"));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".ai-commit"), { recursive: true });
    writeFileSync(join(repoRoot, ".ai-commit", "config.json"), '{\n  "hook": 123\n}\n');

    await expect(runEffect(loadProjectConfig(repoRoot))).rejects.toMatchObject({
      message: expect.stringContaining("invalid config"),
    });
    await expect(runEffect(loadProjectConfig(repoRoot))).rejects.toMatchObject({
      message: expect.stringContaining("hook"),
    });
  });

  it("loads no_commit_co_author from project config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ai-commit-config-"));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".ai-commit"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".ai-commit", "config.json"),
      '{\n  "no_commit_co_author": true,\n  "no_model_co_author": true\n}\n',
    );

    await expect(runEffect(loadProjectConfig(repoRoot))).resolves.toMatchObject({
      noCommitCoAuthor: true,
      noModelCoAuthor: true,
    });
  });
});
