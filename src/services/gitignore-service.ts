import { platform } from "node:os";
import { AiError } from "effect/unstable/ai";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  identity,
  Layer,
  Path,
  Schedule,
  Schema,
  SchemaTransformation,
  ServiceMap,
} from "effect";
import { buildEnvironment } from "../config/env.ts";
import type { ProviderConfig } from "../config/provider.ts";
import { ApiError } from "../shared/errors.ts";
import { extractJson } from "../shared/text.ts";
import { LlmClient } from "./openai-client.ts";
import type { VcsClient } from "./vcs.ts";

const autoGenStart = "### git-agent auto-generated — DO NOT EDIT this block ###";
const legacyAutoGenStart = "### git-agent auto-generated - DO NOT EDIT this block ###";
const autoGenEnd = "### end git-agent ###";
const customSection = "### custom rules ###";

const detectTechSystemPrompt =
  'You are an expert software engineer. Analyze the project\'s OS, directories, and files to detect which technologies are used. Return a JSON object with a technologies array containing only valid Toptal gitignore API identifiers. Respond ONLY with valid JSON: {"technologies": ["go", "node", "visualstudiocode"]}';

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

const runtimeOs = (): string => {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
};

const wrapGenerated = (content: string, technologies: ReadonlyArray<string>): string =>
  `${autoGenStart}\n# Technologies: ${technologies.join(", ")}\n${content.trimEnd()}\n${autoGenEnd}\n`;

const toptalTechs = (content: string): Array<string> => {
  for (const line of content.split("\n").slice(0, 10)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# Created by")) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const url = fields[fields.length - 1];
    if (url == null) {
      break;
    }
    const marker = "/api/";
    const index = url.lastIndexOf(marker);
    if (index !== -1) {
      return url
        .slice(index + marker.length)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    break;
  }
  return [];
};

const mergeGitignore = (existing: string, generated: string): string => {
  const userLines: Array<string> = [];
  let insideBlock = false;

  for (const line of existing.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === autoGenStart || trimmed === legacyAutoGenStart) {
      insideBlock = true;
      continue;
    }
    if (trimmed === autoGenEnd) {
      insideBlock = false;
      continue;
    }
    if (trimmed === customSection) {
      continue;
    }
    if (!insideBlock) {
      userLines.push(line);
    }
  }

  const covered = new Set(
    generated
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  const unique = userLines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith("#") || !covered.has(trimmed);
  });

  while (unique.length > 0 && unique[0]?.trim().length === 0) {
    unique.shift();
  }
  while (unique.length > 0 && unique[unique.length - 1]?.trim().length === 0) {
    unique.pop();
  }

  if (unique.length === 0) {
    return generated;
  }
  return `${generated.trimEnd()}\n\n${customSection}\n${unique.join("\n")}\n`;
};

const TrimmedString = Schema.String.pipe(Schema.decode(SchemaTransformation.trim()));
const CompactTrimmedStringArray = Schema.Array(TrimmedString).pipe(
  Schema.decodeTo(
    Schema.Array(TrimmedString),
    SchemaTransformation.transform({
      decode: (items) => items.filter((item) => item.length > 0) as ReadonlyArray<string>,
      encode: identity,
    }),
  ),
);

const makeLlmJsonResponse = <A>(schema: Schema.Codec<A>, wrapKey?: string | undefined) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(schema),
      SchemaTransformation.transform({
        decode: (raw) => {
          const cleaned = extractJson(raw);
          if (wrapKey != null && cleaned.startsWith("[")) {
            return `{"${wrapKey}":${cleaned}}`;
          }
          return cleaned;
        },
        encode: identity,
      }),
    ),
  );

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

const invalidLlmOutputError = (method: string, description: string): AiError.AiError =>
  new AiError.AiError({
    module: "LLM",
    method,
    reason: new AiError.InvalidOutputError({ description }),
  });

