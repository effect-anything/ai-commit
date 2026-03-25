import { homedir } from "node:os";
import { Effect, FileSystem, Option, Path } from "effect";
import { parse, stringify } from "yaml";
import { ConfigError } from "../shared/errors";
import { runProcess } from "../shared/process";
import { buildEnvironment, DefaultBaseUrl, DefaultModel, envOptionalString } from "./env";
import { localConfigPath, projectConfigPath, readProjectField } from "./project";

export interface ProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly noGitAgentCoAuthor: boolean;
  readonly noModelCoAuthor: boolean;
}

export interface ProviderConfigInput {
  readonly cwd: string;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly free: boolean | undefined;
  readonly vcs: "git" | "jj" | undefined;
}

interface FileConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  no_git_agent_co_author?: boolean;
  no_model_co_author?: boolean;
}

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
          message: `failed to read user config: ${cause.message}`,
        }),
    ),
  );

  const raw = yield* Effect.try({
    try: () => parse(text),
    catch: (cause) =>
      new ConfigError({
        message: `failed to read user config: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (typeof raw !== "object" || raw == null) {
    return {} satisfies FileConfig;
  }

  const file = raw as FileConfig;
  const expanded: FileConfig = {};
  if (typeof file.api_key === "string") {
    expanded.api_key = yield* expandEnv(file.api_key);
  }
  if (typeof file.base_url === "string") {
    expanded.base_url = yield* expandEnv(file.base_url);
  }
  if (typeof file.model === "string") {
    expanded.model = yield* expandEnv(file.model);
  }
  if (typeof file.no_git_agent_co_author === "boolean") {
    expanded.no_git_agent_co_author = file.no_git_agent_co_author;
  }
  if (typeof file.no_model_co_author === "boolean") {
    expanded.no_model_co_author = file.no_model_co_author;
  }
  return expanded;
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

export const resolveProviderConfig = Effect.fn(function* ({
  cwd,
  apiKey,
  baseUrl,
  model,
  free = false,
  vcs,
}: ProviderConfigInput) {
  const build = yield* readBuildProviderDefaults;

  if (free) {
    return {
      apiKey: build.apiKey,
      baseUrl: build.baseUrl,
      model: build.model,
      noGitAgentCoAuthor: false,
      noModelCoAuthor: false,
    } satisfies ProviderConfig;
  }

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

export const resolveField = Effect.fn(function* (repoRoot: string | undefined, key: string) {
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
            message: `failed to write user config: ${cause.message}`,
          }),
      ),
    );
    const parsed = yield* Effect.try({
      try: () => parse(existing),
      catch: (cause) =>
        new ConfigError({
          message: `failed to write user config: ${cause instanceof Error ? cause.message : String(cause)}`,
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
          message: `failed to write user config: ${cause.message}`,
        }),
    ),
  );
  yield* fs.writeFileString(pathValue, stringify(raw), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to write user config: ${cause.message}`,
        }),
    ),
  );
});

const firstNonEmpty = (...values: ReadonlyArray<string | undefined>): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.length > 0);
