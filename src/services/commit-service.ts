import { DateTime, Duration, Effect, Ref, Schedule, Schema } from "effect";
import type {
  CommitGroup,
  CommitMessage,
  CommitResponse,
  SingleCommitResult,
  Trailer,
} from "../domain/commit";
import { renderCommitBody } from "../domain/commit.ts";
import type { ProjectConfig } from "../domain/project.ts";
import { emptyProjectConfig } from "../domain/project.ts";
import { CommitPlanError, HookBlockedError, UnsupportedFeatureError } from "../shared/errors.ts";
import { countLines } from "../shared/text.ts";
import { executeHooks } from "./hooks.ts";
import { generateCommitMessage, planCommits, type ProviderConfig } from "./openai-client.ts";
import { generateProjectScopes } from "./scope-service.ts";
import type { VcsClient, VcsDiff } from "./vcs.ts";

const maxHookRetries = 3;
const maxReplans = 2;
const maxCommitGroups = 5;

const hookRetrySchedule = Schedule.either(
  Schedule.exponential("200 millis"),
  Schedule.spaced("1 second"),
).pipe(
  Schedule.take(maxHookRetries - 1),
  Schedule.delays,
  Schedule.tapOutput(
    Effect.fn(function* (delay) {
      const retryAt = DateTime.addDuration(yield* DateTime.now, delay);
      yield* Effect.annotateCurrentSpan({
        retry_delay: Duration.format(delay).replace(/\s+\d+ns$/, ""),
        retry_at: DateTime.formatIso(retryAt),
      });
    }),
  ),
);

export interface CommitRequest {
  readonly cwd: string;
  readonly provider: ProviderConfig;
  readonly vcs: VcsClient;
  readonly projectConfig: ProjectConfig;
  readonly intent: string | undefined;
  readonly trailers: ReadonlyArray<Trailer>;
  readonly dryRun: boolean;
  readonly noStage: boolean;
  readonly amend: boolean;
  readonly maxDiffLines: number;
}

const filterContentPatterns = [
  /^diff --git a\/.*\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|jar|exe|dll|so|dylib).*$/m,
  /^diff --git a\/.*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|Cargo\.lock).*$/m,
];

const splitDiffSections = (content: string): Array<string> => {
  if (content.trim().length === 0) {
    return [];
  }
  const sections = content.split("diff --git ").filter((section) => section.length > 0);
  return sections.map((section) => `diff --git ${section}`);
};

const filterDiffForPrompt = (diff: VcsDiff): VcsDiff => {
  const keptSections = splitDiffSections(diff.content).filter((section) =>
    filterContentPatterns.every((pattern) => !pattern.test(section)),
  );
  const content = keptSections.join("");
  return {
    files: [...diff.files],
    content,
    lines: countLines(content),
  };
};

const truncateDiff = (diff: VcsDiff, maxLines: number): VcsDiff => {
  if (maxLines <= 0 || diff.lines <= maxLines) {
    return diff;
  }
  const lines = diff.content.split("\n").slice(0, maxLines);
  const content = lines.join("\n");
  return {
    files: [...diff.files],
    content,
    lines: countLines(content),
  };
};

const filterPlanFiles = (
  groups: ReadonlyArray<CommitGroup>,
  allowed: ReadonlySet<string>,
): Array<CommitGroup> =>
  groups
    .map((group) => ({
      ...group,
      files: group.files.filter((file) => allowed.has(file)),
    }))
    .filter((group) => group.files.length > 0);

export const normalizePlannedGroups = (
  groups: Array<CommitGroup>,
  allowed: ReadonlySet<string>,
  stagedFiles: ReadonlyArray<string> = [],
): Array<CommitGroup> => {
  const inPlan = new Set(groups.flatMap((group) => group.files));
  const passthrough = [...allowed].filter((file) => !inPlan.has(file)).sort();
  const staged = stagedFiles.filter((file) => allowed.has(file));
  const stagedSet = new Set(staged);
  const [first = { files: [], message: undefined }, ...rest] = groups;
  const firstFiles = [
    ...staged,
    ...first.files.filter((file) => !stagedSet.has(file)),
    ...passthrough.filter((file) => !stagedSet.has(file)),
  ];

  if (firstFiles.length === 0) {
    return [];
  }

  return [
    {
      ...first,
      files: firstFiles,
    },
    ...rest
      .map((group) => ({
        ...group,
        files: group.files.filter((file) => !stagedSet.has(file)),
      }))
      .filter((group) => group.files.length > 0),
  ];
};

