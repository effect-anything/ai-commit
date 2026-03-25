import { Effect } from "effect";
import type { CommitGroup, CommitMessage, SingleCommitResult, Trailer } from "../domain/commit";
import { renderCommitBody } from "../domain/commit";
import type { ProjectConfig } from "../domain/project";
import { emptyProjectConfig } from "../domain/project";
import { CommitPlanError, HookBlockedError, UnsupportedFeatureError } from "../shared/errors";
import { countLines } from "../shared/text";
import { executeHooks } from "./hooks";
import { generateCommitMessage, planCommits, type ProviderConfig } from "./openai-client";
import { generateProjectScopes } from "./scope-service";
import type { VcsClient, VcsDiff } from "./vcs";
import { projectConfigPath, mergeAndSaveScopes } from "../config/project";

const maxHookRetries = 3;
const maxReplans = 2;
const maxCommitGroups = 5;

export interface CommitRequest {
  readonly cwd: string;
  readonly provider: ProviderConfig;
  readonly vcs: VcsClient;
  readonly projectConfig: ProjectConfig | undefined;
  readonly intent: string | undefined;
  readonly trailers: ReadonlyArray<Trailer>;
  readonly dryRun: boolean;
  readonly noStage: boolean;
  readonly amend: boolean;
  readonly maxDiffLines: number;
}

export interface CommitResponse {
  readonly commits: ReadonlyArray<SingleCommitResult>;
  readonly dryRun: boolean;
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

const appendPassthroughFiles = (
  groups: Array<CommitGroup>,
  allowed: ReadonlySet<string>,
): Array<CommitGroup> => {
  if (groups.length === 0) {
    return groups;
  }
  const inPlan = new Set(groups.flatMap((group) => group.files));
  const passthrough = [...allowed].filter((file) => !inPlan.has(file)).sort();
  if (passthrough.length === 0) {
    return groups;
  }
  const [first, ...rest] = groups;
  if (first == null) {
    return groups;
  }
  return [
    {
      ...first,
      files: [...first.files, ...passthrough],
    },
    ...rest,
  ];
};

const hasUnscopedGroups = (groups: ReadonlyArray<CommitGroup>): boolean =>
  groups.some((group) => (group.message?.title ?? "").includes("(") === false);

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
  return Effect.failSync(
    () =>
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
  projectConfig?: ProjectConfig,
) {
  yield* Effect.annotateCurrentSpan({
    vcs: vcs.kind,
  });
  if (projectConfig != null && projectConfig.scopes.length > 0) {
    return projectConfig;
  }
  const scopes = yield* generateProjectScopes(provider, vcs, cwd, 200);
  const nextConfig = {
    ...(projectConfig ?? emptyProjectConfig()),
    scopes,
  } satisfies ProjectConfig;
  const repoRoot = yield* vcs.repoRoot(cwd);
  yield* mergeAndSaveScopes(yield* projectConfigPath(repoRoot), scopes);
  return nextConfig;
});

const planGroups = Effect.fn(function* (
  provider: ProviderConfig,
  stagedFiles: ReadonlyArray<string>,
  unstagedFiles: ReadonlyArray<string>,
  intent: string | undefined,
  config: ProjectConfig,
) {
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
  return appendPassthroughFiles(filtered, allowed).slice(0, maxCommitGroups);
});

