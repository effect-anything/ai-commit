import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { ProviderConfig } from "../src/config/provider.ts";
import { LlmClient } from "../src/services/openai-client.ts";
import { ScopeService, ScopeServiceLive } from "../src/services/scope-service.ts";
import type { VcsClient } from "../src/services/vcs.ts";

const provider: ProviderConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.test/v1",
  model: "test-model",
  noGitAgentCoAuthor: false,
  noModelCoAuthor: false,
};

const vcs: VcsClient = {
  kind: "git",
  supportsStaging: true,
  isRepo: () => Effect.succeed(true),
  initRepo: () => Effect.succeed(""),
  repoRoot: () => Effect.succeed("/repo"),
  stagedDiff: () => Effect.die("not used"),
  unstagedDiff: () => Effect.die("not used"),
  diffForFiles: () => Effect.die("not used"),
  addAll: () => Effect.die("not used"),
  stageFiles: () => Effect.die("not used"),
  unstageAll: () => Effect.die("not used"),
  commit: () => Effect.die("not used"),
  amendCommit: () => Effect.die("not used"),
  lastCommitDiff: () => Effect.die("not used"),
  formatTrailers: () => Effect.die("not used"),
  commitLog: () => Effect.succeed(["feat(api): add route"]),
  topLevelDirs: () => Effect.succeed(["api", "web"]),
  projectFiles: () => Effect.succeed(["api/routes.ts", "web/page.tsx"]),
};

describe("ScopeService", () => {
  layer(Layer.empty)((it) => {
    it.effect(
      "filters out conventional commit types from generated scopes",
      Effect.fn(function* () {
        const llmLayer = Layer.succeed(LlmClient, {
          call: () =>
            Effect.succeed(
              JSON.stringify({
                scopes: [
                  { name: "feat", description: "Should be filtered" },
                  { name: "api", description: "Backend API handlers" },
                ],
              }),
            ),
        });

        const scopes = yield* Effect.gen(function* () {
          const service = yield* ScopeService;
          return yield* service.generateProjectScopes({
            provider,
            vcs,
            cwd: "/repo",
            maxCommits: 10,
          });
        }).pipe(Effect.provide(ScopeServiceLive.pipe(Layer.provide(llmLayer))));

        expect(scopes).toEqual([{ name: "api", description: "Backend API handlers" }]);
      }),
    );
  });
});