const hasUnscopedGroups = (groups: ReadonlyArray<CommitGroup>): boolean =>
  groups.some((group) => group.message != null && group.message.title.includes("(") === false);

const commitStepLabel = (completed: number, queued: number): string => `${completed + 1}/${queued}`;

const formatFileList = (files: ReadonlyArray<string>): string => files.slice().sort().join(", ");

const duplicatePlanFiles = (groups: ReadonlyArray<CommitGroup>): Array<string> => {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
};

export const validateCommitPlan = (
  vcs: VcsClient,
  groups: ReadonlyArray<CommitGroup>,
): Effect.Effect<ReadonlyArray<CommitGroup>, CommitPlanError> => {
  const duplicates = duplicatePlanFiles(groups);
  if (duplicates.length === 0) {
    return Effect.succeed(groups);
  }
  return Effect.fail(
    new CommitPlanError({
      message: `planner returned overlapping files for ${vcs.kind}: ${formatFileList(duplicates)}`,
    }),
  );
};

const expectedRemainingFiles = (groups: ReadonlyArray<CommitGroup>): Array<string> =>
  [...new Set(groups.flatMap((group) => group.files))].sort();

export const ensureJjWorkingCopyMatchesPlan = Effect.fn(function* (
  request: CommitRequest,
  remaining: ReadonlyArray<CommitGroup>,
) {
  const actual = [...(yield* request.vcs.unstagedDiff(request.cwd)).files].sort();
  const expected = expectedRemainingFiles(remaining);
  if (
    actual.length === expected.length &&
    actual.every((file, index) => file === expected[index])
  ) {
    return;
  }
  return yield* new CommitPlanError({
    message:
      `jj working copy drifted after commit; expected remaining files: ${expected.length === 0 ? "(none)" : formatFileList(expected)}; ` +
      `actual remaining files: ${actual.length === 0 ? "(none)" : formatFileList(actual)}`,
  });
});

const assembleMessage = (message: CommitMessage): string => {
  const body = renderCommitBody(message);
  return body.length === 0 ? message.title : `${message.title}\n\n${body}`;
};

const withAutoScopes = Effect.fn(function* (
  provider: ProviderConfig,
  vcs: VcsClient,
  cwd: string,
  projectConfig?: ProjectConfig | undefined | undefined,
) {
  if (projectConfig != null && projectConfig.scopes.length > 0) {
    return projectConfig;
  }
  const scopes = yield* generateProjectScopes(provider, vcs, cwd, 200);
  const nextConfig = {
    ...(projectConfig ?? emptyProjectConfig()),
    scopes,
  } satisfies ProjectConfig;
  return nextConfig;
});

const planGroups = Effect.fn("Commit.PlanGroups")(function* (
  provider: ProviderConfig,
  stagedFiles: ReadonlyArray<string>,
  unstagedFiles: ReadonlyArray<string>,
  intent: string | undefined,
  config: ProjectConfig,
) {
  yield* Effect.annotateCurrentSpan({
    staged_files: stagedFiles.length,
    unstaged_files: unstagedFiles.length,
  });

  const allFiles = [...new Set([...stagedFiles, ...unstagedFiles])];
  if (allFiles.length === 1) {
    return [{ files: allFiles, message: undefined }] satisfies Array<CommitGroup>;
  }

  const plan = yield* planCommits({
    provider,
    stagedFiles,
    unstagedFiles,
    intent,
    config,
  });

  const allowed = new Set(allFiles);
  const filtered = filterPlanFiles(plan.groups, allowed);

  return normalizePlannedGroups(filtered, allowed, stagedFiles).slice(0, maxCommitGroups);
});

class RetryableHookRejectionError extends Schema.TaggedErrorClass<RetryableHookRejectionError>()(
  "RetryableHookRejectionError",
  {
    reason: Schema.String,
    lastMessage: Schema.String,
  },
) {
  static is = Schema.is(this);
}

interface AcceptedCommitMessageResult {
  readonly _tag: "Accepted";
  readonly message: CommitMessage;
  readonly finalMessage: string;
}

interface RejectedCommitMessageResult {
  readonly _tag: "Rejected";
  readonly reason: string;
  readonly lastMessage: string;
}

