import { Console, Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  projectConfigWritePath,
  localConfigPath,
  mergeAndSaveScopes,
  projectConfigPath,
  writeProjectField,
} from "../config/project";
import { resolveProviderConfig } from "../config/provider";
import { emptyProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { parseCsvValues } from "../shared/text";
import { withProgressSpan } from "../shared/tracing";
import { generateGitignore } from "../services/gitignore-service";
import { generateProjectScopes } from "../services/scope-service";
import { detectVcs, getVcsClient } from "../services/vcs";
import {
  apiKeyFlag,
  baseUrlFlag,
  cwdFlag,
  freeFlag,
  modelFlag,
  toOptionalString,
  vcsFlag,
} from "./shared";

const runInitCommand = Effect.fn(
  function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const vcsKind = yield* detectVcs(input.cwd, toOptionalString(input.vcs));
    yield* Effect.annotateCurrentSpan({
      vcs: vcsKind,
    });
    const vcs = getVcsClient(vcsKind);
    const isRepo = yield* vcs.isRepo(input.cwd);
    const hooks = parseCsvValues(input.hook);
    if (!isRepo) {
      const output = yield* withProgressSpan(vcs.initRepo(input.cwd), "init.initialize-repository", {
        vcs: vcsKind,
      });
      if (output.length > 0) {
        yield* Console.log(output);
      }
    }

    const repoRoot = yield* vcs.repoRoot(input.cwd);
    const doScope = input.scope;
    const doGitignore = input.gitignore;
    const fullWizard = !input.scope && !input.gitignore && hooks.length === 0;

    if (input.local && !doScope && !doGitignore && hooks.length === 0) {
      return yield* Effect.fail(
        new ConfigError({
          message: "--local requires at least one action flag: --scope, --gitignore, or --hook",
        }),
      );
    }

    const configPath = yield* input.local ? localConfigPath(repoRoot) : projectConfigWritePath(repoRoot);
    if (!input.force) {
      const exists = yield* fs.exists(configPath);
      if (exists) {
        return yield* Effect.fail(
          new ConfigError({
            message: `${yield* projectConfigPath(repoRoot)} already exists\nhint: use --force to reinitialize`,
          }),
        );
      }
    }

    const provider = yield* resolveProviderConfig({
      cwd: input.cwd,
      vcs: vcsKind,
      apiKey: toOptionalString(input.apiKey),
      baseUrl: toOptionalString(input.baseUrl),
      model: toOptionalString(input.model),
      free: input.free,
    });

    if ((doGitignore || doScope || fullWizard) && provider.apiKey.length === 0) {
      return yield* Effect.fail(
        new ConfigError({
          message:
            "error: no API key configured\nhint: set --api-key or add api_key to ~/.config/git-agent/config.yml",
        }),
      );
    }

    if (doGitignore || fullWizard) {
      const techs = yield* withProgressSpan(generateGitignore(provider, vcs, repoRoot), "init.generate-gitignore", {
        vcs: vcsKind,
        full_wizard: fullWizard,
      });
      yield* Console.log(`.gitignore updated: ${techs.join(", ")}`);
    }

    if (doScope || fullWizard) {
      const scopes = yield* withProgressSpan(
        generateProjectScopes(provider, vcs, repoRoot, input.maxCommits),
        "init.generate-scopes",
        {
          vcs: vcsKind,
          full_wizard: fullWizard,
          max_commits: input.maxCommits,
        },
      );
      yield* mergeAndSaveScopes(configPath, scopes);
      yield* Console.log(`scopes written to ${configPath}`);
    }

    if (fullWizard) {
      yield* withProgressSpan(writeProjectField(configPath, "hook", "conventional"), "init.write-default-hook", {
        path: configPath,
      });
    } else if (hooks.length > 0) {
      yield* withProgressSpan(writeProjectField(configPath, "hook", hooks.join(",")), "init.write-hook", {
        path: configPath,
        hook_count: hooks.length,
      });
    }

    if (!doScope && !doGitignore && !fullWizard && hooks.length > 0) {
      yield* withProgressSpan(
        mergeAndSaveScopes(configPath, emptyProjectConfig().scopes),
        "init.write-project-config",
        {
          path: configPath,
        },
      );
    }
  },
  (effect, input) =>
    withProgressSpan(effect, "init.run", {
      force: input.force,
      gitignore: input.gitignore,
      local: input.local,
      requested_vcs: toOptionalString(input.vcs) ?? "auto",
      scope: input.scope,
    }),
);

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
  Effect.fn(function* (input) {
    yield* runInitCommand(input);
  }),
).pipe(Command.withDescription("Initialize git-agent in the current repository."));
