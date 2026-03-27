import { homedir } from "node:os";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { parse, stringify } from "yaml";
import { ConfigError } from "../shared/errors.ts";
import { runProcess } from "../shared/process.ts";
import { buildEnvironment, DefaultBaseUrl, DefaultModel, envOptionalString } from "./env.ts";
import { localConfigPath, projectConfigPath, readProjectField } from "./project.ts";

export const ProviderConfig = Schema.Struct({
  apiKey: Schema.String,
  baseUrl: Schema.String,
  model: Schema.String,
  noGitAgentCoAuthor: Schema.Boolean,
  noModelCoAuthor: Schema.Boolean,
});

export type ProviderConfig = typeof ProviderConfig.Type;

export interface ProviderConfigInput {
  readonly cwd: string;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly vcs: "git" | "jj" | undefined;
}

const ExpandEnvString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        expandEnv(value).pipe(
          Effect.mapError(
            (cause) =>
              new SchemaIssue.InvalidValue(Option.some(value), {
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);

const FileConfig = Schema.Struct({
  api_key: Schema.optionalKey(ExpandEnvString.pipe(Schema.UndefinedOr)),
  base_url: Schema.optionalKey(ExpandEnvString.pipe(Schema.UndefinedOr)),
  model: Schema.optionalKey(ExpandEnvString.pipe(Schema.UndefinedOr)),
  no_git_agent_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
  no_model_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
});

type FileConfig = typeof FileConfig.Type;

const readEnvVar = Effect.fn(function* (name: string) {
  const value = yield* envOptionalString(name);
  return Option.match(value, {
    onNone: () => "",
    onSome: (text) => text,
  });
});

export const readBuildProviderDefaults = Effect.gen(function* () {
  const { apiKey, baseUrl, model } = yield* buildEnvironment;
  return {
    apiKey,
    baseUrl,
    model,
  };
});

export const userConfigPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const env = yield* buildEnvironment;
  const xdgConfigHome = Option.match(env.xdgConfigHome, {
    onNone: () => undefined,
    onSome: (value) => (value.trim().length > 0 ? value.trim() : undefined),
  });

  if (xdgConfigHome != null) {
    return path.join(xdgConfigHome, "git-agent", "config.yml");
  }
  return path.join(homedir(), ".config", "git-agent", "config.yml");
});

const expandEnv = Effect.fn(function* (value: string) {
  const names = [
    ...new Set([...value.matchAll(/\$([A-Z0-9_]+)/gi)].map((match) => match[1] ?? "")),
  ].filter((name) => name.length > 0);
  if (names.length === 0) {
    return value;
  }

  const entries = yield* Effect.forEach(names, (name) =>
    Effect.map(readEnvVar(name), (resolved) => [name, resolved] as const),
  );
  const resolved = Object.fromEntries(entries) as Record<string, string>;

  return value.replace(/\$([A-Z0-9_]+)/gi, (_match, name: string) => resolved[name] ?? "");
});

const readUserConfig = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathValue = yield* userConfigPath;
  const exists = yield* fs.exists(pathValue);
  if (!exists) {
    return {} satisfies FileConfig;
  }

  const text = yield* fs.readFileString(pathValue, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "failed to read user config",
          cause,
        }),
    ),
  );

  const raw = yield* Effect.try({
    try: () => parse(text),
    catch: (cause) =>
      new ConfigError({
        message: "failed to read user config",
        cause,
      }),
  });

  return yield* Schema.decodeUnknownEffect(FileConfig)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "failed to read user config",
          cause,
        }),
    ),
  );
});

const readGitConfig = (cwd: string, key: string) =>
  Effect.map(
    runProcess({
      command: "git",
      args: ["config", "--local", "--get", `git-agent.${key}`],
      cwd,
      allowFailure: true,
    }),
    (result) => (result.exitCode === 0 ? result.stdout.trim() : ""),
  );

export const resolveProviderConfig = Effect.fn("Config.ResolveProvider")(function* ({
  cwd,
  apiKey,
  baseUrl,
  model,
  vcs,
}: ProviderConfigInput) {
  const build = yield* readBuildProviderDefaults;

  const file = yield* readUserConfig();
  const gitModel = vcs === "git" ? yield* readGitConfig(cwd, "model") : "";
  const gitBaseUrl = vcs === "git" ? yield* readGitConfig(cwd, "base-url") : "";

  return {
    apiKey: firstNonEmpty(apiKey, file.api_key, build.apiKey) ?? "",
    baseUrl: firstNonEmpty(baseUrl, gitBaseUrl, file.base_url, build.baseUrl) ?? DefaultBaseUrl,
    model: firstNonEmpty(model, gitModel, file.model, build.model) ?? DefaultModel,
    noGitAgentCoAuthor: file.no_git_agent_co_author ?? false,
    noModelCoAuthor: file.no_model_co_author ?? false,
  } satisfies ProviderConfig;
});

export const resolveField = Effect.fn("Config.ResolveField")(function* (
  repoRoot: string | undefined,
  key: string,
) {
  yield* Effect.annotateCurrentSpan({ key });

  if (key === "api_key" || key === "base_url" || key === "model") {
    const userValue = yield* readUserField(key);
    return userValue == null ? undefined : { value: userValue, scope: "user" as const };
  }

  if (repoRoot != null) {
    const localValue = yield* readProjectField(yield* localConfigPath(repoRoot), key);
    if (typeof localValue === "string" && localValue.length > 0) {
      return { value: localValue, scope: "local" as const };
    }

    const projectValue = yield* readProjectField(yield* projectConfigPath(repoRoot), key);
    if (typeof projectValue === "string" && projectValue.length > 0) {
      return { value: projectValue, scope: "project" as const };
    }
  }

  const userValue = yield* readUserField(key);
  return userValue == null ? undefined : { value: userValue, scope: "user" as const };
});

export const readUserField = (key: string) =>
  Effect.map(readUserConfig(), (config) => {
    const value = config[key as keyof FileConfig];
    return typeof value === "string"
      ? value
      : typeof value === "boolean"
        ? String(value)
        : undefined;
  });

export const writeUserField = Effect.fn(function* (key: string, value: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pathValue = yield* userConfigPath;
  const exists = yield* fs.exists(pathValue);
  let raw: Record<string, unknown> = {};

  if (exists) {
    const existing = yield* fs.readFileString(pathValue, "utf8").pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            message: "failed to write user config",
            cause,
          }),
      ),
    );
    const parsed = yield* Effect.try({
      try: () => parse(existing),
      catch: (cause) =>
        new ConfigError({
          message: "failed to write user config",
          cause,
        }),
    });
    if (typeof parsed === "object" && parsed != null) {
      raw = parsed as Record<string, unknown>;
    }
  }

  raw[key] = value;

  yield* fs.makeDirectory(path.dirname(pathValue), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "failed to write user config",
          cause,
        }),
    ),
  );
  yield* fs.writeFileString(pathValue, stringify(raw), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "failed to write user config",
          cause,
        }),
    ),
  );
});

const firstNonEmpty = (...values: ReadonlyArray<string | undefined>): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.length > 0);