const isRetryableHookRejection = (error: unknown): error is RetryableHookRejectionError =>
  RetryableHookRejectionError.is(error);

const generateCommitMessageWithHooks = Effect.fn("Commit.ResolveMessage")(function* (
  request: CommitRequest,
  config: ProjectConfig,
  options: {
    readonly promptDiff: VcsDiff;
    readonly groupDiff: VcsDiff;
    readonly initialHookFeedback: string;
    readonly groupIndex: number;
    readonly groupTotal: number;
  },
) {
  const retryState = yield* Ref.make({
    hookFeedback: options.initialHookFeedback,
    previousMessage: undefined as string | undefined,
  });

  yield* Effect.annotateCurrentSpan({
    group_index: options.groupIndex,
    group_total: options.groupTotal,
    file_count: options.groupDiff.files.length,
    hook_count: config.hooks.length,
  });

  return yield* Effect.gen(function* () {
    const { hookFeedback, previousMessage } = yield* Ref.get(retryState);

    const message = yield* generateCommitMessage({
      provider: request.provider,
      diff: options.promptDiff,
      intent: request.intent,
      config,
      hookFeedback: hookFeedback.length > 0 ? hookFeedback : undefined,
      previousMessage,
    });

    const assembled = yield* request.vcs.formatTrailers(
      request.cwd,
      assembleMessage(message),
      request.trailers,
    );

    const accepted = {
      _tag: "Accepted",
      message,
      finalMessage: assembled,
    } satisfies AcceptedCommitMessageResult;

    if (config.hooks.length === 0) {
      return accepted;
    }

    const hookResult = yield* executeHooks(config.hooks, {
      diff: options.groupDiff.content,
      commitMessage: assembled,
      intent: request.intent,
      stagedFiles: options.groupDiff.files,
      config,
    });

    if (hookResult.exitCode === 0) {
      return accepted;
    }

    yield* Ref.set(retryState, {
      hookFeedback: hookResult.stderr,
      previousMessage: assembled,
    });

    return yield* new RetryableHookRejectionError({
      reason: hookResult.stderr,
      lastMessage: assembled,
    });
  }).pipe(
    Effect.retry({
      while: isRetryableHookRejection,
      schedule: hookRetrySchedule,
    }),
    Effect.catchTag("RetryableHookRejectionError", (error) =>
      Effect.succeed({
        _tag: "Rejected",
        reason: error.reason,
        lastMessage: error.lastMessage,
      } satisfies RejectedCommitMessageResult),
    ),
  );
});

