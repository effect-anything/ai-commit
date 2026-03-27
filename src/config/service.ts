import { homedir } from "node:os";
import { Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import type { ProjectConfig, ProjectScope } from "../domain/project.ts";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ConfigError } from "../shared/errors.ts";
import { runProcess } from "../shared/process.ts";
import type { ProviderConfig, ProviderConfigInput } from "./provider.ts";
import { buildEnvironment, DefaultBaseUrl, DefaultModel } from "./env.ts";
import {
  type ProjectConfigFile,
  ProjectConfigFileSchema,
  type UserConfigFile,
  UserConfigFileSchema,
} from "./file-schema.ts";
import { getKeyDef } from "./keys.ts";

type JsonMap = Record<string, unknown>;

interface ResolvedField {
  readonly value: string;
  readonly scope: "user" | "project" | "local";
}

const configError = (message: string, cause?: unknown | undefined) =>
  new ConfigError({ message, cause });

const extractIssuePath = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause == null) {
    return undefined;
  }

  if ("path" in cause && Array.isArray(cause.path)) {
    const parts = cause.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    if (parts.length > 0) {
      return parts.join(".");
    }
  }

  if ("issue" in cause) {
    const path = extractIssuePath(cause.issue);
    if (path != null) {
      return path;
    }
  }

  if ("issues" in cause && Array.isArray(cause.issues)) {
    for (const issue of cause.issues) {
      const path = extractIssuePath(issue);
      if (path != null) {
        return path;
      }
    }
  }

  return undefined;
};

const invalidConfigError = (pathValue: string, label: string, cause?: unknown | undefined) =>
  configError(`invalid config ${pathValue}: ${extractIssuePath(cause) ?? label}`, cause);

const emptyUserConfigFile = (): UserConfigFile => ({});

const emptyProjectConfigFile = (): ProjectConfigFile => ({});

const decodeUserConfigFile = (
  pathValue: string,
  raw: JsonMap,
): Effect.Effect<UserConfigFile, ConfigError> =>
  Schema.decodeUnknownEffect(UserConfigFileSchema)(raw).pipe(
    Effect.mapError((cause) => invalidConfigError(pathValue, "user config", cause)),
  );

const decodeProjectConfigFile = (
  pathValue: string,
  raw: JsonMap,
): Effect.Effect<ProjectConfigFile, ConfigError> =>
  Schema.decodeUnknownEffect(ProjectConfigFileSchema)(raw).pipe(
    Effect.mapError((cause) => invalidConfigError(pathValue, "project config", cause)),
  );

const jsonValueToString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (
        typeof item === "object" &&
        item != null &&
        "name" in item &&
        typeof item.name === "string"
      ) {
        return item.name;
      }
      return undefined;
    })
    .filter((item): item is string => typeof item === "string" && item.length > 0);

  return items.length > 0 ? items.join(",") : undefined;
};

const firstNonEmpty = (...values: ReadonlyArray<string | undefined>): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.length > 0);

const isEmptyProjectConfig = (config: ProjectConfig): boolean =>
  config.scopes.length === 0 &&
  config.hooks.length === 0 &&
  config.maxDiffLines === 0 &&
  config.noCommitCoAuthor === false &&
  config.noModelCoAuthor === false;

interface ConfigServiceShape {
  readonly projectConfigPath: (repoRoot: string) => Effect.Effect<string>;
  readonly localConfigPath: (repoRoot: string) => Effect.Effect<string>;
  readonly resolveProviderConfig: (
    input: ProviderConfigInput,
  ) => Effect.Effect<ProviderConfig, ConfigError>;
  readonly resolveField: (
    repoRoot: string | undefined,
    key: string,
  ) => Effect.Effect<ResolvedField | undefined, ConfigError>;
  readonly writeUserField: (key: string, value: string) => Effect.Effect<void, ConfigError>;
  readonly writeProjectField: (
    pathValue: string,
    key: string,
    value: string,
  ) => Effect.Effect<void, ConfigError>;
  readonly loadProjectConfig: (
    repoRoot: string,
  ) => Effect.Effect<ProjectConfig | undefined, ConfigError>;
  readonly mergeScopes: (
    pathValue: string,
    nextScopes: ReadonlyArray<ProjectScope>,
  ) => Effect.Effect<void, ConfigError>;
}

