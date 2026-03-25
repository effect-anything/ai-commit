import { Effect, FileSystem, Path } from "effect";
import type { ProjectConfig } from "../domain/project";
import { ConfigError } from "../shared/errors";
import { runProcess } from "../shared/process";
import {
  hasErrors,
  validateConventional,
  validationErrors,
  validationWarnings,
} from "./conventional";

export interface HookInput {
  readonly diff: string;
  readonly commitMessage: string;
  readonly intent: string | undefined;
  readonly stagedFiles: ReadonlyArray<string>;
  readonly config: ProjectConfig;
}

export interface HookResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface InstalledHookValue {
  readonly value: string;
  readonly installedFrom: string | undefined;
}

const executeShellHook = (path: string, input: HookInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(undefined)));

    if (info == null) {
      return {
        exitCode: 0,
        stderr: "",
      } satisfies HookResult;
    }

    if ((info.mode & 0o111) === 0) {
      return yield* Effect.fail(
        new ConfigError({
          message: `hook is not executable: ${path}`,
        }),
      );
    }

    return yield* Effect.map(
      runProcess({
        command: path,
        stdin: JSON.stringify(input),
        allowFailure: true,
      }),
      (result) =>
        ({
          exitCode: result.exitCode,
          stderr: result.stderr,
        }) satisfies HookResult,
    );
  });

const executeConventionalHook = (input: HookInput): HookResult => {
  const result = validateConventional(input.commitMessage);
  const messages = [
    ...validationErrors(result).map((message) => `error: ${message}`),
    ...validationWarnings(result).map((message) => `warning: ${message}`),
  ];

  return {
    exitCode: hasErrors(result) ? 1 : 0,
    stderr: messages.join("\n"),
  };
};

export const executeHooks = (hooks: ReadonlyArray<string>, input: HookInput) =>
  Effect.gen(function* () {
    let warnings = "";
    for (const hook of hooks) {
      if (hook === "" || hook === "empty") {
        continue;
      }

      const result =
        hook === "conventional"
          ? executeConventionalHook(input)
          : yield* executeShellHook(hook, input);

      if (result.exitCode !== 0) {
        return result;
      }

      if (result.stderr.trim().length > 0) {
        warnings = warnings.length === 0 ? result.stderr : `${warnings}\n${result.stderr}`;
      }
    }

    return {
      exitCode: 0,
      stderr: warnings,
    } satisfies HookResult;
  });

export const installHookValue = (repoRoot: string, key: string, value: string) =>
  Effect.gen(function* () {
    if (key !== "hook") {
      return {
        value,
        installedFrom: undefined,
      } satisfies InstalledHookValue;
    }
    if (value === "conventional" || value === "empty") {
      return {
        value,
        installedFrom: undefined,
      } satisfies InstalledHookValue;
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourcePath = path.resolve(value);
    const data = yield* fs.readFile(value).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            message: `reading hook file "${value}": ${cause.message}`,
          }),
      ),
    );
    const destination = path.join(repoRoot, ".git-agent", "hooks", "pre-commit");

    yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            message: `creating hooks dir: ${cause.message}`,
          }),
      ),
    );
    yield* fs.writeFile(destination, data, { mode: 0o755 }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            message: `installing hook: ${cause.message}`,
          }),
      ),
    );

    return {
      value: sourcePath,
      installedFrom: value,
    } satisfies InstalledHookValue;
  });