const commitGit = Effect.fn(function* (request: CommitRequest, config: ProjectConfig) {
  const { promptStaged, promptUnstaged } = yield* Effect.withSpan(
    Effect.gen(function* () {
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
    }),
    "commit.scan-changes",
    {
      attributes: {
        vcs: "git",
        no_stage: request.noStage,
        dry_run: request.dryRun,
      },
      captureStackTrace: false,
    },
  );

  const configWithScopes =
    config.scopes.length > 0
      ? config
      : yield* withAutoScopes(request.provider, request.vcs, request.cwd, config);
  let groups = yield* Effect.withSpan(
    planGroups(
      request.provider,
      promptStaged.files,
      promptUnstaged.files,
      request.intent,
      configWithScopes,
    ).pipe(Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned))),
    "commit.plan-groups",
    {
      attributes: {
        vcs: "git",
        staged_files: promptStaged.files.length,
        unstaged_files: promptUnstaged.files.length,
      },
      captureStackTrace: false,
    },
  );

  if (configWithScopes.scopes.length > 0 && hasUnscopedGroups(groups)) {
    const refreshedScopes = yield* Effect.withSpan(
      generateProjectScopes(request.provider, request.vcs, request.cwd, 200),
      "commit.refresh-scopes",
      {
        attributes: {
          vcs: "git",
        },
        captureStackTrace: false,
      },
    );
    const repoRoot = yield* request.vcs.repoRoot(request.cwd);
    yield* mergeAndSaveScopes(yield* projectConfigPath(repoRoot), refreshedScopes);
    groups = yield* Effect.withSpan(
      planGroups(request.provider, promptStaged.files, promptUnstaged.files, request.intent, {
        ...configWithScopes,
        scopes: refreshedScopes,
      }).pipe(Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned))),
      "commit.replan-groups",
      {
        attributes: {
          vcs: "git",
          reason: "unscoped-groups",
        },
        captureStackTrace: false,
      },
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
    let hookFeedback = inheritedFeedback;
    let previousMessage: string | undefined;
    let lastMessage = "";
    let accepted: CommitMessage | undefined;

    for (let attempt = 0; attempt < maxHookRetries; attempt += 1) {
      const message = yield* Effect.withSpan(
        generateCommitMessage({
          provider: request.provider,
          diff: promptDiff,
          intent: request.intent,
          config: configWithScopes,
          hookFeedback: hookFeedback.length > 0 ? hookFeedback : undefined,
          previousMessage,
        }),
        "commit.generate-message",
        {
          attributes: {
            vcs: "git",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            attempt: attempt + 1,
            file_count: group.files.length,
          },
          captureStackTrace: false,
        },
      );
      const assembled = yield* request.vcs.formatTrailers(
        request.cwd,
        assembleMessage(message),
        request.trailers,
      );
      lastMessage = assembled;

      if (configWithScopes.hooks.length === 0) {
        accepted = message;
        break;
      }

      const hookResult = yield* Effect.withSpan(
        executeHooks(configWithScopes.hooks, {
          diff: groupDiff.content,
          commitMessage: assembled,
          intent: request.intent,
          stagedFiles: groupDiff.files,
          config: configWithScopes,
        }),
        "commit.run-hooks",
        {
          attributes: {
            vcs: "git",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            hook_count: configWithScopes.hooks.length,
          },
          captureStackTrace: false,
        },
      );

      if (hookResult.exitCode === 0) {
        accepted = message;
        break;
      }

      hookFeedback = hookResult.stderr;
      previousMessage = assembled;
    }

    if (accepted == null) {
      if (replanCount >= maxReplans) {
        return yield* new HookBlockedError({
          message: "error: commit blocked after retries",
          reason: hookFeedback,
          lastMessage,
        });
      }
      replanCount += 1;
      inheritedFeedback = hookFeedback;
      const regroupedFiles = [
        ...new Set([...(group.files ?? []), ...remaining.flatMap((item) => item.files)]),
      ];
      remaining = [
        ...(yield* Effect.withSpan(
          planGroups(request.provider, regroupedFiles, [], request.intent, configWithScopes).pipe(
            Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)),
          ),
          "commit.replan-groups",
          {
            attributes: {
              vcs: "git",
              reason: "hook-failures",
              file_count: regroupedFiles.length,
            },
            captureStackTrace: false,
          },
        )),
      ];
      continue;
    }

    const finalMessage = yield* request.vcs.formatTrailers(
      request.cwd,
      assembleMessage(accepted),
      request.trailers,
    );
    const result: SingleCommitResult = {
      title: accepted.title,
      bullets: accepted.bullets,
      explanation: accepted.explanation,
      files: [...group.files],
      output: undefined,
    };

    if (!request.dryRun) {
      const output = yield* Effect.withSpan(
        request.vcs.commit(request.cwd, finalMessage),
        "commit.create",
        {
          attributes: {
            vcs: "git",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            file_count: group.files.length,
            step,
          },
          captureStackTrace: false,
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

  return {
    commits: results,
    dryRun: request.dryRun,
  } satisfies CommitResponse;
});

const commitJj = Effect.fn(function* (request: CommitRequest, config: ProjectConfig) {
  if (request.noStage) {
    return yield* new UnsupportedFeatureError({ message: "--no-stage is not supported for jj" });
  }

  const promptDiff = yield* Effect.withSpan(
    Effect.gen(function* () {
      const fullDiff = yield* request.vcs.unstagedDiff(request.cwd);
      if (fullDiff.files.length === 0) {
        return yield* new UnsupportedFeatureError({ message: "no changes" });
      }
      return request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(fullDiff), request.maxDiffLines)
        : filterDiffForPrompt(fullDiff);
    }),
    "commit.scan-changes",
    {
      attributes: {
        vcs: "jj",
        dry_run: request.dryRun,
      },
      captureStackTrace: false,
    },
  );
  const configWithScopes =
    config.scopes.length > 0
      ? config
      : yield* withAutoScopes(request.provider, request.vcs, request.cwd, config);
  let groups = yield* Effect.withSpan(
    planGroups(request.provider, [], promptDiff.files, request.intent, configWithScopes).pipe(
      Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)),
    ),
    "commit.plan-groups",
    {
      attributes: {
        vcs: "jj",
        unstaged_files: promptDiff.files.length,
      },
      captureStackTrace: false,
    },
  );

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
    let hookFeedback = inheritedFeedback;
    let previousMessage: string | undefined;
    let lastMessage = "";
    let accepted: CommitMessage | undefined;

    for (let attempt = 0; attempt < maxHookRetries; attempt += 1) {
      const message = yield* Effect.withSpan(
        generateCommitMessage({
          provider: request.provider,
          diff: truncated,
          intent: request.intent,
          config: configWithScopes,
          hookFeedback: hookFeedback.length > 0 ? hookFeedback : undefined,
          previousMessage,
        }),
        "commit.generate-message",
        {
          attributes: {
            vcs: "jj",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            attempt: attempt + 1,
            file_count: group.files.length,
          },
          captureStackTrace: false,
        },
      );
      const assembled = yield* request.vcs.formatTrailers(
        request.cwd,
        assembleMessage(message),
        request.trailers,
      );
      lastMessage = assembled;

      if (configWithScopes.hooks.length === 0) {
        accepted = message;
        break;
      }

      const hookResult = yield* Effect.withSpan(
        executeHooks(configWithScopes.hooks, {
          diff: groupDiff.content,
          commitMessage: assembled,
          intent: request.intent,
          stagedFiles: groupDiff.files,
          config: configWithScopes,
        }),
        "commit.run-hooks",
        {
          attributes: {
            vcs: "jj",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            hook_count: configWithScopes.hooks.length,
          },
          captureStackTrace: false,
        },
      );

      if (hookResult.exitCode === 0) {
        accepted = message;
        break;
      }

      hookFeedback = hookResult.stderr;
      previousMessage = assembled;
    }

    if (accepted == null) {
      if (replanCount >= maxReplans) {
        return yield* new HookBlockedError({
          message: "error: commit blocked after retries",
          reason: hookFeedback,
          lastMessage,
        });
      }
      replanCount += 1;
      inheritedFeedback = hookFeedback;
      const regroupedFiles = [
        ...new Set([...(group.files ?? []), ...remaining.flatMap((item) => item.files)]),
      ];
      remaining = [
        ...(yield* Effect.withSpan(
          planGroups(request.provider, [], regroupedFiles, request.intent, configWithScopes).pipe(
            Effect.flatMap((planned) => validateCommitPlan(request.vcs, planned)),
          ),
          "commit.replan-groups",
          {
            attributes: {
              vcs: "jj",
              reason: "hook-failures",
              file_count: regroupedFiles.length,
            },
            captureStackTrace: false,
          },
        )),
      ];
      continue;
    }

    const finalMessage = yield* request.vcs.formatTrailers(
      request.cwd,
      assembleMessage(accepted),
      request.trailers,
    );
    const result: SingleCommitResult = {
      title: accepted.title,
      bullets: accepted.bullets,
      explanation: accepted.explanation,
      files: [...group.files],
      output: undefined,
    };

    if (!request.dryRun) {
      const output = yield* Effect.withSpan(
        request.vcs.commit(request.cwd, finalMessage, group.files),
        "commit.create",
        {
          attributes: {
            vcs: "jj",
            group_index: results.length + 1,
            group_total: results.length + remaining.length + 1,
            file_count: group.files.length,
            step,
          },
          captureStackTrace: false,
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

  return {
    commits: results,
    dryRun: request.dryRun,
  } satisfies CommitResponse;
});

export const runCommitService = Effect.fn(function* (request: CommitRequest) {
  yield* Effect.annotateCurrentSpan({
    amend: request.amend,
    dry_run: request.dryRun,
    no_stage: request.noStage,
    vcs: request.vcs.kind,
  });
  const config = request.projectConfig ?? emptyProjectConfig();
  if (request.amend) {
    const diff = yield* Effect.withSpan(
      request.vcs.lastCommitDiff(request.cwd),
      "commit.load-previous",
      {
        attributes: {
          vcs: request.vcs.kind,
        },
        captureStackTrace: false,
      },
    );
    if (diff.files.length === 0) {
      return yield* new UnsupportedFeatureError({ message: "no previous commit to amend" });
    }
    const truncated =
      request.maxDiffLines > 0
        ? truncateDiff(filterDiffForPrompt(diff), request.maxDiffLines)
        : filterDiffForPrompt(diff);
    const message = yield* Effect.withSpan(
      generateCommitMessage({
        provider: request.provider,
        diff: truncated,
        intent: request.intent,
        config,
        hookFeedback: undefined,
        previousMessage: undefined,
      }),
      "commit.generate-amend-message",
      {
        attributes: {
          vcs: request.vcs.kind,
          file_count: diff.files.length,
        },
        captureStackTrace: false,
      },
    );
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
        "commit.amend",
        {
          attributes: {
            vcs: request.vcs.kind,
            file_count: diff.files.length,
          },
          captureStackTrace: false,
        },
      );
      return {
        commits: [
          {
            ...result,
            output,
          },
        ],
        dryRun: false,
      } satisfies CommitResponse;
    }
    return {
      commits: [result],
      dryRun: request.dryRun,
    } satisfies CommitResponse;
  }

  return yield* request.vcs.kind === "git" ? commitGit(request, config) : commitJj(request, config);
});
