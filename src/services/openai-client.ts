import * as OpenAi from "@effect/ai-openai";
import {
  DateTime,
  Duration,
  Effect,
  identity,
  Layer,
  pipe,
  Redacted,
  Schedule,
  Schema,
  SchemaTransformation,
} from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import type { ProviderConfig } from "../config/provider.ts";
export type { ProviderConfig } from "../config/provider.ts";
import type { CommitMessage, CommitPlan } from "../domain/commit.ts";
import type { ProjectConfig } from "../domain/project.ts";
import { ProjectScope } from "../domain/project.ts";
import { ApiError } from "../shared/errors.ts";
import { extractJson, wrapExplanation } from "../shared/text.ts";
import type { VcsDiff } from "./vcs.ts";

const llmInvalidOutputRetrySchedule = Schedule.either(
  Schedule.exponential("300 millis"),
  Schedule.spaced("1 second"),
).pipe(
  Schedule.take(2),
  Schedule.delays,
  Schedule.tapOutput(
    Effect.fn(function* (delay) {
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
  Schedule.tapOutput(
    Effect.fn(function* (delay) {
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

// TODO: refactor to layer

const callLlm = Effect.fn("LLM.call")(function* (
  config: ProviderConfig,
  system: string,
  user: string,
  maxOutputTokens: number,
) {
  const text = yield* pipe(
    LanguageModel.generateText({
      prompt: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      toolChoice: "none",
    }),
    Effect.map((response) => response.text.trim()),
    Effect.provide(makeLanguageModelLayer(config, maxOutputTokens)),
  );

  return text;
});

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

const isRetryableInvalidModelOutput = (error: ApiError | AiError.AiError): boolean =>
  ApiError.is(error) || (AiError.isAiError(error) && error.reason.isRetryable);

const TrimmedString = Schema.String.pipe(Schema.decode(SchemaTransformation.trim()));
const NonEmptyTrimmedString = TrimmedString.check(Schema.isNonEmpty());

const compactStrings = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.filter((item) => item.length > 0);

const CompactTrimmedStringArray = Schema.Array(TrimmedString).pipe(
  Schema.decodeTo(
    Schema.Array(TrimmedString),
    SchemaTransformation.transform({
      decode: compactStrings,
      encode: identity,
    }),
  ),
);

const OptionalTrimmedString = TrimmedString.pipe(Schema.withDecodingDefaultKey(() => ""));
const OptionalCompactTrimmedStringArray = CompactTrimmedStringArray.pipe(
  Schema.withDecodingDefaultKey(() => []),
);

const normalizeModelJson = (raw: string, wrapKey?: string | undefined): string => {
  const cleaned = extractJson(raw);

  if (wrapKey != null && cleaned.startsWith("[")) {
    return `{"${wrapKey}":${cleaned}}`;
  }

  return cleaned;
};

const makeLlmJsonResponse = <A>(schema: Schema.Codec<A>, wrapKey?: string | undefined) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(schema),
      SchemaTransformation.transform({
        decode: (raw) => normalizeModelJson(raw, wrapKey),
        encode: identity,
      }),
    ),
  );

const invalidLlmOutputError = (method: string, description: string): AiError.AiError =>
  new AiError.AiError({
    module: "LLM",
    method,
    reason: new AiError.InvalidOutputError({ description }),
  });

const mapInvalidLlmJsonResponse = (method: string, description: string) =>
  Effect.mapError((_: unknown) => invalidLlmOutputError(method, description));

const CommitMessageResponse = makeLlmJsonResponse(
  Schema.Struct({
    title: OptionalTrimmedString,
    bullets: OptionalCompactTrimmedStringArray,
    explanation: OptionalTrimmedString,
  }),
).pipe(
  Schema.decodeTo(
    Schema.Struct({
      title: NonEmptyTrimmedString,
      bullets: CompactTrimmedStringArray,
      explanation: TrimmedString,
    }),
    SchemaTransformation.transform({
      decode: ({ title, bullets, explanation }) => ({
        title: title ?? "",
        bullets: bullets ?? [],
        explanation: wrapExplanation(explanation ?? ""),
      }),
      encode: ({ title, bullets, explanation }) => ({
        title,
        bullets,
        explanation,
      }),
    }),
  ),
);
const decodeCommitMessageResponse = Schema.decodeEffect(CommitMessageResponse);

const CommitPlanResponse = makeLlmJsonResponse(
  Schema.Struct({
    groups: Schema.Array(
      Schema.Struct({
        files: OptionalCompactTrimmedStringArray,
        title: OptionalTrimmedString,
        bullets: OptionalCompactTrimmedStringArray,
        explanation: OptionalTrimmedString,
      }),
    ),
  }),
  "groups",
).pipe(
  Schema.decodeTo(
    Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({
          files: CompactTrimmedStringArray,
          message: Schema.Struct({
            title: NonEmptyTrimmedString,
            bullets: CompactTrimmedStringArray,
            explanation: TrimmedString,
          }).pipe(Schema.UndefinedOr),
        }),
      ).check(Schema.isNonEmpty()),
    }),
    SchemaTransformation.transform({
      decode: ({ groups }) => ({
        groups: groups.map((group) => ({
          files: group.files ?? [],
          message:
            (group.title ?? "").length > 0
              ? {
                  title: group.title ?? "",
                  bullets: group.bullets ?? [],
                  explanation: wrapExplanation(group.explanation ?? ""),
                }
              : undefined,
        })) as ReadonlyArray<{
          readonly files: ReadonlyArray<string>;
          readonly message:
            | {
                readonly title: string;
                readonly bullets: ReadonlyArray<string>;
                readonly explanation: string;
              }
            | undefined;
        }>,
      }),
      encode: ({ groups }) => ({
        groups: groups.map((group) => ({
          files: group.files,
          title: group.message?.title ?? "",
          bullets: group.message?.bullets ?? [],
          explanation: group.message?.explanation ?? "",
        })),
      }),
    }),
  ),
);
const decodeCommitPlanResponse = Schema.decodeEffect(CommitPlanResponse);

const TechnologiesResponse = makeLlmJsonResponse(
  Schema.Struct({
    technologies: CompactTrimmedStringArray,
  }),
  "technologies",
).pipe(
  Schema.decodeTo(
    Schema.Array(TrimmedString).check(Schema.isNonEmpty()),
    SchemaTransformation.transform({
      decode: ({ technologies }) => technologies,
      encode: (technologies) => ({ technologies }),
    }),
  ),
);
const decodeTechnologiesResponse = Schema.decodeEffect(TechnologiesResponse);

const ProjectScopesResponse = makeLlmJsonResponse(
  Schema.Struct({
    scopes: Schema.Array(ProjectScope),
  }),
  "scopes",
).pipe(
  Schema.decodeTo(
    Schema.Array(ProjectScope).check(Schema.isNonEmpty()),
    SchemaTransformation.transform({
      decode: ({ scopes }) => scopes,
      encode: (scopes) => ({ scopes }),
    }),
  ),
);
const decodeProjectScopesResponse = Schema.decodeEffect(ProjectScopesResponse);

export interface GenerateCommitMessageInput {
  readonly provider: ProviderConfig;
  readonly diff: VcsDiff;
  readonly intent: string | undefined;
  readonly config: ProjectConfig;
  readonly hookFeedback: string | undefined;
  readonly previousMessage: string | undefined;
}

export const generateCommitMessage = Effect.fn("LLM.GenerateMessage")(
  function* ({
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

    const scheduleMetadata = yield* Schedule.CurrentMetadata;

    yield* Effect.annotateCurrentSpan({ attempt: scheduleMetadata.attempt });

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

    const parsed = yield* callLlm(provider, systemPrompt, promptParts.join("\n\n"), 4096).pipe(
      Effect.flatMap((raw) => decodeCommitMessageResponse(raw)),
      mapInvalidLlmJsonResponse("generateCommitMessage", "LLM returned invalid commit message"),
    );

    return parsed satisfies CommitMessage;
  },
  Effect.retry({
    while: (error) => isRetryableInvalidModelOutput(error),
    schedule: llmInvalidOutputRetrySchedule,
  }),
);

export interface PlanCommitsInput {
  readonly provider: ProviderConfig;
  readonly stagedFiles: ReadonlyArray<string>;
  readonly unstagedFiles: ReadonlyArray<string>;
  readonly intent: string | undefined;
  readonly config: ProjectConfig;
}

export const planCommits = Effect.fn("LLM.PlanCommits")(
  function* ({ provider, stagedFiles, unstagedFiles, intent, config }: PlanCommitsInput) {
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

    const raw = yield* callLlm(
      provider,
      hasScopes ? planSystemPromptScoped : planSystemPrompt,
      promptParts.join("\n\n"),
      8192,
    );

    const parsed = yield* decodeCommitPlanResponse(raw).pipe(
      mapInvalidLlmJsonResponse("planCommits", "LLM returned invalid plan"),
    );

    return parsed satisfies CommitPlan;
  },
  Effect.retry({
    while: (error) => isRetryableInvalidModelOutput(error),
    schedule: llmInvalidOutputRetrySchedule,
  }),
);

export const detectTechnologies = Effect.fn(
  function* (
    provider: ProviderConfig,
    osName: string,
    dirs: ReadonlyArray<string>,
    files: ReadonlyArray<string>,
  ) {
    const raw = yield* callLlm(
      provider,
      detectTechSystemPrompt,
      `OS: ${osName}\n\nTop-level directories:\n${dirs.join("\n")}\n\nTracked files:\n${files.join("\n")}`,
      1024,
    );
    const parsed = yield* decodeTechnologiesResponse(raw).pipe(
      mapInvalidLlmJsonResponse("detectTechnologies", "LLM returned invalid technologies"),
    );

    return parsed;
  },
  Effect.retry({
    while: (error) => isRetryableInvalidModelOutput(error),
    schedule: llmInvalidOutputRetrySchedule,
  }),
);

export const generateScopes = Effect.fn("LLM.GenerateScopes")(
  function* (
    provider: ProviderConfig,
    commits: ReadonlyArray<string>,
    dirs: ReadonlyArray<string>,
    files: ReadonlyArray<string>,
  ) {
    const scopes = yield* callLlm(
      provider,
      generateScopesSystemPrompt,
      `Commit log (subject + changed files):\n${commits.join("\n---\n")}\n\nTop-level directories:\n${dirs.join("\n")}\n\nTracked files:\n${files.join("\n")}`,
      8192,
    ).pipe(
      Effect.flatMap((raw) => decodeProjectScopesResponse(raw)),
      mapInvalidLlmJsonResponse("generateScopes", "LLM returned invalid scopes"),
    );

    return scopes;
  },
  Effect.retry({
    while: (error) => isRetryableInvalidModelOutput(error),
    schedule: llmInvalidOutputRetrySchedule,
  }),
);
