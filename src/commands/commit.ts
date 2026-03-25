import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadProjectConfig } from "../config/project";
import { resolveProviderConfig } from "../config/provider";
import { parseTrailerText, type Trailer } from "../domain/commit";
import { emptyProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { printCommitResult, printDryRunResult } from "../shared/output";
import { parseCsvValues } from "../shared/text";
import { withProgressSpan } from "../shared/tracing";
import { runCommitService } from "../services/commit-service";
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

const parseTrailers = (
  coAuthors: ReadonlyArray<string>,
  trailerValues: ReadonlyArray<string>,
  includeAttribution: boolean,
  ignoreCoAuthor: boolean,
): Effect.Effect<Array<Trailer>, ConfigError> =>
  Effect.gen(function* () {
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
        return yield* Effect.fail(
          new ConfigError({
            message: `invalid --trailer format "${value}": expected "Key: Value"`,
          }),
        );
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

const runCommitCommand = Effect.fn(
  function* (input) {
    if (input.amend && input.noStage) {
      return yield* Effect.fail(
        new ConfigError({ message: "--amend and --no-stage cannot be used together" }),
      );
    }

    const vcsKind = yield* detectVcs(input.cwd, toOptionalString(input.vcs));
    yield* Effect.annotateCurrentSpan({
      vcs: vcsKind,
    });
    const vcs = getVcsClient(vcsKind);
    const provider = yield* resolveProviderConfig({
      cwd: input.cwd,
      vcs: vcsKind,
      apiKey: toOptionalString(input.apiKey),
      baseUrl: toOptionalString(input.baseUrl),
      model: toOptionalString(input.model),
      free: input.free,
    });

    if (provider.apiKey.length === 0) {
      return yield* Effect.fail(
        new ConfigError({
          message:
            "error: no API key configured\nhint: set --api-key, add api_key to ~/.config/git-agent/config.yml, or use build-time embedded credentials",
        }),
      );
    }

    const repoRoot = yield* vcs.repoRoot(input.cwd);
    const projectConfig = (yield* loadProjectConfig(repoRoot)) ?? emptyProjectConfig();
    const trailers = yield* parseTrailers(
      input.coAuthor,
      input.trailer,
      !(provider.noGitAgentCoAuthor || projectConfig.noGitAgentCoAuthor || input.noAttribution),
      provider.noModelCoAuthor || projectConfig.noModelCoAuthor,
    );

    return yield* runCommitService({
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
    });
  },
  (effect, input) =>
    withProgressSpan(effect, "commit.prepare-request", {
      amend: input.amend,
      dry_run: input.dryRun,
      no_stage: input.noStage,
      requested_vcs: toOptionalString(input.vcs) ?? "auto",
    }),
);

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
