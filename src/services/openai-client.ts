import * as OpenAi from "@effect/ai-openai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Effect, Layer, pipe, Redacted, Schedule, ServiceMap } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import type { ProviderConfig } from "../config/provider.ts";
export type { ProviderConfig } from "../config/provider.ts";
import { ApiError } from "../shared/errors.ts";

const llmTransientRetrySchedule = Schedule.either(
  Schedule.exponential("250 millis"),
  Schedule.spaced("2 seconds"),
).pipe(Schedule.jittered, Schedule.take(2));

const normalizeModelId = (model: string): string =>
  model
    .trim()
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1) ?? "";

export const isReasoningModel = (model: string): boolean => {
  const modelId = normalizeModelId(model);

  return (
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4-mini") ||
    modelId.startsWith("codex-mini") ||
    modelId.startsWith("computer-use-preview") ||
    (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat"))
  );
};

const makeLanguageModelLayer = (config: ProviderConfig, maxOutputTokens: number) =>
  OpenAi.OpenAiLanguageModel.layer({
    model: config.model,
    config: isReasoningModel(config.model)
      ? {
          max_output_tokens: maxOutputTokens,
          reasoning: { effort: "low" },
          temperature: 0,
        }
      : {
          max_output_tokens: maxOutputTokens,
          temperature: 0,
        },
  }).pipe(
    Layer.provide(
      OpenAi.OpenAiClient.layer({
        apiKey: Redacted.make(config.apiKey),
        apiUrl: config.baseUrl,
        transformClient: (client) =>
          HttpClient.retryTransient(client, { schedule: llmTransientRetrySchedule }),
      }),
    ),
  );

export interface LlmCallInput {
  readonly provider: ProviderConfig;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
}

export interface LlmClientService {
  readonly call: (input: LlmCallInput) => Effect.Effect<string, ApiError | AiError.AiError>;
}

export class LlmClient extends ServiceMap.Service<LlmClient, LlmClientService>()(
  "@ai-commit/LlmClient",
) {}

export const LlmClientLive = Layer.effect(
  LlmClient,
  Effect.gen(function* () {
    const call: LlmClientService["call"] = Effect.fn("LLM.call")(function* ({
      provider,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
    }: LlmCallInput) {
      const runtimeLayer = makeLanguageModelLayer(provider, maxOutputTokens).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
      );

      const text = yield* pipe(
        LanguageModel.generateText({
          prompt: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          toolChoice: "none",
        }),
        Effect.map((response) => response.text.trim()),
        Effect.provide(runtimeLayer),
      );

      return text;
    });

    return {
      call,
    } satisfies LlmClientService;
  }),
);
