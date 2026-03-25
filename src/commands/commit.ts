import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadProjectConfig } from "../config/project";
import { resolveProviderConfig } from "../config/provider";
import { parseTrailerText, type Trailer } from "../domain/commit";
import { emptyProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { printCommitResult, printDryRunResult } from "../shared/output";
import { parseCsvValues } from "../shared/text";
import { runCommitService } from "../services/commit-service";
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

const parseTrailers = Effect.fn(function* (
  coAuthors: ReadonlyArray<string>,
  trailerValues: ReadonlyArray<string>,
  includeAttribution: boolean,
  ignoreCoAuthor: boolean,
) {
  const trailers: Array<Trailer> = [];
  if (!ignoreCoAuthor) {
    for (const value of parseCsvValues(coAuthors)) {
      trailers.push({
        key: "Co-Authored-By",
        value,
      });
    }
  }
  for (const value of parseCsvValues(trailerValues)) {
    const trailer = parseTrailerText(value);
    if (trailer == null) {
      return yield* new ConfigError({
        message: `invalid --trailer format "${value}": expected "Key: Value"`,
      });
    }
    trailers.push({
      key: trailer.key,
      value: trailer.value,
    });
  }
  if (includeAttribution) {
    trailers.push({
      key: "Co-Authored-By",
      value: "Git Agent <noreply@git-agent.dev>",
    });
  }
  return trailers;
});

interface CommitCommandInput {
  readonly cwd: string;
  readonly vcs: Option.Option<string>;
  readonly apiKey: Option.Option<string>;
  readonly baseUrl: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly free: boolean;
  readonly intent: Option.Option<string>;
  readonly dryRun: boolean;
  readonly noStage: boolean;
  readonly amend: boolean;
  readonly maxDiffLines: number;
  readonly noAttribution: boolean;
  readonly coAuthor: ReadonlyArray<string>;
  readonly trailer: ReadonlyArray<string>;
}

const runCommitCommand = (input: CommitCommandInput) => {
  const requestedVcs = toOptionalString(input.vcs) ?? "auto";
  return Effect.withSpan(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        amend: input.amend,
        dry_run: input.dryRun,
        no_stage: input.noStage,
        requested_vcs: requestedVcs,
      });
      if (input.amend && input.noStage) {
        return yield* new ConfigError({
          message: "--amend and --no-stage cannot be used together",
        });
      }

      const vcsService = yield* Vcs;
      const { kind: vcsKind, client: vcs } = yield* vcsService.resolve(
        input.cwd,
        toOptionalString(input.vcs),
      );
      yield* Effect.annotateCurrentSpan({
        vcs: vcsKind,
      });
      const provider = yield* Effect.withSpan(
        resolveProviderConfig({
          cwd: input.cwd,
          vcs: vcsKind,
          apiKey: toOptionalString(input.apiKey),
          baseUrl: toOptionalString(input.baseUrl),
          model: toOptionalString(input.model),
          free: input.free,
        }),
        "commit.resolve-provider",
        {
          attributes: {
            requested_vcs: requestedVcs,
            vcs: vcsKind,
            free: input.free,
          },
          captureStackTrace: false,
        },
      );

      if (provider.apiKey.length === 0) {
        return yield* new ConfigError({
          message:
            "error: no API key configured\nhint: set --api-key, add api_key to ~/.config/git-agent/config.yml, or use build-time embedded credentials",
        });
      }

      const repoRoot = yield* vcs.repoRoot(input.cwd);
      const projectConfig =
        (yield* Effect.withSpan(loadProjectConfig(repoRoot), "commit.load-project-config", {
          attributes: {
            vcs: vcsKind,
          },
          captureStackTrace: false,
        })) ?? emptyProjectConfig();
      const trailers = yield* parseTrailers(
        input.coAuthor,
        input.trailer,
        !(provider.noGitAgentCoAuthor || projectConfig.noGitAgentCoAuthor || input.noAttribution),
        provider.noModelCoAuthor || projectConfig.noModelCoAuthor,
      );

      return yield* Effect.withSpan(
        runCommitService({
          cwd: repoRoot,
          provider,
          vcs,
          projectConfig,
          intent: toOptionalString(input.intent),
          trailers,
          dryRun: input.dryRun,
          noStage: input.noStage,
          amend: input.amend,
          maxDiffLines: input.maxDiffLines > 0 ? input.maxDiffLines : projectConfig.maxDiffLines,
        }),
        "commit.run",
        {
          attributes: {
            vcs: vcsKind,
            dry_run: input.dryRun,
            no_stage: input.noStage,
            amend: input.amend,
          },
          captureStackTrace: false,
        },
      );
    }),
    "commit.prepare-request",
    {
      attributes: {
        amend: input.amend,
        dry_run: input.dryRun,
        no_stage: input.noStage,
        requested_vcs: requestedVcs,
      },
      captureStackTrace: false,
    },
  );
};

export const commandCommit = Command.make(
  "commit",
  {
    cwd: cwdFlag,
    vcs: vcsFlag,
    apiKey: apiKeyFlag,
    baseUrl: baseUrlFlag,
    model: modelFlag,
    free: freeFlag,
    intent: Flag.optional(
      Flag.string("intent").pipe(Flag.withDescription("Describe the intent of the change.")),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Print messages without committing."),
    ),
    noStage: Flag.boolean("no-stage").pipe(Flag.withDescription("Skip auto-staging; git only.")),
    amend: Flag.boolean("amend").pipe(
      Flag.withDescription("Regenerate and amend the previous commit."),
    ),
    maxDiffLines: Flag.integer("max-diff-lines").pipe(
      Flag.withDefault(0),
      Flag.withDescription("Maximum diff lines to send to the model. 0 means unlimited."),
    ),
    noAttribution: Flag.boolean("no-attribution").pipe(
      Flag.withAlias("--no-git-agent"),
      Flag.withDescription("Omit the default Git Agent trailer."),
    ),
    coAuthor: Flag.string("co-author").pipe(
      Flag.withDescription("Co-author trailer. Repeat the flag or use comma-separated values."),
      Flag.between(0, Number.MAX_SAFE_INTEGER),
    ),
    trailer: Flag.string("trailer").pipe(
      Flag.withDescription(
        'Trailer in "Key: Value" format. Repeat the flag or use comma-separated values.',
      ),
      Flag.between(0, Number.MAX_SAFE_INTEGER),
    ),
  },
  Effect.fn(function* (input) {
    const result = yield* runCommitCommand(input);
    if (result.dryRun) {
      yield* printDryRunResult(result.commits);
      return;
    }
    if (result.commits.length === 0) {
      yield* Console.log("no changes committed");
      return;
    }
    yield* printCommitResult(result.commits);
  }),
).pipe(Command.withDescription("Generate and create commit(s) with AI-generated messages."));
