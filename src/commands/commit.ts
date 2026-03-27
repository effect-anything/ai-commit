import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadProjectConfig } from "../config/project.ts";
import { resolveProviderConfig } from "../config/provider.ts";
import { parseTrailerText, type Trailer } from "../domain/commit.ts";
import { emptyProjectConfig } from "../domain/project.ts";
import { CommitService } from "../services/commit-service.ts";
import { Vcs } from "../services/vcs.ts";
import { ConfigError } from "../shared/errors.ts";
import { printCommitResult, printDryRunResult } from "../shared/output.ts";
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

const parseTrailers = Effect.fn("Commit.ParseTrailers")(function* (
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
      value: "Ai Commit <41898282+github-actions[bot]@users.noreply.github.com>",
    });
  }

  return trailers;
});

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
      Flag.withAlias("--no-ai-commit"),
      Flag.withDescription("Omit the default AI Commit trailer."),
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
  Effect.fn("Command.Commit")(function* (input) {
    yield* Effect.annotateCurrentSpan({
      amend: input.amend,
      dry_run: input.dryRun,
      no_stage: input.noStage,
      vcs: toOptionalString(input.vcs) ?? "auto",
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

    yield* Effect.annotateCurrentSpan({ vcs: vcsKind });

    const provider = yield* resolveProviderConfig({
      cwd: input.cwd,
      vcs: vcsKind,
      apiKey: toOptionalString(input.apiKey),
      baseUrl: toOptionalString(input.baseUrl),
      model: toOptionalString(input.model),
    });

    if (provider.apiKey.length === 0) {
      return yield* new ConfigError({
        message:
          "no API key configured (hint: set --api-key, add api_key to ~/.config/ai-commit/config.yml, or use build-time embedded credentials)",
      });
    }

    const repoRoot = yield* vcs.repoRoot(input.cwd);
    const projectConfig = (yield* loadProjectConfig(repoRoot)) ?? emptyProjectConfig();

    const trailers = yield* parseTrailers(
      input.coAuthor,
      input.trailer,
      !(provider.noCommitCoAuthor || projectConfig.noCommitCoAuthor || input.noAttribution),
      provider.noModelCoAuthor || projectConfig.noModelCoAuthor,
    );

    const commitService = yield* CommitService;
    const commits = yield* commitService.run({
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

    if (input.dryRun) {
      yield* printDryRunResult(commits);
      return;
    }

    if (commits.length === 0) {
      yield* Console.log("no changes committed");
      return;
    }

    yield* printCommitResult(commits);
  }),
).pipe(Command.withDescription("Generate and create commit(s) with AI-generated messages."));
