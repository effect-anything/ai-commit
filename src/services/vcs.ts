import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { Trailer } from "../domain/commit";
import { ProcessExecutionError, UnsupportedFeatureError } from "../shared/errors";
import { runProcess } from "../shared/process";
import { appendTrailers, countLines } from "../shared/text";

export type VcsKind = "git" | "jj";

export interface VcsDiff {
  readonly files: ReadonlyArray<string>;
  readonly content: string;
  readonly lines: number;
}

type VcsEnv = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

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

const shouldSkipDir = (name: string): boolean =>
  new Set([
    ".git",
    ".jj",
    ".direnv",
    ".repo",
    ".specs",
    ".lalph",
    ".codemogger",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".next",
    "out",
    "coverage",
  ]).has(name);

const walkFiles = (
  root: string,
  cwd = root,
): Effect.Effect<Array<string>, ProcessExecutionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProcessExecutionError({
            command: "walkFiles",
            exitCode: 1,
            stdout: "",
            stderr: cause.message,
          }),
      ),
    );
    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        if (entry.startsWith(".") && ![".gitignore", ".env.example", ".envrc"].includes(entry)) {
          const hiddenPath = path.join(cwd, entry);
          const hiddenInfo = yield* fs.stat(hiddenPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProcessExecutionError({
                  command: "walkFiles",
                  exitCode: 1,
                  stdout: "",
                  stderr: cause.message,
                }),
            ),
          );
          if (hiddenInfo.type === "Directory") {
            return [] as Array<string>;
          }
        }

        const fullPath = path.join(cwd, entry);
        const info = yield* fs.stat(fullPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessExecutionError({
                command: "walkFiles",
                exitCode: 1,
                stdout: "",
                stderr: cause.message,
              }),
          ),
        );

        if (info.type === "Directory") {
          if (shouldSkipDir(entry)) {
            return [] as Array<string>;
          }
          return yield* walkFiles(root, fullPath);
        }

        return [path.relative(root, fullPath)];
      }),
    );

    return nested.flat().sort();
  });

const listTopLevelDirs = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(root).pipe(
      Effect.mapError(
        (cause) =>
          new ProcessExecutionError({
            command: "readDirectory",
            exitCode: 1,
            stdout: "",
            stderr: cause.message,
          }),
      ),
    );

    const dirs = yield* Effect.filter(entries, (entry) => {
      if (entry.startsWith(".") || shouldSkipDir(entry)) {
        return Effect.succeed(false);
      }
      return fs.stat(path.join(root, entry)).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.catch(() => Effect.succeed(false)),
      );
    });

    return dirs.sort();
  });

