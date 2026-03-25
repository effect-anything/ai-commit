import { Effect, FileSystem, Path } from "effect";
import { parse, stringify } from "yaml";
import type { ProjectConfig, ProjectScope } from "../domain/project";
import { emptyProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { getKeyDef } from "./keys";

type RawYamlMap = Record<string, unknown>;

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
      return typeof parsed === "object" && parsed !== null ? (parsed as RawYamlMap) : {};
    },
    catch: (cause) =>
      new ConfigError({
        message: `failed to read config ${pathValue}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
});

const scopeFromUnknown = (input: unknown): ProjectScope | undefined => {
  if (typeof input === "string" && input.trim().length > 0) {
    return { name: input.trim() };
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "name" in input &&
    typeof input.name === "string"
  ) {
    const description =
      "description" in input &&
      typeof input.description === "string" &&
      input.description.trim().length > 0
        ? input.description.trim()
        : undefined;
    return {
      name: input.name.trim(),
      ...(description != null ? { description } : {}),
    };
  }
  return undefined;
};

const parseScopes = (input: unknown): Array<ProjectScope> => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map(scopeFromUnknown).filter((scope): scope is ProjectScope => scope != null);
};

const parseHooks = (input: unknown, legacy: unknown): Array<string> => {
  if (Array.isArray(input)) {
    return input.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof input === "string" && input.trim().length > 0) {
    return input
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof legacy === "string" && legacy.trim().length > 0) {
    return [legacy.trim()];
  }
  return [];
};

const parseBoolean = (input: unknown): boolean | undefined =>
  typeof input === "boolean" ? input : undefined;

const parseIntValue = (input: unknown): number | undefined =>
  typeof input === "number" && Number.isInteger(input) ? input : undefined;

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

  const mergedScopes =
    parseScopes(localRaw["scopes"]).length > 0
      ? parseScopes(localRaw["scopes"])
      : parseScopes(projectRaw["scopes"]);
  const mergedHooks =
    parseHooks(localRaw["hook"], localRaw["hook_type"]).length > 0
      ? parseHooks(localRaw["hook"], localRaw["hook_type"])
      : parseHooks(projectRaw["hook"], projectRaw["hook_type"]);
  const maxDiffLines =
    parseIntValue(localRaw["max_diff_lines"]) ?? parseIntValue(projectRaw["max_diff_lines"]) ?? 0;
  const noGitAgentCoAuthor =
    parseBoolean(localRaw["no_git_agent_co_author"]) ??
    parseBoolean(projectRaw["no_git_agent_co_author"]) ??
    false;
  const noModelCoAuthor =
    parseBoolean(localRaw["no_model_co_author"]) ??
    parseBoolean(projectRaw["no_model_co_author"]) ??
    false;

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
  const existingScopes = parseScopes(rawMap["scopes"]);
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