const commitGit = Effect.fn("Commit.Run")(function* (
  request: CommitRequest,
  config: ProjectConfig,
) {
  const { promptStaged, promptUnstaged } = yield* Effect.gen(function* () {
    const preStaged = request.noStage
      ? yield* request.vcs.stagedDiff(request.cwd)
      : yield* request.vcs.stagedDiff(request.cwd);

    let staged = preStaged;
    let unstaged = request.noStage
      ? ({ files: [], content: "", lines: 0 } satisfies VcsDiff)
      : yield* request.vcs.unstagedDiff(request.cwd);

    if (!request.noStage) {
      yield* request.vcs.addAll(request.cwd);
      const full = yield* request.vcs.stagedDiff(request.cwd);

      if (full.files.length === 0) {
        return yield* new UnsupportedFeatureError({ message: "no changes" });
      }

      if (preStaged.files.length === 0) {
        staged = { files: [], content: "", lines: 0 };
        unstaged = full;
      } else {
        const userStaged = new Set(preStaged.files);
        const newFiles = full.files.filter((file) => !userStaged.has(file));
        staged = preStaged;
        unstaged =
          newFiles.length === 0
            ? { files: [], content: "", lines: 0 }
            : yield* request.vcs.diffForFiles(request.cwd, newFiles);
      }
    } else if (staged.files.length === 0) {
      return yield* new UnsupportedFeatureError({
        message: "no staged changes (hint: stage files with git add, or remove --no-stage)",
      });
    }

    const promptStaged =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(staged), request.maxDiffLines)
        : filterDiffForPrompt(staged);

    const promptUnstaged =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(unstaged), request.maxDiffLines)
        : filterDiffForPrompt(unstaged);

    return { promptStaged, promptUnstaged };
  }).pipe(Effect.withSpan("Commit.ScanChanges"));

  const configWithScopes =
    config.scopes.length > 0
      ? config
      : yield* withAutoScopes(request.provider, request.vcs, request.cwd, config);

  let groups = yield* planGroups(
    request.provider,
    promptStaged.files,
    promptUnstaged.files,
    request.intent,
    configWithScopes,
  ).pipe(Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)));

  if (configWithScopes.scopes.length > 0 && hasUnscopedGroups(groups)) {
    // TODO: rename span name
    const refreshedScopes = yield* Effect.withSpan(
      generateProjectScopes(request.provider, request.vcs, request.cwd, 200),
      "Commit.RefreshScopes",
    );
    groups = yield* Effect.withSpan(
      planGroups(request.provider, promptStaged.files, promptUnstaged.files, request.intent, {
        ...configWithScopes,
        scopes: refreshedScopes,
      }).pipe(Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned))),
      "Commit.ReplanGroups",
      { attributes: { reason: "unscoped-groups" } },
    );
  }

  const results: Array<SingleCommitResult> = [];
  let replanCount = 0;
  let inheritedFeedback = "";
  let remaining = [...groups];

  while (remaining.length > 0) {
    const group = remaining.shift();
    if (group == null) {
      break;
    }

    yield* request.vcs.unstageAll(request.cwd);
    yield* request.vcs.stageFiles(request.cwd, group.files);
    const groupDiff = yield* request.vcs.stagedDiff(request.cwd);
    if (groupDiff.files.length === 0) {
      continue;
    }

    const step = commitStepLabel(results.length, results.length + remaining.length + 1);

    const promptDiff =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(groupDiff), request.maxDiffLines)
        : filterDiffForPrompt(groupDiff);

    const messageResult = yield* generateCommitMessageWithHooks(request, configWithScopes, {
      promptDiff,
      groupDiff,
      initialHookFeedback: inheritedFeedback,
      groupIndex: results.length + 1,
      groupTotal: results.length + remaining.length + 1,
    });

    if (messageResult._tag === "Rejected") {
      if (replanCount >= maxReplans) {
        return yield* new HookBlockedError({
          message: "commit blocked after retries",
          reason: messageResult.reason,
          lastMessage: messageResult.lastMessage,
        });
      }
      replanCount += 1;
      inheritedFeedback = messageResult.reason;
      const regroupedFiles = [
        ...new Set([...(group.files ?? []), ...remaining.flatMap((item) => item.files)]),
      ];
      remaining = [
        ...(yield* Effect.withSpan(
          planGroups(request.provider, regroupedFiles, [], request.intent, configWithScopes).pipe(
            Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)),
          ),
          "Commit.ReplanGroups",
          { attributes: { reason: "hook-failures", file_count: regroupedFiles.length } },
        )),
      ];
      continue;
    }

    const result: SingleCommitResult = {
      title: messageResult.message.title,
      bullets: messageResult.message.bullets,
      explanation: messageResult.message.explanation,
      files: [...group.files],
      output: undefined,
    };

    if (!request.dryRun) {
      const output = yield* Effect.withSpan(
        request.vcs.commit(request.cwd, messageResult.finalMessage),
        "Commit.Create",
        {
          attributes: {
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            file_count: group.files.length,
            step,
          },
        },
      );
      results.push({
        ...result,
        output,
      });
    } else {
      results.push(result);
    }
  }

  return results satisfies CommitResponse;
});