export class ConfigService extends ServiceMap.Service<ConfigService, ConfigServiceShape>()(
  "@ai-commit/ConfigService",
) {}

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const environment = yield* buildEnvironment.pipe(
      Effect.mapError((cause) => configError("failed to read environment configuration", cause)),
    );

    const userConfigPath = Effect.gen(function* () {
      const xdgConfigHome = Option.match(environment.xdgConfigHome, {
        onNone: () => undefined,
        onSome: (value) => (value.trim().length > 0 ? value.trim() : undefined),
      });

      if (xdgConfigHome != null) {
        return path.join(xdgConfigHome, "ai-commit", "config.json");
      }
      return path.join(homedir(), ".config", "ai-commit", "config.json");
    });

    const readEnvVar = Effect.fn(function* (name: string) {
      return process.env[name]?.trim() ?? "";
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

    const configDirPath = (repoRoot: string, ...segments: ReadonlyArray<string>) =>
      path.join(repoRoot, ".ai-commit", ...segments);

    const projectConfigPath: ConfigServiceShape["projectConfigPath"] = Effect.fn(function* (
      repoRoot: string,
    ) {
      return configDirPath(repoRoot, "config.json");
    });

    const localConfigPath: ConfigServiceShape["localConfigPath"] = Effect.fn(function* (
      repoRoot: string,
    ) {
      return configDirPath(repoRoot, "config.local.json");
    });

    const readJsonMap = Effect.fn(function* (pathValue: string) {
      const exists = yield* fs
        .exists(pathValue)
        .pipe(Effect.mapError((cause) => configError(`failed to read config ${pathValue}`, cause)));
      if (!exists) {
        return {} as JsonMap;
      }

      const text = yield* fs
        .readFileString(pathValue, "utf8")
        .pipe(Effect.mapError((cause) => configError(`failed to read config ${pathValue}`, cause)));

      return yield* Effect.try({
        try: () => {
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
            throw new TypeError("expected a JSON object");
          }
          return { ...(parsed as JsonMap) };
        },
        catch: (cause) =>
          cause instanceof TypeError && cause.message === "expected a JSON object"
            ? invalidConfigError(pathValue, "expected a JSON object", cause)
            : configError(`failed to read config ${pathValue}`, cause),
      });
    });

    const writeJsonMap = Effect.fn(function* (pathValue: string, rawMap: JsonMap) {
      yield* fs
        .makeDirectory(path.dirname(pathValue), { recursive: true })
        .pipe(
          Effect.mapError((cause) => configError(`failed to write config ${pathValue}`, cause)),
        );
      yield* fs
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        .writeFileString(pathValue, `${JSON.stringify(rawMap, null, 2)}\n`, { mode: 0o644 })
        .pipe(
          Effect.mapError((cause) => configError(`failed to write config ${pathValue}`, cause)),
        );
    });

    const readUserConfigFile = Effect.fn(function* (pathValue: string) {
      const rawMap = yield* readJsonMap(pathValue);
      if (Object.keys(rawMap).length === 0) {
        return emptyUserConfigFile();
      }
      return yield* decodeUserConfigFile(pathValue, rawMap);
    });

    const readProjectConfigFile = Effect.fn(function* (pathValue: string) {
      const rawMap = yield* readJsonMap(pathValue);
      if (Object.keys(rawMap).length === 0) {
        return emptyProjectConfigFile();
      }
      return yield* decodeProjectConfigFile(pathValue, rawMap);
    });

    const readResolvedUserConfig = Effect.fn(function* () {
      const pathValue = yield* userConfigPath;
      const config = yield* readUserConfigFile(pathValue);

      return {
        ...config,
        ...(typeof config.api_key === "string"
          ? { api_key: yield* expandEnv(config.api_key) }
          : {}),
        ...(typeof config.base_url === "string"
          ? { base_url: yield* expandEnv(config.base_url) }
          : {}),
        ...(typeof config.model === "string" ? { model: yield* expandEnv(config.model) } : {}),
      } satisfies UserConfigFile;
    });

    const readUserField = (key: string) =>
      Effect.map(readResolvedUserConfig(), (config) =>
        jsonValueToString(config[key as keyof typeof config]),
      );

    const writeUserField: ConfigServiceShape["writeUserField"] = (key, value) =>
      Effect.gen(function* () {
        const def = getKeyDef(key);
        if (def == null) {
          return yield* configError(`unknown config key "${key}"`);
        }

        const pathValue = yield* userConfigPath;
        const config = { ...(yield* readUserConfigFile(pathValue)) };

        switch (def.type) {
          case "bool":
            config[key as keyof UserConfigFile] = (value === "true") as never;
            break;
          default:
            config[key as keyof UserConfigFile] = value as never;
        }

        yield* writeJsonMap(pathValue, config satisfies JsonMap);
      }).pipe(Effect.asVoid);

    const readProjectField = (pathValue: string, key: string) =>
      Effect.map(readProjectConfigFile(pathValue), (config) =>
        jsonValueToString(config[key as keyof ProjectConfigFile]),
      );

    const writeProjectField: ConfigServiceShape["writeProjectField"] = (pathValue, key, value) =>
      Effect.gen(function* () {
        const def = getKeyDef(key);
        if (def == null) {
          return yield* configError(`unknown config key "${key}"`);
        }

        const config = { ...(yield* readProjectConfigFile(pathValue)) };

        switch (def.type) {
          case "bool":
            config[key as keyof ProjectConfigFile] = (value === "true") as never;
            break;
          case "int":
            config[key as keyof ProjectConfigFile] = Number(value) as never;
            break;
          case "stringslice":
            config[key as keyof ProjectConfigFile] = value
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0) as never;
            break;
          default:
            config[key as keyof ProjectConfigFile] = value as never;
        }

        yield* writeJsonMap(pathValue, config satisfies JsonMap);
      }).pipe(Effect.asVoid);

    const loadProjectConfig: ConfigServiceShape["loadProjectConfig"] = Effect.fn(function* (
      repoRoot: string,
    ) {
      const projectPath = yield* projectConfigPath(repoRoot);
      const localPath = yield* localConfigPath(repoRoot);
      const [projectConfigFile, localConfigFile] = yield* Effect.all([
        readProjectConfigFile(projectPath),
        readProjectConfigFile(localPath),
      ]);

      const config = {
        scopes:
          (localConfigFile.scopes?.length ?? 0) > 0
            ? (localConfigFile.scopes ?? [])
            : (projectConfigFile.scopes ?? []),
        hooks:
          (localConfigFile.hook?.length ?? 0) > 0
            ? (localConfigFile.hook ?? [])
            : (projectConfigFile.hook ?? []),
        maxDiffLines: localConfigFile.max_diff_lines ?? projectConfigFile.max_diff_lines ?? 0,
        noCommitCoAuthor:
          localConfigFile.no_commit_co_author ?? projectConfigFile.no_commit_co_author ?? false,
        noModelCoAuthor:
          localConfigFile.no_model_co_author ?? projectConfigFile.no_model_co_author ?? false,
      } satisfies ProjectConfig;

      return isEmptyProjectConfig(config) ? undefined : config;
    });

    const mergeScopes: ConfigServiceShape["mergeScopes"] = (pathValue, nextScopes) =>
      Effect.gen(function* () {
        const config = { ...(yield* readProjectConfigFile(pathValue)) };
        const existingScopes = config.scopes ?? [];
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

        config.scopes = merged;
        yield* writeJsonMap(pathValue, config satisfies JsonMap);
      }).pipe(Effect.asVoid);

    const readGitConfig = (cwd: string, key: string) =>
      Effect.map(
        runProcess({
          command: "git",
          args: ["config", "--local", "--get", `ai-commit.${key}`],
          cwd,
          allowFailure: true,
        }).pipe(Effect.provideService(ChildProcessSpawner, spawner)),
        (result) => (result.exitCode === 0 ? result.stdout.trim() : ""),
      ).pipe(Effect.mapError((cause) => configError(`failed to read git config "${key}"`, cause)));

    const resolveProviderConfig: ConfigServiceShape["resolveProviderConfig"] = Effect.fn(
      "Config.ResolveProvider",
    )(function* ({ cwd, apiKey, baseUrl, model, vcs }: ProviderConfigInput) {
      const fileApiKey = yield* readUserField("api_key");
      const fileBaseUrl = yield* readUserField("base_url");
      const fileModel = yield* readUserField("model");
      const fileNoCommitCoAuthor = yield* readUserField("no_commit_co_author");
      const fileNoModelCoAuthor = yield* readUserField("no_model_co_author");
      const gitModel = vcs === "git" ? yield* readGitConfig(cwd, "model") : "";
      const gitBaseUrl = vcs === "git" ? yield* readGitConfig(cwd, "base-url") : "";

      return {
        apiKey: firstNonEmpty(apiKey, fileApiKey, environment.apiKey) ?? "",
        baseUrl:
          firstNonEmpty(baseUrl, gitBaseUrl, fileBaseUrl, environment.baseUrl) ?? DefaultBaseUrl,
        model: firstNonEmpty(model, gitModel, fileModel, environment.model) ?? DefaultModel,
        noCommitCoAuthor: fileNoCommitCoAuthor === "true",
        noModelCoAuthor: fileNoModelCoAuthor === "true",
      } satisfies ProviderConfig;
    });

    const resolveField: ConfigServiceShape["resolveField"] = Effect.fn("Config.ResolveField")(
      function* (repoRoot: string | undefined, key: string) {
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
      },
    );

    return {
      projectConfigPath,
      localConfigPath,
      resolveProviderConfig,
      resolveField,
      writeUserField,
      writeProjectField,
      loadProjectConfig,
      mergeScopes,
    } satisfies ConfigServiceShape;
  }),
);
