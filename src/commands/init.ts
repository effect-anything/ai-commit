import { Console, Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  localConfigPath,
  mergeScopes,
  projectConfigWritePath,
  writeProjectField,
} from "../config/project.ts";
import { resolveProviderConfig } from "../config/provider.ts";
import { emptyProjectConfig } from "../domain/project.ts";
import { generateGitignore } from "../services/gitignore-service.ts";
import { generateProjectScopes } from "../services/scope-service.ts";
import { Vcs } from "../services/vcs.ts";
import { ConfigError } from "../shared/errors.ts";
import { parseCsvValues } from "../shared/text.ts";
import {
  apiKeyFlag,
  baseUrlFlag,
  cwdFlag,
  freeFlag,
  modelFlag,
  toOptionalString,
  vcsFlag,
} from "./shared.ts";

export const commandInit = Command.make(
  "init",
  {
    cwd: cwdFlag,
    vcs: vcsFlag,
    apiKey: apiKeyFlag,
    baseUrl: baseUrlFlag,
    model: modelFlag,
    free: freeFlag,
    scope: Flag.boolean("scope").pipe(Flag.withDescription("Generate scopes via AI.")),
    gitignore: Flag.boolean("gitignore").pipe(Flag.withDescription("Generate .gitignore via AI.")),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Overwrite existing config or .gitignore."),
    ),
    maxCommits: Flag.integer("max-commits").pipe(
      Flag.withDefault(200),
      Flag.withDescription("Maximum commit count to analyze for scopes."),
    ),
    local: Flag.boolean("local").pipe(
      Flag.withDescription("Write config to .git-agent/config.local.yml."),
    ),
    hook: Flag.string("hook").pipe(
      Flag.withDescription("Hook to configure. Repeat the flag or use comma-separated values."),
      Flag.between(0, Number.MAX_SAFE_INTEGER),
    ),
  },
  Effect.fn("Command.Init")(function* (input) {
    yield* Effect.annotateCurrentSpan({
      force: input.force,
      gitignore: input.gitignore,
      local: input.local,
      vcs: toOptionalString(input.vcs) ?? "auto",
      scope: input.scope,
    });

    const fs = yield* FileSystem.FileSystem;
    const vcsService = yield* Vcs;
    const { kind: vcsKind, client: vcs } = yield* vcsService.resolve(
      input.cwd,
      toOptionalString(input.vcs),
    );

    const isRepo = yield* vcs.isRepo(input.cwd);
    const hooks = parseCsvValues(input.hook);

    if (!isRepo) {
      const output = yield* Effect.withSpan(vcs.initRepo(input.cwd), "Config.InitRepository");

      if (output.length > 0) {
        yield* Console.log(output);
      }
    }

    const repoRoot = yield* vcs.repoRoot(input.cwd);
    const doScope = input.scope;
    const doGitignore = input.gitignore;
    const fullWizard = !input.scope && !input.gitignore && hooks.length === 0;

    if (input.local && !doScope && !doGitignore && hooks.length === 0) {
      return yield* new ConfigError({
        message: "--local requires at least one action flag: --scope, --gitignore, or --hook",
      });
    }

    const configPath = yield* input.local
      ? localConfigPath(repoRoot)
      : projectConfigWritePath(repoRoot);

    if (!input.force) {
      const exists = yield* fs.exists(configPath);
      if (exists) {
        return yield* new ConfigError({
          message: `${configPath} already exists (hint: use --force to reinitialize)`,
        });
      }
    }

    const provider = yield* resolveProviderConfig({
      cwd: input.cwd,
      vcs: vcsKind,
      apiKey: toOptionalString(input.apiKey),
      baseUrl: toOptionalString(input.baseUrl),
      model: toOptionalString(input.model),
    });

    if ((doGitignore || doScope || fullWizard) && provider.apiKey.length === 0) {
      return yield* new ConfigError({
        message:
          "no API key configured (hint: set --api-key or add api_key to ~/.config/git-agent/config.yml)",
      });
    }

    if (doGitignore || fullWizard) {
      const techs = yield* generateGitignore(provider, vcs, repoRoot);
      yield* Console.log(`.gitignore updated: ${techs.join(", ")}`);
    }

    if (doScope || fullWizard) {
      const scopes = yield* generateProjectScopes(provider, vcs, repoRoot, input.maxCommits);
      yield* mergeScopes(configPath, scopes);
      yield* Console.log(`scopes written to ${configPath}`);
    }

    if (fullWizard) {
      yield* Effect.withSpan(
        writeProjectField(configPath, "hook", "conventional"),
        "Init.WriteDefaultHook",
      );
    } else if (hooks.length > 0) {
      yield* Effect.withSpan(
        writeProjectField(configPath, "hook", hooks.join(",")),
        "Init.WriteHook",
      );
    }

    if (!doScope && !doGitignore && !fullWizard && hooks.length > 0) {
      yield* mergeScopes(configPath, emptyProjectConfig().scopes);
    }
  }),
).pipe(Command.withDescription("Initialize git-agent in the current repository."));