const commitJj = Effect.fn("Commit.Run")(function* (request: CommitRequest, config: ProjectConfig) {
  if (request.noStage) {
    return yield* new UnsupportedFeatureError({ message: "--no-stage is not supported for jj" });
  }

  const promptDiff = yield* Effect.gen(function* () {
    const fullDiff = yield* request.vcs.unstagedDiff(request.cwd);
    if (fullDiff.files.length === 0) {
      return yield* new UnsupportedFeatureError({ message: "no changes" });
    }
    return request.maxDiffLines > 0
      ? truncateDiff(filterDiffForPrompt(fullDiff), request.maxDiffLines)
      : filterDiffForPrompt(fullDiff);
  }).pipe(Effect.withSpan("Commit.ScanChanges"));

  const configWithScopes =
    config.scopes.length > 0
      ? config
      : yield* withAutoScopes(request.provider, request.vcs, request.cwd, config);

  let groups = yield* planGroups(
    request.provider,
    [],
    promptDiff.files,
    request.intent,
    configWithScopes,
  ).pipe(Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)));

  const results: Array<SingleCommitResult> = [];
  let replanCount = 0;
  let inheritedFeedback = "";
  let remaining = [...groups];

  while (remaining.length > 0) {
    const group = remaining.shift();
    if (group == null) {
      break;
    }

    const groupDiff = yield* request.vcs.diffForFiles(request.cwd, group.files);
    if (groupDiff.files.length === 0) {
      return yield* new CommitPlanError({
        message: `jj commit group no longer matches working copy changes: ${formatFileList(group.files)}`,
      });
    }

    const step = commitStepLabel(results.length, results.length + remaining.length + 1);
    const truncated =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(groupDiff), request.maxDiffLines)
        : filterDiffForPrompt(groupDiff);

    const messageResult = yield* generateCommitMessageWithHooks(request, configWithScopes, {
      promptDiff: truncated,
      groupDiff,
      initialHookFeedback: inheritedFeedback,
      groupIndex: results.length + 1,
      groupTotal: results.length + remaining.length + 1,
    });

    if (messageResult._tag === "Rejected") {
      if (replanCount >= maxReplans) {
        return yield* new HookBlockedError({
          message: "commit blocked after retries",
          reason: messageResult.reason,
          lastMessage: messageResult.lastMessage,
        });
      }
      replanCount += 1;
      inheritedFeedback = messageResult.reason;
      const regroupedFiles = [
        ...new Set([...(group.files ?? []), ...remaining.flatMap((item) => item.files)]),
      ];
      remaining = [
        // TODO: Rename span name
        ...(yield* Effect.withSpan(
          planGroups(request.provider, [], regroupedFiles, request.intent, configWithScopes).pipe(
            Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)),
          ),
          "Commit.ReplanGroups",
          { attributes: { reason: "hook-failures", file_count: regroupedFiles.length } },
        )),
      ];
      continue;
    }

    const result: SingleCommitResult = {
      title: messageResult.message.title,
      bullets: messageResult.message.bullets,
      explanation: messageResult.message.explanation,
      files: [...group.files],
      output: undefined,
    };

    if (!request.dryRun) {
      const output = yield* Effect.withSpan(
        request.vcs.commit(request.cwd, messageResult.finalMessage, group.files),
        "Commit.create",
        {
          attributes: {
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            file_count: group.files.length,
            step,
          },
        },
      );
      yield* ensureJjWorkingCopyMatchesPlan(request, remaining);
      results.push({
        ...result,
        output,
      });
    } else {
      results.push(result);
    }
  }

  return results satisfies CommitResponse;
});

export const runCommitService = Effect.fn(function* (request: CommitRequest) {
  yield* Effect.annotateCurrentSpan({
    amend: request.amend,
    dry_run: request.dryRun,
    no_stage: request.noStage,
    vcs: request.vcs.kind,
  });

  const config = request.projectConfig;

  if (request.amend) {
    const diff = yield* Effect.withSpan(
      request.vcs.lastCommitDiff(request.cwd),
      "Commit.LoadPrevious",
    );

    yield* Effect.annotateCurrentSpan({
      attributes: { file_count: diff.files.length },
    });

    if (diff.files.length === 0) {
      return yield* new UnsupportedFeatureError({ message: "no previous commit to amend" });
    }

    const truncated =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(diff), request.maxDiffLines)
        : filterDiffForPrompt(diff);

    const message = yield* generateCommitMessage({
      provider: request.provider,
      diff: truncated,
      intent: request.intent,
      config,
      hookFeedback: undefined,
      previousMessage: undefined,
    });

    const assembled = yield* request.vcs.formatTrailers(
      request.cwd,
      assembleMessage(message),
      request.trailers,
    );

    const result: SingleCommitResult = {
      title: message.title,
      bullets: message.bullets,
      explanation: message.explanation,
      files: diff.files,
      output: undefined,
    };

    if (!request.dryRun) {
      const output = yield* Effect.withSpan(
        request.vcs.amendCommit(request.cwd, assembled),
        "Commit.Amend",
      );

      return [{ ...result, output }] satisfies CommitResponse;
    }

    return [result] satisfies CommitResponse;
  }

  return yield* request.vcs.kind === "git" ? commitGit(request, config) : commitJj(request, config);
});
