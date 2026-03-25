import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  defaultScopeForKey,
  normalizeValue,
  resolveKey,
  ScopeLocal,
  ScopeProject,
  ScopeUser,
  type ConfigScope,
  validateScope,
} from "../config/keys";
import {
  readBuildProviderDefaults,
  resolveField,
  resolveProviderConfig,
  writeUserField,
} from "../config/provider";
import { localConfigPath, projectConfigWritePath, writeProjectField } from "../config/project";
import { installHookValue } from "../services/hooks";
import { Vcs } from "../services/vcs";
import {
  apiKeyFlag,
  baseUrlFlag,
  cwdFlag,
  freeFlag,
  modelFlag,
  toOptionalString,
  vcsFlag,
} from "./shared";

const outputResolvedProvider = Effect.fn(function* (
  cwd: string,
  vcs: "git" | "jj",
  apiKey: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined,
  free: boolean,
) {
  const config = yield* Effect.withSpan(
    resolveProviderConfig({
      cwd,
      vcs,
      apiKey,
      baseUrl,
      model,
      free,
    }),
    "config.resolve-provider",
    {
      attributes: {
        vcs,
        free,
      },
    },
  );
  const build = yield* readBuildProviderDefaults;
  if (build.apiKey.length > 0 && config.apiKey === build.apiKey) {
    yield* Console.log("mode: FREE (using built-in credentials)");
    return;
  }
  const masked =
    config.apiKey.length === 0
      ? "(not set)"
      : config.apiKey.length <= 4
        ? "****"
        : `${config.apiKey.slice(0, 4)}****`;
  yield* Console.log(`api_key:  ${masked}\nmodel:    ${config.model}\nbase_url: ${config.baseUrl}`);
});

const configShow = Command.make(
  "show",
  {
    cwd: cwdFlag,
    vcs: vcsFlag,
    apiKey: apiKeyFlag,
    baseUrl: baseUrlFlag,
    model: modelFlag,
    free: freeFlag,
  },
  Effect.fn(function* (input) {
    const vcsService = yield* Vcs;
    const vcsKind = yield* vcsService.detect(input.cwd, toOptionalString(input.vcs));
    yield* outputResolvedProvider(
      input.cwd,
      vcsKind,
      toOptionalString(input.apiKey),
      toOptionalString(input.baseUrl),
      toOptionalString(input.model),
      input.free,
    );
  }),
).pipe(Command.withDescription("Show resolved provider configuration."));

const configGet = Command.make(
  "get",
  {
    cwd: cwdFlag,
    vcs: vcsFlag,
    key: Argument.string("key").pipe(Argument.withDescription("Configuration key to read.")),
  },
  Effect.fn(function* (input) {
    const key = resolveKey(input.key);
    const vcsService = yield* Vcs;
    const { kind: vcsKind, client: vcs } = yield* vcsService.resolve(
      input.cwd,
      toOptionalString(input.vcs),
    );
    const isRepo = yield* vcs.isRepo(input.cwd);
    const repoRoot = isRepo ? yield* vcs.repoRoot(input.cwd) : undefined;
    const resolved = yield* Effect.withSpan(resolveField(repoRoot, key), "config.resolve-field", {
      attributes: {
        key,
        vcs: vcsKind,
        in_repo: isRepo,
      },
    });
    if (resolved == null) {
      yield* Console.log(`${key} is not set`);
      return;
    }
    yield* Console.log(`${key} = ${resolved.value}  (from ${resolved.scope})`);
  }),
).pipe(Command.withDescription("Show the resolved value of a configuration key."));

const configSet = Command.make(
  "set",
  {
    cwd: cwdFlag,
    vcs: vcsFlag,
    key: Argument.string("key").pipe(Argument.withDescription("Configuration key to write.")),
    value: Argument.string("value").pipe(Argument.withDescription("Configuration value to write.")),
    scope: Flag.optional(
      Flag.choice("scope", [ScopeUser, ScopeProject, ScopeLocal] as const).pipe(
        Flag.withDescription(
          "Target scope. Defaults to user for provider keys, project otherwise.",
        ),
      ),
    ),
  },
  Effect.fn(function* (input) {
    const key = resolveKey(input.key);
    const value = normalizeValue(key, input.value);
    const scope = (toOptionalString(input.scope) ?? defaultScopeForKey(key)) as ConfigScope;
    validateScope(key, scope);

    if (scope === ScopeUser) {
      yield* writeUserField(key, value);
      yield* Console.log(`set ${key} = ${value}  (user)`);
      return;
    }

    const vcsService = yield* Vcs;
    const { client: vcs } = yield* vcsService.resolve(input.cwd, toOptionalString(input.vcs));
    const repoRoot = yield* vcs.repoRoot(input.cwd);
    const prepared = yield* installHookValue(repoRoot, key, value);
    if (prepared.installedFrom != null) {
      yield* Console.log(`installed hook: ${prepared.installedFrom}`);
    }
    const path = yield* scope === ScopeLocal
      ? localConfigPath(repoRoot)
      : projectConfigWritePath(repoRoot);
    yield* writeProjectField(path, key, prepared.value);
    yield* Console.log(`set ${key} = ${prepared.value}  (${scope})`);
  }),
).pipe(Command.withDescription("Write a configuration value."));

export const commandConfig = Command.make("config").pipe(
  Command.withDescription("Manage git-agent configuration."),
  Command.withSubcommands([configShow, configGet, configSet]),
);
