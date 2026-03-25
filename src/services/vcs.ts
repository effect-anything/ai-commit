import { Effect, Layer, ServiceMap } from "effect";
import { FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { Trailer } from "../domain/commit";
import { ProcessExecutionError, UnsupportedFeatureError } from "../shared/errors";
import { runProcess, type ProcessResult, type RunProcessOptions } from "../shared/process";
import { appendTrailers, countLines } from "../shared/text";

export type VcsKind = "git" | "jj";

export interface VcsDiff {
  readonly files: ReadonlyArray<string>;
  readonly content: string;
  readonly lines: number;
}

interface IgnoreRules {
  readonly directoryNames: ReadonlySet<string>;
  readonly relativePaths: ReadonlySet<string>;
}

interface ScanState {
  readonly root: string;
  readonly ignoreRules: IgnoreRules;
  readonly useGitCheckIgnore: boolean;
}

const internalDirectoryNames = new Set([".git", ".jj"]);

const emptyDiff = (): VcsDiff => ({
  files: [],
  content: "",
  lines: 0,
});

const normalizeLines = (value: string): Array<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const parseGitNameStatus = (input: string): Array<string> =>
  normalizeLines(input).map((line) => {
    const parts = line.split("\t");
    return parts[parts.length - 1] ?? line;
  });

const diffFrom = (files: ReadonlyArray<string>, content: string): VcsDiff => ({
  files: [...files],
  content,
  lines: countLines(content),
});

const renderProcessOutput = (stdout: string, stderr: string): string | undefined => {
  const combined = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join("\n");
  return combined.length > 0 ? combined : undefined;
};

const toPortablePath = (value: string): string =>
  value
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .join("/");

const processError = (command: string, cause: unknown) =>
  new ProcessExecutionError({
    command,
    exitCode: 1,
    stdout: "",
    stderr: cause instanceof Error ? cause.message : String(cause),
  });

const checkIgnoreError = (result: ProcessResult) =>
  new ProcessExecutionError({
    command: "git check-ignore --stdin",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });

const emptyIgnoreRules = (): IgnoreRules => ({
  directoryNames: new Set(),
  relativePaths: new Set(),
});

const toIgnoredDirectoryRule = (
  line: string,
): { readonly name?: string; readonly relativePath?: string } | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return undefined;
  }

  let normalized = trimmed.replace(/\/+$/, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  normalized = toPortablePath(normalized);
  if (normalized.length === 0 || normalized === ".") {
    return undefined;
  }

  if (/[*?[{\]]/.test(normalized)) {
    const basenameMatch = normalized.match(/^(?:\*\*\/)?([^*?[{\]/]+)$/);
    if (basenameMatch?.[1] == null) {
      return undefined;
    }
    return { name: basenameMatch[1] };
  }

  if (normalized.includes("/")) {
    return { relativePath: normalized };
  }

  return { name: normalized };
};

const shouldSkipDir = (name: string, relativePath: string, ignoreRules: IgnoreRules): boolean =>
  internalDirectoryNames.has(name) ||
  ignoreRules.directoryNames.has(name) ||
  ignoreRules.relativePaths.has(toPortablePath(relativePath));

const ignoredPathsByFallback = (
  relativePaths: ReadonlyArray<string>,
  ignoreRules: IgnoreRules,
): Set<string> => {
  const ignored = new Set<string>();
  for (const relativePath of relativePaths) {
    const normalized = toPortablePath(relativePath);
    const name = normalized.split("/").at(-1) ?? normalized;
    if (shouldSkipDir(name, normalized, ignoreRules)) {
      ignored.add(normalized);
    }
  }
  return ignored;
};

const makeRunProcess =
  (spawner: ChildProcessSpawner["Service"]) =>
  (options: RunProcessOptions): Effect.Effect<ProcessResult, ProcessExecutionError> =>
    runProcess(options).pipe(Effect.provideService(ChildProcessSpawner, spawner));

export interface VcsClient {
  readonly kind: VcsKind;
  readonly supportsStaging: boolean;
  readonly isRepo: (cwd: string) => Effect.Effect<boolean, ProcessExecutionError>;
  readonly initRepo: (cwd: string) => Effect.Effect<string, ProcessExecutionError>;
  readonly repoRoot: (cwd: string) => Effect.Effect<string, ProcessExecutionError>;
  readonly stagedDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError>;
  readonly unstagedDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError>;
  readonly diffForFiles: (
    cwd: string,
    files: ReadonlyArray<string>,
    revision?: string,
  ) => Effect.Effect<VcsDiff, ProcessExecutionError>;
  readonly addAll: (cwd: string) => Effect.Effect<void, ProcessExecutionError>;
  readonly stageFiles: (
    cwd: string,
    files: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProcessExecutionError | UnsupportedFeatureError>;
  readonly unstageAll: (
    cwd: string,
  ) => Effect.Effect<void, ProcessExecutionError | UnsupportedFeatureError>;
  readonly commit: (
    cwd: string,
    message: string,
    files?: ReadonlyArray<string>,
  ) => Effect.Effect<string, ProcessExecutionError>;
  readonly amendCommit: (
    cwd: string,
    message: string,
  ) => Effect.Effect<string, ProcessExecutionError>;
  readonly lastCommitDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError>;
  readonly formatTrailers: (
    cwd: string,
    message: string,
    trailers: ReadonlyArray<Trailer>,
  ) => Effect.Effect<string, ProcessExecutionError>;
  readonly commitLog: (
    cwd: string,
    max: number,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError>;
  readonly topLevelDirs: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError>;
  readonly projectFiles: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError>;
}

export interface ResolvedVcs {
  readonly kind: VcsKind;
  readonly client: VcsClient;
}

export interface VcsService {
  readonly detect: (
    cwd: string,
    preferred?: string,
  ) => Effect.Effect<VcsKind, ProcessExecutionError>;
  readonly get: (kind: VcsKind) => VcsClient;
  readonly resolve: (
    cwd: string,
    preferred?: string,
  ) => Effect.Effect<ResolvedVcs, ProcessExecutionError>;
}

export class GitClient extends ServiceMap.Service<GitClient, VcsClient>()("@git-agent/GitClient") {}

export const GitClientLive = Layer.effect(
  GitClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const run = makeRunProcess(spawner);

    const loadIgnoreRules = Effect.fn(function* (root: string) {
      const gitignorePath = path.join(root, ".gitignore");
      const exists = yield* fs
        .exists(gitignorePath)
        .pipe(Effect.mapError((cause) => processError("readIgnoreRules", cause)));
      if (!exists) {
        return emptyIgnoreRules();
      }

      const content = yield* fs
        .readFileString(gitignorePath, "utf8")
        .pipe(Effect.mapError((cause) => processError("readIgnoreRules", cause)));

      const directoryNames = new Set<string>();
      const relativePaths = new Set<string>();
      for (const line of content.split("\n")) {
        const rule = toIgnoredDirectoryRule(line);
        if (rule?.name != null) {
          directoryNames.add(rule.name);
        }
        if (rule?.relativePath != null) {
          relativePaths.add(rule.relativePath);
        }
      }
      return {
        directoryNames,
        relativePaths,
      } satisfies IgnoreRules;
    });

    const ignoredPaths = Effect.fn(function* (
      state: ScanState,
      relativePaths: ReadonlyArray<string>,
    ) {
      if (relativePaths.length === 0) {
        return new Set<string>();
      }
      const fallbackIgnored = ignoredPathsByFallback(relativePaths, state.ignoreRules);
      if (!state.useGitCheckIgnore) {
        return fallbackIgnored;
      }

      const input = relativePaths.map(toPortablePath).join("\n");
      const result = yield* run({
        command: "git",
        args: ["check-ignore", "--stdin"],
        cwd: state.root,
        stdin: input.length > 0 ? `${input}\n` : "",
        allowFailure: true,
      });

      if (result.exitCode === 0 || result.exitCode === 1) {
        return new Set([...fallbackIgnored, ...normalizeLines(result.stdout).map(toPortablePath)]);
      }

      return yield* Effect.failSync(() => checkIgnoreError(result));
    });

    const buildScanState = Effect.fn(function* (root: string) {
      const ignoreRules = yield* loadIgnoreRules(root);
      return {
        root,
        ignoreRules,
        useGitCheckIgnore: true,
      } satisfies ScanState;
    });

    const listTopLevelDirs: (root: string) => Effect.Effect<Array<string>, ProcessExecutionError> =
      Effect.fn(function* (root: string) {
        const state = yield* buildScanState(root);
        const entries = yield* fs
          .readDirectory(root)
          .pipe(Effect.mapError((cause) => processError("readDirectory", cause)));
        const maybeDirectoryEntries: Array<string | undefined> = yield* Effect.forEach(
          entries,
          (entry) =>
            fs.stat(path.join(root, entry)).pipe(
              Effect.map((info) => (info.type === "Directory" ? entry : undefined)),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
        );
        const directoryEntries = maybeDirectoryEntries.filter(
          (entry): entry is string => entry != null,
        );
        const ignored = yield* ignoredPaths(state, directoryEntries);
        return directoryEntries.filter((entry) => !ignored.has(toPortablePath(entry))).sort();
      });

    const readGitLog = Effect.fn(function* (cwd: string, max: number) {
      const result = yield* run({
        command: "git",
        args: ["log", "--format=COMMIT_START%s", "--name-only", "--max-count", String(max)],
        cwd,
        allowFailure: true,
      });
      if (result.exitCode !== 0) {
        return [] as Array<string>;
      }

      const entries: Array<string> = [];
      let current = "";
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("COMMIT_START")) {
          if (current.length > 0) {
            entries.push(current.trimEnd());
          }
          current = line.slice("COMMIT_START".length);
          continue;
        }
        if (line.trim().length > 0) {
          current += `\n  ${line.trim()}`;
        }
      }
      if (current.length > 0) {
        entries.push(current.trimEnd());
      }
      return entries;
    });

    const repoRoot = (cwd: string) =>
      Effect.map(
        run({
          command: "git",
          args: ["rev-parse", "--show-toplevel"],
          cwd,
        }),
        (result) => result.stdout.trim(),
      );

    return {
      kind: "git",
      supportsStaging: true,
      isRepo: (cwd) =>
        Effect.map(
          run({
            command: "git",
            args: ["rev-parse", "--git-dir"],
            cwd,
            allowFailure: true,
          }),
          (result) => result.exitCode === 0,
        ),
      initRepo: (cwd) =>
        Effect.map(
          run({
            command: "git",
            args: ["init"],
            cwd,
          }),
          (result) => result.stdout.trim(),
        ),
      repoRoot,
      stagedDiff: (cwd) =>
        Effect.all({
          content: run({
            command: "git",
            args: ["diff", "--staged", "--ignore-submodules=all"],
            cwd,
          }),
          names: run({
            command: "git",
            args: ["diff", "--staged", "--name-status", "--ignore-submodules=all"],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(parseGitNameStatus(names.stdout), content.stdout),
          ),
        ),
      unstagedDiff: (cwd) =>
        Effect.all({
          content: run({
            command: "git",
            args: ["diff", "--ignore-submodules=all"],
            cwd,
          }),
          names: run({
            command: "git",
            args: ["diff", "--name-status", "--ignore-submodules=all"],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(parseGitNameStatus(names.stdout), content.stdout),
          ),
        ),
      diffForFiles: (cwd, files, revision) => {
        const baseArgs =
          revision == null
            ? ["diff", "--staged", "--ignore-submodules=all", "--"]
            : ["diff", revision, "--ignore-submodules=all", "--"];
        const nameArgs =
          revision == null
            ? ["diff", "--staged", "--name-status", "--ignore-submodules=all", "--"]
            : ["diff", revision, "--name-status", "--ignore-submodules=all", "--"];
        return Effect.all({
          content: run({
            command: "git",
            args: [...baseArgs, ...files],
            cwd,
          }),
          names: run({
            command: "git",
            args: [...nameArgs, ...files],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(parseGitNameStatus(names.stdout), content.stdout),
          ),
        );
      },
      addAll: (cwd) =>
        run({
          command: "git",
          args: ["add", "-A"],
          cwd,
        }).pipe(Effect.asVoid),
      stageFiles: (cwd, files) =>
        run({
          command: "git",
          args: ["add", "-f", "--", ...files],
          cwd,
        }).pipe(Effect.asVoid),
      unstageAll: (cwd) =>
        run({
          command: "git",
          args: ["reset", "HEAD"],
          cwd,
          allowFailure: true,
        }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : run({
                  command: "git",
                  args: ["rm", "--cached", "-r", "."],
                  cwd,
                  allowFailure: true,
                }).pipe(Effect.asVoid),
          ),
        ),
      commit: (cwd, message) =>
        Effect.map(
          run({
            command: "git",
            args: ["commit", "-m", message],
            cwd,
            env: { GIT_AGENT: "1" },
          }),
          (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
        ),
      amendCommit: (cwd, message) =>
        Effect.map(
          run({
            command: "git",
            args: ["commit", "--amend", "-m", message],
            cwd,
            env: { GIT_AGENT: "1" },
          }),
          (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
        ),
      lastCommitDiff: (cwd) =>
        Effect.all({
          content: run({
            command: "git",
            args: ["diff", "HEAD~1..HEAD", "--ignore-submodules=all"],
            cwd,
          }),
          names: run({
            command: "git",
            args: ["diff", "HEAD~1..HEAD", "--name-status", "--ignore-submodules=all"],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(parseGitNameStatus(names.stdout), content.stdout),
          ),
        ),
      formatTrailers: (cwd, message, trailers) => {
        if (trailers.length === 0) {
          return Effect.succeed(message.trimEnd());
        }
        return Effect.map(
          run({
            command: "git",
            args: [
              "interpret-trailers",
              "--if-exists=addIfDifferent",
              ...trailers.flatMap((trailer) => ["--trailer", `${trailer.key}: ${trailer.value}`]),
            ],
            cwd,
            stdin: message,
          }),
          (result) => result.stdout.trimEnd(),
        );
      },
      commitLog: readGitLog,
      topLevelDirs: (cwd) => Effect.flatMap(repoRoot(cwd), listTopLevelDirs),
      projectFiles: (cwd) =>
        Effect.map(
          run({
            command: "git",
            args: ["ls-files"],
            cwd,
          }),
          (result) => normalizeLines(result.stdout).slice(0, 300),
        ),
    } satisfies VcsClient;
  }),
);

export class JjClient extends ServiceMap.Service<JjClient, VcsClient>()("@git-agent/JjClient") {}

export const JjClientLive = Layer.effect(
  JjClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const run = makeRunProcess(spawner);

    const loadIgnoreRules = Effect.fn(function* (root: string) {
      const gitignorePath = path.join(root, ".gitignore");
      const exists = yield* fs
        .exists(gitignorePath)
        .pipe(Effect.mapError((cause) => processError("readIgnoreRules", cause)));
      if (!exists) {
        return emptyIgnoreRules();
      }

      const content = yield* fs
        .readFileString(gitignorePath, "utf8")
        .pipe(Effect.mapError((cause) => processError("readIgnoreRules", cause)));

      const directoryNames = new Set<string>();
      const relativePaths = new Set<string>();
      for (const line of content.split("\n")) {
        const rule = toIgnoredDirectoryRule(line);
        if (rule?.name != null) {
          directoryNames.add(rule.name);
        }
        if (rule?.relativePath != null) {
          relativePaths.add(rule.relativePath);
        }
      }
      return {
        directoryNames,
        relativePaths,
      } satisfies IgnoreRules;
    });

    const ignoredPaths = Effect.fn(function* (
      state: ScanState,
      relativePaths: ReadonlyArray<string>,
    ) {
      if (relativePaths.length === 0) {
        return new Set<string>();
      }
      const fallbackIgnored = ignoredPathsByFallback(relativePaths, state.ignoreRules);
      if (!state.useGitCheckIgnore) {
        return fallbackIgnored;
      }

      const input = relativePaths.map(toPortablePath).join("\n");
      const result = yield* run({
        command: "git",
        args: ["check-ignore", "--stdin"],
        cwd: state.root,
        stdin: input.length > 0 ? `${input}\n` : "",
        allowFailure: true,
      });

      if (result.exitCode === 0 || result.exitCode === 1) {
        return new Set([...fallbackIgnored, ...normalizeLines(result.stdout).map(toPortablePath)]);
      }

      return yield* Effect.failSync(() => checkIgnoreError(result));
    });

    const buildScanState = Effect.fn(function* (root: string) {
      const ignoreRules = yield* loadIgnoreRules(root);
      const useGitCheckIgnore = yield* fs
        .exists(path.join(root, ".git"))
        .pipe(Effect.mapError((cause) => processError("readIgnoreRules", cause)));
      return {
        root,
        ignoreRules,
        useGitCheckIgnore,
      } satisfies ScanState;
    });

    const walkFiles: (
      state: ScanState,
      cwd?: string,
    ) => Effect.Effect<Array<string>, ProcessExecutionError> = Effect.fn(function* (
      state: ScanState,
      cwd = state.root,
    ) {
      const entries = yield* fs
        .readDirectory(cwd)
        .pipe(Effect.mapError((cause) => processError("walkFiles", cause)));
      const scanned = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const fullPath = path.join(cwd, entry);
          const info = yield* fs
            .stat(fullPath)
            .pipe(Effect.mapError((cause) => processError("walkFiles", cause)));
          return {
            entry,
            fullPath,
            relativePath: toPortablePath(path.relative(state.root, fullPath)),
            info,
          };
        }),
      );
      const ignored = yield* ignoredPaths(
        state,
        scanned.map((item) => item.relativePath),
      );
      const nested: Array<Array<string>> = yield* Effect.forEach(scanned, (item) =>
        Effect.gen(function* () {
          if (ignored.has(item.relativePath)) {
            return [] as Array<string>;
          }
          if (item.info.type === "Directory") {
            return yield* walkFiles(state, item.fullPath);
          }
          return [item.relativePath];
        }),
      );
      return nested.flat().sort();
    });

    const listTopLevelDirs: (root: string) => Effect.Effect<Array<string>, ProcessExecutionError> =
      Effect.fn(function* (root: string) {
        const state = yield* buildScanState(root);
        const entries = yield* fs
          .readDirectory(root)
          .pipe(Effect.mapError((cause) => processError("readDirectory", cause)));
        const maybeDirectoryEntries: Array<string | undefined> = yield* Effect.forEach(
          entries,
          (entry) =>
            fs.stat(path.join(root, entry)).pipe(
              Effect.map((info) => (info.type === "Directory" ? entry : undefined)),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
        );
        const directoryEntries = maybeDirectoryEntries.filter(
          (entry): entry is string => entry != null,
        );
        const ignored = yield* ignoredPaths(state, directoryEntries);
        return directoryEntries.filter((entry) => !ignored.has(toPortablePath(entry))).sort();
      });

    const readGitLog = Effect.fn(function* (cwd: string, max: number) {
      const result = yield* run({
        command: "git",
        args: ["log", "--format=COMMIT_START%s", "--name-only", "--max-count", String(max)],
        cwd,
        allowFailure: true,
      });
      if (result.exitCode !== 0) {
        return [] as Array<string>;
      }

      const entries: Array<string> = [];
      let current = "";
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("COMMIT_START")) {
          if (current.length > 0) {
            entries.push(current.trimEnd());
          }
          current = line.slice("COMMIT_START".length);
          continue;
        }
        if (line.trim().length > 0) {
          current += `\n  ${line.trim()}`;
        }
      }
      if (current.length > 0) {
        entries.push(current.trimEnd());
      }
      return entries;
    });

    const repoRoot = (cwd: string) =>
      Effect.map(
        run({
          command: "jj",
          args: ["root"],
          cwd,
        }),
        (result) => result.stdout.trim(),
      );

    return {
      kind: "jj",
      supportsStaging: false,
      isRepo: (cwd) =>
        Effect.map(
          run({
            command: "jj",
            args: ["root"],
            cwd,
            allowFailure: true,
          }),
          (result) => result.exitCode === 0,
        ),
      initRepo: (cwd) =>
        Effect.map(
          run({
            command: "jj",
            args: ["git", "init", "."],
            cwd,
          }),
          (result) => result.stdout.trim(),
        ),
      repoRoot,
      stagedDiff: () => Effect.succeed(emptyDiff()),
      unstagedDiff: (cwd) =>
        Effect.all({
          content: run({
            command: "jj",
            args: ["diff", "--git"],
            cwd,
          }),
          names: run({
            command: "jj",
            args: ["diff", "--name-only"],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(normalizeLines(names.stdout), content.stdout),
          ),
        ),
      diffForFiles: (cwd, files, revision) => {
        const revisionArgs = revision == null ? [] : ["-r", revision];
        return Effect.all({
          content: run({
            command: "jj",
            args: ["diff", ...revisionArgs, "--git", ...files],
            cwd,
          }),
          names: run({
            command: "jj",
            args: ["diff", ...revisionArgs, "--name-only", ...files],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(normalizeLines(names.stdout), content.stdout),
          ),
        );
      },
      addAll: () => Effect.void,
      stageFiles: () =>
        Effect.failSync(
          () => new UnsupportedFeatureError({ message: "jj does not support staging" }),
        ),
      unstageAll: () =>
        Effect.failSync(
          () => new UnsupportedFeatureError({ message: "jj does not support staging" }),
        ),
      commit: (cwd, message, files = []) =>
        Effect.map(
          run({
            command: "jj",
            args: ["commit", "-m", message, ...files],
            cwd,
          }),
          (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
        ),
      amendCommit: (cwd, message) =>
        Effect.map(
          run({
            command: "jj",
            args: ["describe", "@-", "-m", message],
            cwd,
          }),
          (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
        ),
      lastCommitDiff: (cwd) =>
        Effect.all({
          content: run({
            command: "jj",
            args: ["diff", "-r", "@-", "--git"],
            cwd,
          }),
          names: run({
            command: "jj",
            args: ["diff", "-r", "@-", "--name-only"],
            cwd,
          }),
        }).pipe(
          Effect.map(({ content, names }) =>
            diffFrom(normalizeLines(names.stdout), content.stdout),
          ),
        ),
      formatTrailers: (_cwd, message, trailers) =>
        Effect.succeed(appendTrailers(message, trailers)),
      commitLog: Effect.fn(function* (cwd: string, max: number) {
        const hasGitDir = yield* fs
          .exists(path.join(cwd, ".git"))
          .pipe(Effect.mapError((cause) => processError("jjCommitLog", cause)));
        if (hasGitDir) {
          return yield* readGitLog(cwd, max);
        }
        return yield* Effect.map(
          run({
            command: "jj",
            args: [
              "log",
              "--limit",
              String(max),
              "--no-graph",
              "-T",
              'description.first_line() ++ "\\n"',
            ],
            cwd,
          }),
          (result) => normalizeLines(result.stdout),
        );
      }),
      topLevelDirs: (cwd) => Effect.flatMap(repoRoot(cwd), listTopLevelDirs),
      projectFiles: Effect.fn(function* (cwd: string) {
        const root = yield* repoRoot(cwd);
        const state = yield* buildScanState(root);
        const files = yield* walkFiles(state);
        return files.slice(0, 300);
      }),
    } satisfies VcsClient;
  }),
);

export class Vcs extends ServiceMap.Service<Vcs, VcsService>()("@git-agent/Vcs") {}

export const VcsLive = Layer.effect(
  Vcs,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitClient;
    const jj = yield* JjClient;

    const detect = Effect.fn(function* (cwd: string, preferred?: string) {
      if (preferred === "git" || preferred === "jj") {
        return preferred;
      }
      const hasJjDir = yield* fs
        .exists(path.join(cwd, ".jj"))
        .pipe(Effect.mapError((cause) => processError("detectVcs", cause)));
      if (hasJjDir) {
        return "jj" as const;
      }
      const jjRepo = yield* jj.isRepo(cwd);
      if (jjRepo) {
        return "jj" as const;
      }
      return "git" as const;
    });

    return {
      detect,
      get: (kind) => (kind === "jj" ? jj : git),
      resolve: Effect.fn(function* (cwd: string, preferred?: string) {
        const kind = yield* detect(cwd, preferred);
        return {
          kind,
          client: kind === "jj" ? jj : git,
        } satisfies ResolvedVcs;
      }),
    } satisfies VcsService;
  }),
).pipe(Layer.provide(Layer.mergeAll(GitClientLive, JjClientLive)));
