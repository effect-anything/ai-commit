import * as OpenAi from "@effect/ai-openai";
import { DateTime, Duration, Effect, Layer, Redacted, Schedule } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import type { CommitMessage, CommitPlan } from "../domain/commit";
import type { ProjectConfig, ProjectScope } from "../domain/project";
import { ApiError } from "../shared/errors";
import { extractJson, wrapExplanation } from "../shared/text";
import type { VcsDiff } from "./vcs";

export interface ProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

const llmInvalidOutputRetrySchedule = Schedule.either(
  Schedule.exponential("300 millis"),
  Schedule.spaced("1 second"),
).pipe(
  Schedule.jittered,
  Schedule.take(2),
  Schedule.delays,
  Schedule.tapOutput((delay) =>
    Effect.gen(function* () {
      const retryAt = DateTime.addDuration(yield* DateTime.now, delay);
      yield* Effect.annotateCurrentSpan({
        retry_delay: Duration.format(delay).replace(/\s+\d+ns$/, ""),
        retry_at: DateTime.formatIso(retryAt),
      });
    }),
  ),
);

const llmTransientRetrySchedule = Schedule.either(
  Schedule.exponential("250 millis"),
  Schedule.spaced("2 seconds"),
).pipe(
  Schedule.jittered,
  Schedule.take(2),
  Schedule.delays,
  Schedule.tapOutput((delay) =>
    Effect.gen(function* () {
      const retryAt = DateTime.addDuration(yield* DateTime.now, delay);
      yield* Effect.annotateCurrentSpan({
        retry_delay: Duration.format(delay).replace(/\s+\d+ns$/, ""),
        retry_at: DateTime.formatIso(retryAt),
      });
    }),
  ),
);

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
          reasoning: {
            effort: "low",
          },
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
          HttpClient.retryTransient(client, {
            schedule: llmTransientRetrySchedule,
          }),
      }),
    ),
  );