const readGitLog = (cwd: string, max: number) =>
  Effect.map(
    runProcess({
      command: "git",
      args: ["log", "--format=COMMIT_START%s", "--name-only", "--max-count", String(max)],
      cwd,
      allowFailure: true,
    }),
    (result) => {
      if (result.exitCode !== 0) {
        return [];
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
    },
  );

export interface VcsClient {
  readonly kind: VcsKind;
  readonly supportsStaging: boolean;
  readonly isRepo: (cwd: string) => Effect.Effect<boolean, ProcessExecutionError, VcsEnv>;
  readonly initRepo: (cwd: string) => Effect.Effect<string, ProcessExecutionError, VcsEnv>;
  readonly repoRoot: (cwd: string) => Effect.Effect<string, ProcessExecutionError, VcsEnv>;
  readonly stagedDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError, VcsEnv>;
  readonly unstagedDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError, VcsEnv>;
  readonly diffForFiles: (
    cwd: string,
    files: ReadonlyArray<string>,
    revision?: string,
  ) => Effect.Effect<VcsDiff, ProcessExecutionError, VcsEnv>;
  readonly addAll: (cwd: string) => Effect.Effect<void, ProcessExecutionError, VcsEnv>;
  readonly stageFiles: (
    cwd: string,
    files: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProcessExecutionError | UnsupportedFeatureError, VcsEnv>;
  readonly unstageAll: (
    cwd: string,
  ) => Effect.Effect<void, ProcessExecutionError | UnsupportedFeatureError, VcsEnv>;
  readonly commit: (
    cwd: string,
    message: string,
    files?: ReadonlyArray<string>,
  ) => Effect.Effect<string, ProcessExecutionError, VcsEnv>;
  readonly amendCommit: (
    cwd: string,
    message: string,
  ) => Effect.Effect<string, ProcessExecutionError, VcsEnv>;
  readonly lastCommitDiff: (cwd: string) => Effect.Effect<VcsDiff, ProcessExecutionError, VcsEnv>;
  readonly formatTrailers: (
    cwd: string,
    message: string,
    trailers: ReadonlyArray<Trailer>,
  ) => Effect.Effect<string, ProcessExecutionError, VcsEnv>;
  readonly commitLog: (
    cwd: string,
    max: number,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError, VcsEnv>;
  readonly topLevelDirs: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError, VcsEnv>;
  readonly projectFiles: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, ProcessExecutionError, VcsEnv>;
}

const gitClient: VcsClient = {
  kind: "git",
  supportsStaging: true,
  isRepo: (cwd) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["rev-parse", "--git-dir"],
        cwd,
        allowFailure: true,
      }),
      (result) => result.exitCode === 0,
    ),
  initRepo: (cwd) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["init"],
        cwd,
      }),
      (result) => result.stdout.trim(),
    ),
  repoRoot: (cwd) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
      }),
      (result) => result.stdout.trim(),
    ),
  stagedDiff: (cwd) =>
    Effect.all({
      content: runProcess({
        command: "git",
        args: ["diff", "--staged", "--ignore-submodules=all"],
        cwd,
      }),
      names: runProcess({
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
      content: runProcess({
        command: "git",
        args: ["diff", "--ignore-submodules=all"],
        cwd,
      }),
      names: runProcess({
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
      content: runProcess({
        command: "git",
        args: [...baseArgs, ...files],
        cwd,
      }),
      names: runProcess({
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
    runProcess({
      command: "git",
      args: ["add", "-A"],
      cwd,
    }).pipe(Effect.asVoid),
  stageFiles: (cwd, files) =>
    runProcess({
      command: "git",
      args: ["add", "-f", "--", ...files],
      cwd,
    }).pipe(Effect.asVoid),
  unstageAll: (cwd) =>
    runProcess({
      command: "git",
      args: ["reset", "HEAD"],
      cwd,
      allowFailure: true,
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : runProcess({
              command: "git",
              args: ["rm", "--cached", "-r", "."],
              cwd,
              allowFailure: true,
            }).pipe(Effect.asVoid),
      ),
    ),
  commit: (cwd, message) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["commit", "-m", message],
        cwd,
        env: { GIT_AGENT: "1" },
      }),
      (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
    ),
  amendCommit: (cwd, message) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["commit", "--amend", "-m", message],
        cwd,
        env: { GIT_AGENT: "1" },
      }),
      (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
    ),
  lastCommitDiff: (cwd) =>
    Effect.all({
      content: runProcess({
        command: "git",
        args: ["diff", "HEAD~1..HEAD", "--ignore-submodules=all"],
        cwd,
      }),
      names: runProcess({
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
      runProcess({
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
  topLevelDirs: (cwd) => Effect.flatMap(gitClient.repoRoot(cwd), (root) => listTopLevelDirs(root)),
  projectFiles: (cwd) =>
    Effect.map(
      runProcess({
        command: "git",
        args: ["ls-files"],
        cwd,
      }),
      (result) => normalizeLines(result.stdout).slice(0, 300),
    ),
};

const jjClient: VcsClient = {
  kind: "jj",
  supportsStaging: false,
  isRepo: (cwd) =>
    Effect.map(
      runProcess({
        command: "jj",
        args: ["root"],
        cwd,
        allowFailure: true,
      }),
      (result) => result.exitCode === 0,
    ),
  initRepo: (cwd) =>
    Effect.map(
      runProcess({
        command: "jj",
        args: ["git", "init", "."],
        cwd,
      }),
      (result) => result.stdout.trim(),
    ),
  repoRoot: (cwd) =>
    Effect.map(
      runProcess({
        command: "jj",
        args: ["root"],
        cwd,
      }),
      (result) => result.stdout.trim(),
    ),
  stagedDiff: () => Effect.succeed(emptyDiff()),
  unstagedDiff: (cwd) =>
    Effect.all({
      content: runProcess({
        command: "jj",
        args: ["diff", "--git"],
        cwd,
      }),
      names: runProcess({
        command: "jj",
        args: ["diff", "--name-only"],
        cwd,
      }),
    }).pipe(
      Effect.map(({ content, names }) => diffFrom(normalizeLines(names.stdout), content.stdout)),
    ),
  diffForFiles: (cwd, files, revision) => {
    const revisionArgs = revision == null ? [] : ["-r", revision];
    return Effect.all({
      content: runProcess({
        command: "jj",
        args: ["diff", ...revisionArgs, "--git", ...files],
        cwd,
      }),
      names: runProcess({
        command: "jj",
        args: ["diff", ...revisionArgs, "--name-only", ...files],
        cwd,
      }),
    }).pipe(
      Effect.map(({ content, names }) => diffFrom(normalizeLines(names.stdout), content.stdout)),
    );
  },
  addAll: () => Effect.void,
  stageFiles: () =>
    Effect.fail(new UnsupportedFeatureError({ message: "jj does not support staging" })),
  unstageAll: () =>
    Effect.fail(new UnsupportedFeatureError({ message: "jj does not support staging" })),
  commit: (cwd, message, files = []) =>
    Effect.map(
      runProcess({
        command: "jj",
        args: ["commit", "-m", message, ...files],
        cwd,
      }),
      (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
    ),
  amendCommit: (cwd, message) =>
    Effect.map(
      runProcess({
        command: "jj",
        args: ["describe", "@-", "-m", message],
        cwd,
      }),
      (result) => renderProcessOutput(result.stdout, result.stderr) ?? "",
    ),
  lastCommitDiff: (cwd) =>
    Effect.all({
      content: runProcess({
        command: "jj",
        args: ["diff", "-r", "@-", "--git"],
        cwd,
      }),
      names: runProcess({
        command: "jj",
        args: ["diff", "-r", "@-", "--name-only"],
        cwd,
      }),
    }).pipe(
      Effect.map(({ content, names }) => diffFrom(normalizeLines(names.stdout), content.stdout)),
    ),
  formatTrailers: (_cwd, message, trailers) => Effect.succeed(appendTrailers(message, trailers)),
  commitLog: (cwd, max) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hasGitDir = yield* fs
        .exists(path.join(cwd, ".git"))
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (hasGitDir) {
        return yield* readGitLog(cwd, max);
      }
      return yield* Effect.map(
        runProcess({
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
  topLevelDirs: (cwd) => Effect.flatMap(jjClient.repoRoot(cwd), (root) => listTopLevelDirs(root)),
  projectFiles: (cwd) =>
    Effect.gen(function* () {
      const root = yield* jjClient.repoRoot(cwd);
      const files = yield* walkFiles(root);
      return files.slice(0, 300);
    }),
};

export const detectVcs = (cwd: string, preferred?: string) =>
  Effect.gen(function* () {
    if (preferred === "git" || preferred === "jj") {
      return preferred;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(path.join(cwd, ".jj"))) {
      return "jj" as const;
    }
    const jjRepo = yield* jjClient.isRepo(cwd);
    if (jjRepo) {
      return "jj" as const;
    }
    return "git" as const;
  });

export const getVcsClient = (kind: VcsKind): VcsClient => (kind === "jj" ? jjClient : gitClient);
