import { Effect, FileSystem, Formatter, Path, Schema } from "effect";
import { ProjectConfig } from "../domain/project.ts";
import { ConfigError } from "../shared/errors.ts";
import { runProcess } from "../shared/process.ts";
import {
  hasErrors,
  validateConventional,
  validationErrors,
  validationWarnings,
} from "./conventional.ts";

export const HookInput = Schema.Struct({
  diff: Schema.String,
  commitMessage: Schema.String,
  intent: Schema.String.pipe(Schema.UndefinedOr),
  stagedFiles: Schema.Array(Schema.String),
  config: ProjectConfig,
});

export type HookInput = typeof HookInput.Type;

export const HookResult = Schema.Struct({
  exitCode: Schema.Number,
  stderr: Schema.String,
});

export type HookResult = typeof HookResult.Type;

export const InstalledHookValue = Schema.Struct({
  value: Schema.String,
  installedFrom: Schema.String.pipe(Schema.UndefinedOr),
});

export type InstalledHookValue = typeof InstalledHookValue.Type;

const encodeHookInputToJson = Schema.encodeUnknownSync(HookInput);

const executeShellHook = Effect.fn(function* (path: string, input: HookInput) {
  const fs = yield* FileSystem.FileSystem;

  const info = yield* fs.stat(path).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to read hook "${path}"`,
          cause,
        }),
    ),
  );

  if ((info.mode & 0o111) === 0) {
    return yield* new ConfigError({
      message: `hook is not executable: ${path}`,
    });
  }

  return yield* runProcess({
    command: "/bin/sh",
    args: [path],
    stdin: Formatter.formatJson(encodeHookInputToJson(input)),
    allowFailure: true,
  }).pipe(
    Effect.map(
      (result) =>
        ({
          exitCode: result.exitCode,
          stderr: result.stderr,
        }) satisfies HookResult,
    ),
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `failed to run hook "${path}"`,
          cause,
        }),
    ),
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

export const executeHooks = Effect.fn("Commit.run-hooks")(function* (
  hooks: ReadonlyArray<string>,
  input: HookInput,
) {
  yield* Effect.annotateCurrentSpan({ hook_count: hooks.length });

  let warnings = "";
  for (const hook of hooks) {
    if (hook === "" || hook === "empty") {
      continue;
    }

    const result = yield* Effect.withSpan(
      hook === "conventional"
        ? Effect.sync(() => executeConventionalHook(input))
        : executeShellHook(hook, input),
      "Hooks.Execute",
      { attributes: { hook, hook_type: hook === "conventional" ? "conventional" : "shell" } },
    );

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

export const installHookValue = Effect.fn(function* (repoRoot: string, key: string, value: string) {
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
          message: `reading hook file "${value}"`,
          cause,
        }),
    ),
  );
  const destination = path.join(repoRoot, ".git-agent", "hooks", "pre-commit");

  yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "creating hooks dir",
          cause,
        }),
    ),
  );
  yield* fs.writeFile(destination, data, { mode: 0o755 }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: "installing hook",
          cause,
        }),
    ),
  );

  return {
    value: sourcePath,
    installedFrom: value,
  } satisfies InstalledHookValue;
});
