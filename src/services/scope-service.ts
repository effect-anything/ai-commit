import { Effect } from "effect";
import type { ProjectScope } from "../domain/project";
import { generateScopes, type ProviderConfig } from "./openai-client";
import type { VcsClient } from "./vcs";

const conventionalTypes = new Set([
  "build",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "style",
  "test",
  "chore",
  "revert",
]);

export const generateProjectScopes = (
  provider: ProviderConfig,
  vcs: VcsClient,
  cwd: string,
  maxCommits: number,
) =>
  Effect.gen(function* () {
    const [commits, dirs, files] = yield* Effect.all([
      vcs.commitLog(cwd, maxCommits),
      vcs.topLevelDirs(cwd),
      vcs.projectFiles(cwd),
    ]);

    const scopes = yield* generateScopes(provider, commits, dirs, files);
    return scopes.filter((scope) => !conventionalTypes.has(scope.name.toLowerCase()));
  });

export const formatScopeNames = (scopes: ReadonlyArray<ProjectScope>): Array<string> =>
  scopes.map((scope) => scope.name);
