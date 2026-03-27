import { describe, expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { emptyProjectConfig } from "../src/domain/project.ts";
import {
  CommitMessageService,
  CommitMessageServiceLive,
  type GenerateCommitMessageInput,
} from "../src/services/commit-service.ts";
import { LlmClient } from "../src/services/openai-client.ts";

const makeInput = (
  overrides: Partial<GenerateCommitMessageInput> = {},
): GenerateCommitMessageInput => ({
  provider: {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    noCommitCoAuthor: false,
    noModelCoAuthor: false,
  },
  diff: {
    files: ["src/app.ts"],
    content: "diff --git a/src/app.ts b/src/app.ts\n+export const value = 1;\n",
    lines: 2,
  },
  intent: undefined,
  config: emptyProjectConfig(),
  hookFeedback: undefined,
  previousMessage: undefined,
  ...overrides,
});

describe.concurrent("CommitMessageService", () => {
  layer(Layer.empty)((it) => {
    it.effect(
      "retries invalid model output and parses the next valid response",
      Effect.fn(function* () {
        let callCount = 0;

        const llmLayer = Layer.mock(LlmClient, {
          call: () =>
            Effect.sync(() => {
              callCount += 1;
              return callCount === 1
                ? "not-json"
                : JSON.stringify({
                    title: "feat(core): add flow",
                    bullets: ["Add flow"],
                    explanation: "Adds flow.",
                  });
            }),
        });

        const messageFiber = yield* Effect.gen(function* () {
          const service = yield* CommitMessageService;
          return yield* service.generate(makeInput());
        }).pipe(
          Effect.provide(CommitMessageServiceLive.pipe(Layer.provide(llmLayer))),
          Effect.forkChild,
        );

        yield* TestClock.adjust("10 seconds");

        const message = yield* Fiber.join(messageFiber);

        expect(callCount).toBe(2);
        expect(message.title).toBe("feat(core): add flow");
        expect(message.bullets).toEqual(["Add flow"]);
      }),
    );

    it.effect(
      "switches to hook-fix prompting when previous message and hook feedback exist",
      Effect.fn(function* () {
        const prompts: Array<string> = [];

        const llmLayer = Layer.mock(LlmClient, {
          call: (input) =>
            Effect.sync(() => {
              prompts.push(input.userPrompt);
              return JSON.stringify({
                title: "fix(core): satisfy hook",
                bullets: ["Fix hook issue"],
                explanation: "Keeps the original meaning.",
              });
            }),
        });

        yield* Effect.gen(function* () {
          const service = yield* CommitMessageService;
          return yield* service.generate(
            makeInput({
              hookFeedback: "scope is required",
              previousMessage: "fix: old title",
            }),
          );
        }).pipe(Effect.provide(CommitMessageServiceLive.pipe(Layer.provide(llmLayer))));

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Fix the following commit message");
        expect(prompts[0]).toContain("scope is required");
      }),
    );
  });
});
