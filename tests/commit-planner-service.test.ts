import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { emptyProjectConfig } from "../src/domain/project.ts";
import {
  CommitPlannerService,
  CommitPlannerServiceLive,
  type PlanCommitsInput,
} from "../src/services/commit-service.ts";
import { LlmClient } from "../src/services/openai-client.ts";

const makeInput = (overrides: Partial<PlanCommitsInput> = {}): PlanCommitsInput => ({
  provider: {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    noGitAgentCoAuthor: false,
    noModelCoAuthor: false,
  },
  stagedFiles: ["src/staged.ts"],
  unstagedFiles: ["src/unstaged.ts"],
  intent: undefined,
  config: emptyProjectConfig(),
  ...overrides,
});

describe("CommitPlannerService", () => {
  layer(Layer.empty)((it) => {
    it.effect(
      "includes staged and unstaged files in the prompt and decodes grouped output",
      Effect.fn(function* () {
        const prompts: Array<string> = [];

        const llmLayer = Layer.succeed(LlmClient, {
          call: (input) =>
            Effect.sync(() => {
              prompts.push(input.userPrompt);
              return JSON.stringify({
                groups: [
                  {
                    files: ["src/staged.ts"],
                    title: "feat(core): stage first",
                    bullets: ["Keep staged work together"],
                    explanation: "Uses the user-selected staged file.",
                  },
                  {
                    files: ["src/unstaged.ts"],
                    title: "feat(core): handle rest",
                    bullets: ["Handle unstaged work"],
                    explanation: "Adds the unstaged change separately.",
                  },
                ],
              });
            }),
        });

        const plan = yield* Effect.gen(function* () {
          const service = yield* CommitPlannerService;
          return yield* service.plan(makeInput());
        }).pipe(Effect.provide(CommitPlannerServiceLive.pipe(Layer.provide(llmLayer))));

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Staged files");
        expect(prompts[0]).toContain("src/staged.ts");
        expect(prompts[0]).toContain("src/unstaged.ts");
        expect(plan.groups).toHaveLength(2);
        expect(plan.groups[0]?.message?.title).toBe("feat(core): stage first");
      }),
    );
  });
});
