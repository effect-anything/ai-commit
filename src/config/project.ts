import { Effect, FileSystem, Path, Schema } from "effect";
import { parse, stringify } from "yaml";
import type { ProjectConfig, ProjectScope } from "../domain/project";
import { emptyProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { getKeyDef } from "./keys";

type RawYamlMap = Record<string, unknown>;
type RawScopeInput = string | { readonly name: string; readonly description?: string | undefined };
type RawHookInput = string | ReadonlyArray<string>;

const RawScopeSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
]);
const RawHooksSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const configError = (pathValue: string, message: string) =>
  new ConfigError({
    message: `invalid config ${pathValue}: ${message}`,
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
        Effect.mapError((cause) => configError(pathValue, `${key}: ${cause.message}`)),
      );

const readYamlMap = Effect.fn(function* (pathValue: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(pathValue);
  if (!exists) {
    return {};
  }

  const text = yield* fs.readFileString(pathValue, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to read config ${pathValue}: ${cause.message}`,
        }),
    ),
  );

  return yield* Effect.try({
    try: () => {
      const parsed = parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw configError(pathValue, "expected a YAML mapping");
      }
      return parsed as RawYamlMap;
    },
    catch: (cause) =>
      ConfigError.is(cause)
        ? cause
        : new ConfigError({
            message: `failed to read config ${pathValue}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
  });
});

const normalizeScope = (
  pathValue: string,
  input: RawScopeInput,
  index: number,
): Effect.Effect<ProjectScope, ConfigError> => {
  if (typeof input === "string") {
    const name = input.trim();
    return name.length > 0
      ? Effect.succeed({ name })
      : Effect.failSync(() => configError(pathValue, `scopes[${index}] must not be empty`));
  }

  const name = input.name.trim();
  if (name.length === 0) {
    return Effect.failSync(() => configError(pathValue, `scopes[${index}].name must not be empty`));
  }

  const description = input.description?.trim();
  return Effect.succeed({
    name,
    ...(description != null && description.length > 0 ? { description } : {}),
  });
};

const decodeScopes = Effect.fn(function* (pathValue: string, rawMap: RawYamlMap) {
  const scopes = yield* decodeConfigField(
    pathValue,
    "scopes",
    rawMap["scopes"],
    Schema.Array(RawScopeSchema),
  );
  if (scopes == null) {
    return [] as Array<ProjectScope>;
  }
  return yield* Effect.forEach(scopes, (scope, index) => normalizeScope(pathValue, scope, index));
});

const normalizeHookValues = (
  pathValue: string,
  key: "hook" | "hook_type",
  input: RawHookInput,
): Effect.Effect<Array<string>, ConfigError> => {
  const normalized = (typeof input === "string" ? input.split(",") : [...input])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.failSync(() => configError(pathValue, `${key} must not be empty`));
};

const decodeHooks = Effect.fn(function* (pathValue: string, rawMap: RawYamlMap) {
  const hooks = yield* decodeConfigField(pathValue, "hook", rawMap["hook"], RawHooksSchema);
  if (hooks != null) {
    return yield* normalizeHookValues(pathValue, "hook", hooks);
  }

  const legacyHook = yield* decodeConfigField(
    pathValue,
    "hook_type",
    rawMap["hook_type"],
    Schema.String,
  );
  if (legacyHook != null) {
    return yield* normalizeHookValues(pathValue, "hook_type", legacyHook);
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

export const loadProjectConfig = Effect.fn(function* (repoRoot: string) {
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

export const mergeAndSaveScopes = Effect.fn(function* (
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
          message: `failed to save scopes to ${pathValue}: ${cause.message}`,
        }),
    ),
  );
  yield* fs.writeFileString(pathValue, stringify(rawMap), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to save scopes to ${pathValue}: ${cause.message}`,
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

export const writeProjectField = Effect.fn(function* (
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
          message: `failed to write config ${pathValue}: ${cause.message}`,
        }),
    ),
  );
  yield* fs.writeFileString(pathValue, stringify(rawMap), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to write config ${pathValue}: ${cause.message}`,
        }),
    ),
  );
});

export const ensureProjectConfig = (config: ProjectConfig | undefined): ProjectConfig =>
  config ?? emptyProjectConfig();