const callLlm = (config: ProviderConfig, system: string, user: string, maxOutputTokens: number) =>
  LanguageModel.generateText({
    prompt: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    toolChoice: "none",
  }).pipe(
    Effect.map((response) => response.text.trim()),
    Effect.flatMap((text) =>
      text.length > 0
        ? Effect.succeed(text)
        : Effect.failSync(
            () =>
              new ApiError({
                message: `LLM returned empty response (model=${config.model})`,
              }),
          ),
    ),
    Effect.provide(makeLanguageModelLayer(config, maxOutputTokens)),
    Effect.catch((cause) =>
      ApiError.is(cause)
        ? Effect.failSync(() => cause)
        : Effect.failSync(
            () =>
              new ApiError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
    ),
  );

const formatScopes = (config: ProjectConfig): string =>
  config.scopes
    .map((scope) =>
      scope.description == null ? scope.name : `${scope.name} — ${scope.description}`,
    )
    .join("\n- ");

const generateSystemPrompt =
  'You are an expert software engineer. Generate a conventional commit message from the provided git diff. Respond ONLY with valid JSON in this exact format: {"title": "...", "bullets": ["Bullet one", "Bullet two"], "explanation": "Explanation paragraph."}. Rules: title uses conventional commits format with one of these types: feat, fix, docs, style, refactor, perf, test, chore, build, ci, revert - all lowercase, 50 chars or fewer, imperative mood; scope is optional, omit if no clear scope applies; bullets start with uppercase and stay within 72 chars; explanation is sentence case and wrapped to 72 characters.';

const generateSystemPromptScoped =
  'You are an expert software engineer. Generate a conventional commit message from the provided git diff. Respond ONLY with valid JSON in this exact format: {"title": "...", "bullets": ["Bullet one", "Bullet two"], "explanation": "Explanation paragraph."}. Rules: title uses conventional commits format with one of these types: feat, fix, docs, style, refactor, perf, test, chore, build, ci, revert - all lowercase, 50 chars or fewer, imperative mood; REQUIRED scope - you must use one of the scopes listed in the user message; bullets start with uppercase and stay within 72 chars; explanation is sentence case and wrapped to 72 characters.';

const retrySystemPrompt =
  'You are an expert software engineer. Fix the commit message to satisfy the hook requirement. Respond ONLY with valid JSON: {"title": "...", "bullets": ["Bullet one", "Bullet two"], "explanation": "Explanation paragraph."}. Title: conventional commits format, lowercase, 50 chars or fewer. Bullets: uppercase first letter, imperative mood, 72 chars or fewer. Explanation: sentence case, 72 chars or fewer.';

const planSystemPrompt =
  'You are an expert software engineer. Analyse the provided file paths and split them into meaningful atomic commits. If a PRIMARY DIRECTIVE is given, it is the most important constraint: only include files directly relevant to it; put those files in group 0; leave unrelated files out. If there are staged files and no primary directive, they must be group 0. Respond ONLY with valid JSON: {"groups": [{"files": ["..."], "title": "type(scope): description", "bullets": ["Bullet one"], "explanation": "Explanation."}]}';

const planSystemPromptScoped =
  'You are an expert software engineer. Analyse the provided file paths and split them into meaningful atomic commits. If a PRIMARY DIRECTIVE is given, it is the most important constraint: only include files directly relevant to it; put those files in group 0; leave unrelated files out. If there are staged files and no primary directive, they must be group 0. REQUIRED scope - every title must use one of the scopes listed in the user message. Respond ONLY with valid JSON: {"groups": [{"files": ["..."], "title": "type(scope): description", "bullets": ["Bullet one"], "explanation": "Explanation."}]}';

const detectTechSystemPrompt =
  'You are an expert software engineer. Analyze the project\'s OS, directories, and files to detect which technologies are used. Return a JSON object with a technologies array containing only valid Toptal gitignore API identifiers. Respond ONLY with valid JSON: {"technologies": ["go", "node", "visualstudiocode"]}';

const generateScopesSystemPrompt =
  'You are an expert software engineer. Derive commit scopes from the top-level directories of the project, using commit history to validate and refine them. Respond ONLY with valid JSON: {"scopes": [{"name": "...", "description": "..."}], "reasoning": "..."}. Scope names must be short, lowercase, and must not be commit types.';

const isRetryableInvalidModelOutput = (error: ApiError): boolean =>
  error.message.startsWith("failed to parse model JSON:") ||
  error.message.startsWith("LLM returned empty ");

const parseJson = <A>(raw: string, wrapKey?: string): Effect.Effect<A, ApiError> => {
  const cleaned = extractJson(raw);
  return Effect.try({
    try: () => {
      try {
        return JSON.parse(cleaned) as A;
      } catch (error) {
        if (wrapKey != null && cleaned.startsWith("[")) {
          return JSON.parse(`{"${wrapKey}":${cleaned}}`) as A;
        }
        throw error;
      }
    },
    catch: (error) =>
      new ApiError({
        message: `failed to parse model JSON: ${error instanceof Error ? error.message : String(error)}`,
        body: cleaned,
      }),
  });
};

export interface GenerateCommitMessageInput {
  readonly provider: ProviderConfig;
  readonly diff: VcsDiff;
  readonly intent: string | undefined;
  readonly config: ProjectConfig;
  readonly hookFeedback: string | undefined;
  readonly previousMessage: string | undefined;
}

export const generateCommitMessage = Effect.fn(function* ({
  provider,
  diff,
  intent,
  config,
  hookFeedback,
  previousMessage,
}: GenerateCommitMessageInput) {
  const hasScopes = config.scopes.length > 0;
  const systemPrompt =
    previousMessage != null && hookFeedback != null
      ? retrySystemPrompt
      : hasScopes
        ? generateSystemPromptScoped
        : generateSystemPrompt;

  const promptParts: Array<string> = [];
  if (previousMessage != null && hookFeedback != null) {
    promptParts.push(`Fix the following commit message:\n\n${previousMessage}`);
    promptParts.push(`The commit hook rejected it for this reason:\n${hookFeedback}`);
    promptParts.push(
      "Rewrite the message to satisfy the requirement. Keep the semantic content unchanged.",
    );
  } else {
    if (typeof intent === "string" && intent.trim().length > 0) {
      promptParts.push(`PRIMARY DIRECTIVE - focus only on this: ${intent.trim()}`);
    }
    if (hasScopes) {
      promptParts.push(
        `REQUIRED scopes (use the most appropriate one):\n- ${formatScopes(config)}`,
      );
    }
    promptParts.push(
      `Git diff:\n<diff>\n${diff.content}\n</diff>\n\nStaged files: ${diff.files.join(", ")}`,
    );
    if (typeof hookFeedback === "string" && hookFeedback.trim().length > 0) {
      promptParts.push(
        `Previous attempt was rejected by the commit hook. Reason:\n${hookFeedback.trim()}`,
      );
    }
  }

  return yield* Effect.gen(function* () {
    const raw = yield* callLlm(provider, systemPrompt, promptParts.join("\n\n"), 4096);
    const parsed = yield* parseJson<{
      title?: string;
      bullets?: Array<string>;
      explanation?: string;
    }>(raw);

    if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
      return yield* new ApiError({
        message: "LLM returned empty commit message",
        body: raw,
      });
    }

    return {
      title: parsed.title.trim(),
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
          )
        : [],
      explanation: wrapExplanation(
        typeof parsed.explanation === "string" ? parsed.explanation.trim() : "",
      ),
    } satisfies CommitMessage;
  }).pipe(
    Effect.retry({
      while: (error) => ApiError.is(error) && isRetryableInvalidModelOutput(error),
      schedule: llmInvalidOutputRetrySchedule,
    }),
  );
});

