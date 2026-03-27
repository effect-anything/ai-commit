import { AiError } from "effect/unstable/ai";
import {
  DateTime,
  Duration,
  Effect,
  identity,
  Layer,
  Schedule,
  Schema,
  SchemaTransformation,
  ServiceMap,
} from "effect";
import type { ProviderConfig } from "../config/provider.ts";
import type { ProjectScope } from "../domain/project.ts";
import { ProjectScope as ProjectScopeSchema } from "../domain/project.ts";
import { ApiError } from "../shared/errors.ts";
import { extractJson } from "../shared/text.ts";
import { LlmClient } from "./openai-client.ts";
import type { VcsClient } from "./vcs.ts";

const generateScopesSystemPrompt =
  'You are an expert software engineer. Derive commit scopes from the top-level directories of the project, using commit history to validate and refine them. Respond ONLY with valid JSON: {"scopes": [{"name": "...", "description": "..."}], "reasoning": "..."}. Scope names must be short, lowercase, and must not be commit types.';

const conventionalTypes = new Set([
  "build",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "style",
  "test",
  "chore",
  "revert",
]);

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

const ProjectScopesResponse = makeLlmJsonResponse(
  Schema.Struct({
    scopes: Schema.Array(ProjectScopeSchema),
  }),
  "scopes",
).pipe(
  Schema.decodeTo(
    Schema.Array(ProjectScopeSchema).check(Schema.isNonEmpty()),
    SchemaTransformation.transform({
      decode: ({ scopes }) => scopes,
      encode: (scopes) => ({ scopes }),
    }),
  ),
);

const decodeProjectScopesResponse = Schema.decodeEffect(ProjectScopesResponse);

const isRetryableInvalidModelOutput = (error: ApiError | AiError.AiError): boolean =>
  ApiError.is(error) || (AiError.isAiError(error) && error.reason.isRetryable);

export interface GenerateProjectScopesInput {
  readonly provider: ProviderConfig;
  readonly vcs: VcsClient;
  readonly cwd: string;
  readonly maxCommits: number;
}

export interface ScopeServiceShape {
  readonly generateProjectScopes: (
    input: GenerateProjectScopesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectScope>, ApiError | AiError.AiError | unknown>;
}

export class ScopeService extends ServiceMap.Service<ScopeService, ScopeServiceShape>()(
  "@ai-commit/ScopeService",
) {}

export const ScopeServiceLive = Layer.effect(
  ScopeService,
  Effect.gen(function* () {
    const llmClient = yield* LlmClient;

    const generateProjectScopes: ScopeServiceShape["generateProjectScopes"] = Effect.fn(
      "Config.GenerateScopes",
    )(function* ({ provider, vcs, cwd, maxCommits }: GenerateProjectScopesInput) {
      const [commits, dirs, files] = yield* Effect.all([
        vcs.commitLog(cwd, maxCommits),
        vcs.topLevelDirs(cwd),
        vcs.projectFiles(cwd),
      ]);

      const scopes = yield* llmClient
        .call({
          provider,
          systemPrompt: generateScopesSystemPrompt,
          userPrompt:
            `Commit log (subject + changed files):\n${commits.join("\n---\n")}\n\n` +
            `Top-level directories:\n${dirs.join("\n")}\n\n` +
            `Tracked files:\n${files.join("\n")}`,
          maxOutputTokens: 8192,
        })
        .pipe(
          Effect.flatMap((raw) => decodeProjectScopesResponse(raw)),
          mapInvalidLlmJsonResponse("generateScopes", "LLM returned invalid scopes"),
          Effect.retry({
            while: (error) => isRetryableInvalidModelOutput(error),
            schedule: llmInvalidOutputRetrySchedule,
          }),
        );

      return scopes.filter((scope) => !conventionalTypes.has(scope.name.toLowerCase()));
    });

    return {
      generateProjectScopes,
    } satisfies ScopeServiceShape;
  }),
);

export const formatScopeNames = (scopes: ReadonlyArray<ProjectScope>): Array<string> =>
  scopes.map((scope) => scope.name);
