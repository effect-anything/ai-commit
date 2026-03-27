import { Effect, FileSystem, Path, Schema, SchemaTransformation } from "effect";
import { parse, stringify } from "yaml";
import type { ProjectConfig } from "../domain/project.ts";
import { ProjectScope, emptyProjectConfig } from "../domain/project.ts";
import { ConfigError } from "../shared/errors.ts";
import { getKeyDef } from "./keys.ts";

const TrimmedString = Schema.String.pipe(Schema.decode(SchemaTransformation.trim()));
const NonEmptyTrimmedString = TrimmedString.check(Schema.isNonEmpty());
const CompactTrimmedStringArray = Schema.Array(TrimmedString).pipe(
  Schema.decodeTo(
    Schema.Array(TrimmedString),
    SchemaTransformation.transform({
      decode: (items) => items.filter((item) => item.length > 0) as ReadonlyArray<string>,
      encode: (items) => items,
    }),
  ),
);
const NonEmptyCompactTrimmedStringArray = CompactTrimmedStringArray.pipe(
  Schema.decodeTo(
    Schema.Array(NonEmptyTrimmedString).check(Schema.isNonEmpty()),
    SchemaTransformation.transform({
      decode: (items) => items,
      encode: (items) => items,
    }),
  ),
);

const RawYamlMapSchema = Schema.Record(Schema.String, Schema.Unknown);
type RawYamlMap = Record<string, unknown>;

const RawScopeInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }),
]);
const ScopeListField = Schema.Array(RawScopeInput).pipe(
  Schema.decodeTo(
    Schema.Array(ProjectScope),
    SchemaTransformation.transform({
      decode: (scopes) =>
        scopes.map((scope) =>
          typeof scope === "string"
            ? { name: scope }
            : {
                name: scope.name,
                ...(scope.description?.trim().length ? { description: scope.description } : {}),
              },
        ) as ReadonlyArray<{ readonly name: string; readonly description?: string }>,
      encode: (scopes) =>
        scopes.map((scope) => ({
          name: scope.name,
          ...(scope.description != null ? { description: scope.description } : {}),
        })) as ReadonlyArray<{ readonly name: string; readonly description?: string }>,
    }),
  ),
);

const RawHookInput = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const HookListField = RawHookInput.pipe(
  Schema.decodeTo(
    NonEmptyCompactTrimmedStringArray,
    SchemaTransformation.transform({
      decode: (input) =>
        (typeof input === "string" ? input.split(",") : [...input]) as ReadonlyArray<string>,
      encode: (input) => input,
    }),
  ),
);

const configError = (pathValue: string, message: string, cause?: unknown | undefined) =>
  new ConfigError({
    message: `invalid config ${pathValue}: ${message}`,
    cause,
  });

const decodeConfigField = <S extends Schema.Top>(
  pathValue: string,
  key: string,
  input: unknown,
  schema: S,
) =>
  input === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError((cause) => configError(pathValue, key, cause)),
      );

const readYamlMap = Effect.fn(function* (pathValue: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(pathValue);
  if (!exists) {
    return {} as RawYamlMap;
  }

  const text = yield* fs.readFileString(pathValue, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to read config ${pathValue}`,
          cause,
        }),
    ),
  );

  return yield* Effect.try({
    try: () => parse(text),
    catch: (cause) =>
      new ConfigError({
        message: `failed to read config ${pathValue}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((parsed) => Schema.decodeUnknownEffect(RawYamlMapSchema)(parsed)),
    Effect.map((parsed) => ({ ...parsed })),
    Effect.mapError((cause) => configError(pathValue, "expected a YAML mapping", cause)),
  );
});

const decodeScopes = Effect.fn(function* (pathValue: string, rawMap: RawYamlMap) {
  return ((yield* decodeConfigField(pathValue, "scopes", rawMap["scopes"], ScopeListField)) ??
    []) as Array<ProjectScope>;
});

const decodeHooks = Effect.fn(function* (pathValue: string, rawMap: RawYamlMap) {
  const hooks = yield* decodeConfigField(pathValue, "hook", rawMap["hook"], HookListField);
  if (hooks != null) {
    return hooks;
  }

  const legacyHook = yield* decodeConfigField(
    pathValue,
    "hook_type",
    rawMap["hook_type"],
    HookListField,
  );

  if (legacyHook != null) {
    return legacyHook;
  }

  return [] as Array<string>;
});

const gitAgentPath = Effect.fn(function* (repoRoot: string, ...segments: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  return path.join(repoRoot, ".git-agent", ...segments);
});

export const projectConfigPath = Effect.fn(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const currentPath = yield* gitAgentPath(repoRoot, "config.yml");
  if (yield* fs.exists(currentPath)) {
    return currentPath;
  }
  const legacyPath = yield* gitAgentPath(repoRoot, "project.yml");
  if (yield* fs.exists(legacyPath)) {
    return legacyPath;
  }
  return currentPath;
});

export const projectConfigWritePath = (repoRoot: string) => gitAgentPath(repoRoot, "config.yml");

export const localConfigPath = (repoRoot: string) => gitAgentPath(repoRoot, "config.local.yml");