export interface PlanCommitsInput {
  readonly provider: ProviderConfig;
  readonly stagedFiles: ReadonlyArray<string>;
  readonly unstagedFiles: ReadonlyArray<string>;
  readonly intent: string | undefined;
  readonly config: ProjectConfig;
}

export const planCommits = Effect.fn(function* ({
  provider,
  stagedFiles,
  unstagedFiles,
  intent,
  config,
}: PlanCommitsInput) {
  const hasScopes = config.scopes.length > 0;
  const promptParts: Array<string> = [];
  if (typeof intent === "string" && intent.trim().length > 0) {
    promptParts.push(`PRIMARY DIRECTIVE - focus only on this: ${intent.trim()}`);
  }
  if (hasScopes) {
    promptParts.push(
      `REQUIRED scopes (use the most appropriate one per group):\n- ${formatScopes(config)}`,
    );
  }
  if (stagedFiles.length > 0) {
    promptParts.push(
      `Staged files (already selected by user - keep as group 0):\n${stagedFiles.join("\n")}`,
    );
  }
  if (unstagedFiles.length > 0) {
    promptParts.push(`Unstaged files:\n${unstagedFiles.join("\n")}`);
  }

  return yield* Effect.gen(function* () {
    const raw = yield* callLlm(
      provider,
      hasScopes ? planSystemPromptScoped : planSystemPrompt,
      promptParts.join("\n\n"),
      8192,
    );

    const parsed = yield* parseJson<{
      groups?: Array<{
        files?: Array<string>;
        title?: string;
        bullets?: Array<string>;
        explanation?: string;
      }>;
    }>(raw, "groups");

    const groups =
      parsed.groups?.map((group) => ({
        files: Array.isArray(group.files)
          ? group.files.filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : [],
        message:
          typeof group.title === "string" && group.title.trim().length > 0
            ? {
                title: group.title.trim(),
                bullets: Array.isArray(group.bullets)
                  ? group.bullets.filter(
                      (item): item is string => typeof item === "string" && item.trim().length > 0,
                    )
                  : [],
                explanation: wrapExplanation(
                  typeof group.explanation === "string" ? group.explanation.trim() : "",
                ),
              }
            : undefined,
      })) ?? [];

    if (groups.length === 0) {
      return yield* new ApiError({
        message: "LLM returned empty plan",
        body: raw,
      });
    }

    return {
      groups,
    } satisfies CommitPlan;
  }).pipe(
    Effect.retry({
      while: (error) => ApiError.is(error) && isRetryableInvalidModelOutput(error),
      schedule: llmInvalidOutputRetrySchedule,
    }),
  );
});

export const detectTechnologies = Effect.fn(function* (
  provider: ProviderConfig,
  osName: string,
  dirs: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
) {
  return yield* Effect.gen(function* () {
    const raw = yield* callLlm(
      provider,
      detectTechSystemPrompt,
      `OS: ${osName}\n\nTop-level directories:\n${dirs.join("\n")}\n\nTracked files:\n${files.join("\n")}`,
      1024,
    );
    const parsed = yield* parseJson<{ technologies?: Array<string> }>(raw, "technologies");
    const technologies =
      parsed.technologies?.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ) ?? [];
    if (technologies.length === 0) {
      return yield* new ApiError({
        message: "LLM returned empty technologies",
        body: raw,
      });
    }
    return technologies;
  }).pipe(
    Effect.retry({
      while: (error) => ApiError.is(error) && isRetryableInvalidModelOutput(error),
      schedule: llmInvalidOutputRetrySchedule,
    }),
  );
});

export const generateScopes = Effect.fn(function* (
  provider: ProviderConfig,
  commits: ReadonlyArray<string>,
  dirs: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
) {
  return yield* Effect.gen(function* () {
    const raw = yield* callLlm(
      provider,
      generateScopesSystemPrompt,
      `Commit log (subject + changed files):\n${commits.join("\n---\n")}\n\nTop-level directories:\n${dirs.join("\n")}\n\nTracked files:\n${files.join("\n")}`,
      8192,
    );
    const parsed = yield* parseJson<{ scopes?: Array<ProjectScope> }>(raw, "scopes");
    const scopes =
      parsed.scopes?.filter(
        (scope): scope is ProjectScope =>
          typeof scope === "object" &&
          scope != null &&
          typeof scope.name === "string" &&
          scope.name.trim().length > 0,
      ) ?? [];
    if (scopes.length === 0) {
      return yield* new ApiError({
        message: "LLM returned empty scopes",
        body: raw,
      });
    }
    return scopes.map((scope) => ({
      name: scope.name.trim(),
      ...(typeof scope.description === "string" && scope.description.trim().length > 0
        ? { description: scope.description.trim() }
        : {}),
    }));
  }).pipe(
    Effect.retry({
      while: (error) => ApiError.is(error) && isRetryableInvalidModelOutput(error),
      schedule: llmInvalidOutputRetrySchedule,
    }),
  );
});