const isRetryableInvalidModelOutput = (error: ApiError | AiError.AiError): boolean =>
  ApiError.is(error) || (AiError.isAiError(error) && error.reason.isRetryable);

export interface GenerateGitignoreInput {
  readonly provider: ProviderConfig;
  readonly vcs: VcsClient;
  readonly cwd: string;
}

export interface GitignoreServiceShape {
  readonly generateGitignore: (
    input: GenerateGitignoreInput,
  ) => Effect.Effect<ReadonlyArray<string>, ApiError | AiError.AiError | unknown>;
}

export class GitignoreService extends ServiceMap.Service<GitignoreService, GitignoreServiceShape>()(
  "@git-agent/GitignoreService",
) {}

export const GitignoreServiceLive = Layer.effect(
  GitignoreService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const llmClient = yield* LlmClient;

    const detectTechnologies = Effect.fn("Config.DetectTechnologies")(function* (
      provider: ProviderConfig,
      osName: string,
      dirs: ReadonlyArray<string>,
      files: ReadonlyArray<string>,
    ) {
      const raw = yield* llmClient.call({
        provider,
        systemPrompt: detectTechSystemPrompt,
        userPrompt:
          `OS: ${osName}\n\nTop-level directories:\n${dirs.join("\n")}\n\n` +
          `Tracked files:\n${files.join("\n")}`,
        maxOutputTokens: 1024,
      });

      return yield* decodeTechnologiesResponse(raw).pipe(
        Effect.mapError(() =>
          invalidLlmOutputError("detectTechnologies", "LLM returned invalid technologies"),
        ),
        Effect.retry({
          while: (error) => isRetryableInvalidModelOutput(error),
          schedule: llmInvalidOutputRetrySchedule,
        }),
      );
    });

    const fetchGitignore = Effect.fn("Config.FetchGitIgnore")(function* (
      technologies: ReadonlyArray<string>,
    ) {
      const env = yield* buildEnvironment;
      const baseUrl = env.gitignoreBaseUrl.replace(/\/$/, "");
      const url = `${baseUrl}/${technologies.map((item) => encodeURIComponent(item)).join(",")}`;

      return yield* HttpClient.get(url).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      );
    });

    const generateGitignore: GitignoreServiceShape["generateGitignore"] = Effect.fn(
      "Config.GenerateGitignore",
    )(function* ({ provider, vcs, cwd }: GenerateGitignoreInput) {
      const [dirs, files] = yield* Effect.all([vcs.topLevelDirs(cwd), vcs.projectFiles(cwd)]);
      let technologies = yield* detectTechnologies(provider, runtimeOs(), dirs, files);
      const fetched = yield* fetchGitignore(technologies).pipe(
        Effect.catchCause((error) =>
          Effect.die(`failed to fetch gitignore template (${Cause.pretty(error)})`),
        ),
      );
      const actualTechnologies = toptalTechs(fetched);
      if (actualTechnologies.length > 0) {
        technologies = actualTechnologies;
      }

      const gitignorePath = path.join(cwd, ".gitignore");
      const existing = yield* fs.exists(gitignorePath).pipe(
        Effect.flatMap((exists) =>
          exists ? fs.readFileString(gitignorePath, "utf8") : Effect.succeed(""),
        ),
        Effect.mapError(
          (cause) =>
            new ApiError({
              message: "failed to write .gitignore",
              cause,
            }),
        ),
      );
      const generated = wrapGenerated(fetched, technologies);
      const content = existing.length === 0 ? generated : mergeGitignore(existing, generated);

      yield* fs.writeFileString(gitignorePath, content, { mode: 0o644 }).pipe(
        Effect.mapError(
          (cause) =>
            new ApiError({
              message: "failed to write .gitignore",
              cause,
            }),
        ),
      );
      return technologies;
    });

    return {
      generateGitignore,
    } satisfies GitignoreServiceShape;
  }),
);