export const loadProjectConfig = Effect.fn("Config.LoadProjectConfig")(function* (
  repoRoot: string,
) {
  const projectPath = yield* projectConfigPath(repoRoot);
  const localPath = yield* localConfigPath(repoRoot);
  const projectRaw = yield* readYamlMap(projectPath);
  const localRaw = yield* readYamlMap(localPath);

  const [
    localScopes,
    projectScopes,
    localHooks,
    projectHooks,
    localMaxDiffLines,
    projectMaxDiffLines,
  ] = yield* Effect.all([
    decodeScopes(localPath, localRaw),
    decodeScopes(projectPath, projectRaw),
    decodeHooks(localPath, localRaw),
    decodeHooks(projectPath, projectRaw),
    decodeConfigField(localPath, "max_diff_lines", localRaw["max_diff_lines"], Schema.Int),
    decodeConfigField(projectPath, "max_diff_lines", projectRaw["max_diff_lines"], Schema.Int),
  ]);
  const mergedScopes = localScopes.length > 0 ? localScopes : projectScopes;
  const mergedHooks = localHooks.length > 0 ? localHooks : projectHooks;
  const maxDiffLines = localMaxDiffLines ?? projectMaxDiffLines ?? 0;
  const [
    localNoGitAgentCoAuthor,
    projectNoGitAgentCoAuthor,
    localNoModelCoAuthor,
    projectNoModelCoAuthor,
  ] = yield* Effect.all([
    decodeConfigField(
      localPath,
      "no_git_agent_co_author",
      localRaw["no_git_agent_co_author"],
      Schema.Boolean,
    ),
    decodeConfigField(
      projectPath,
      "no_git_agent_co_author",
      projectRaw["no_git_agent_co_author"],
      Schema.Boolean,
    ),
    decodeConfigField(
      localPath,
      "no_model_co_author",
      localRaw["no_model_co_author"],
      Schema.Boolean,
    ),
    decodeConfigField(
      projectPath,
      "no_model_co_author",
      projectRaw["no_model_co_author"],
      Schema.Boolean,
    ),
  ]);
  const noGitAgentCoAuthor = localNoGitAgentCoAuthor ?? projectNoGitAgentCoAuthor ?? false;
  const noModelCoAuthor = localNoModelCoAuthor ?? projectNoModelCoAuthor ?? false;

  if (
    mergedScopes.length === 0 &&
    mergedHooks.length === 0 &&
    maxDiffLines === 0 &&
    noGitAgentCoAuthor === false &&
    noModelCoAuthor === false
  ) {
    return undefined as ProjectConfig | undefined;
  }

  return {
    scopes: mergedScopes,
    hooks: mergedHooks,
    maxDiffLines,
    noGitAgentCoAuthor,
    noModelCoAuthor,
  } satisfies ProjectConfig;
});

export const mergeScopes = Effect.fn("Config.MergeScopes")(function* (
  pathValue: string,
  nextScopes: ReadonlyArray<ProjectScope>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rawMap = yield* readYamlMap(pathValue);
  const existingScopes = yield* decodeScopes(pathValue, rawMap);
  const seen = new Set(existingScopes.map((scope) => scope.name.toLowerCase()));
  const merged = [...existingScopes];

  for (const scope of nextScopes) {
    const key = scope.name.toLowerCase();
    if (!seen.has(key)) {
      merged.push(scope);
      seen.add(key);
      continue;
    }
    const index = merged.findIndex((item) => item.name.toLowerCase() === key);
    if (
      index >= 0 &&
      merged[index] != null &&
      merged[index].description == null &&
      scope.description != null
    ) {
      merged[index] = {
        ...merged[index],
        description: scope.description,
      };
    }
  }

  rawMap["scopes"] = merged;

  yield* fs.makeDirectory(path.dirname(pathValue), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to save scopes to ${pathValue}`,
          cause,
        }),
    ),
  );

  yield* fs.writeFileString(pathValue, stringify(rawMap), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to save scopes to ${pathValue}`,
          cause,
        }),
    ),
  );
});

const yamlValueToString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(",");
  }
  return "";
};

export const readProjectField = (pathValue: string, key: string) =>
  Effect.map(readYamlMap(pathValue), (rawMap) => {
    if (!(key in rawMap)) {
      return undefined;
    }
    return yamlValueToString(rawMap[key]);
  });

export const writeProjectField = Effect.fn("Config.WriteProjectField")(function* (
  pathValue: string,
  key: string,
  value: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const rawMap = yield* readYamlMap(pathValue);

  const def = getKeyDef(key);
  if (def == null) {
    return yield* new ConfigError({ message: `unknown config key "${key}"` });
  }

  switch (def.type) {
    case "bool":
      rawMap[key] = value === "true";
      break;
    case "int":
      rawMap[key] = Number(value);
      break;
    case "stringslice":
      rawMap[key] = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      break;
    default:
      rawMap[key] = value;
  }

  yield* fs.makeDirectory(path.dirname(pathValue), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to write config ${pathValue}`,
          cause,
        }),
    ),
  );

  yield* fs.writeFileString(pathValue, stringify(rawMap), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to write config ${pathValue}`,
          cause,
        }),
    ),
  );
});

export const ensureProjectConfig = (config: ProjectConfig | undefined): ProjectConfig =>
  config ?? emptyProjectConfig();
