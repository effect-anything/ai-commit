import { Config, Effect, Option } from "effect";

export const DefaultBaseUrl = "https://api.openai.com/v1";
export const DefaultModel = "gpt-4.1-mini";
export const DefaultGitignoreBaseUrl = "https://www.toptal.com/developers/gitignore/api";

export const envString = (name: string) => Config.string(name);

export const envOptionalString = (name: string) => Config.option(envString(name));

export const envStringWithDefault = (name: string, fallback: string) =>
  envString(name).pipe(Config.withDefault(fallback));

const readPreferredEnv = (names: ReadonlyArray<string>, fallback: string) =>
  Effect.gen(function* () {
    for (const name of names) {
      const value = yield* envOptionalString(name);
      if (Option.isSome(value) && value.value.trim().length > 0) {
        return value.value.trim();
      }
    }
    return fallback;
  });

export const buildEnvironment = Effect.gen(function* () {
  const apiKey = yield* readPreferredEnv(["OPENAI_COMPACT_API_KEY", "GIT_AGENT_BUILD_API_KEY"], "");
  const baseUrl = yield* readPreferredEnv(
    ["OPENAI_COMPACT_API_BASE_URL", "GIT_AGENT_BUILD_BASE_URL"],
    DefaultBaseUrl,
  );
  const model = yield* readPreferredEnv(
    ["OPENAI_COMPACT_MODEL", "GIT_AGENT_BUILD_MODEL"],
    DefaultModel,
  );
  const gitignoreBaseUrl = yield* envStringWithDefault(
    "GIT_AGENT_GITIGNORE_BASE_URL",
    DefaultGitignoreBaseUrl,
  );
  const xdgConfigHome = yield* envOptionalString("XDG_CONFIG_HOME");

  return {
    apiKey,
    baseUrl,
    model,
    gitignoreBaseUrl,
    xdgConfigHome,
  };
});

export const cwdEnvironment = envStringWithDefault("PWD", process.cwd());
