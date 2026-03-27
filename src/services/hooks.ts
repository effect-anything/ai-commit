import { Effect, FileSystem, Formatter, Layer, Path, Schema, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
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

const HookResult = Schema.Struct({
  exitCode: Schema.Number,
  stderr: Schema.String,
});

type HookResult = typeof HookResult.Type;

const InstalledHookValue = Schema.Struct({
  value: Schema.String,
  installedFrom: Schema.String.pipe(Schema.UndefinedOr),
});

type InstalledHookValue = typeof InstalledHookValue.Type;

const encodeHookInputToJson = Schema.encodeUnknownSync(HookInput);

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

interface HookServiceShape {
  readonly execute: (
    hooks: ReadonlyArray<string>,
    input: HookInput,
  ) => Effect.Effect<HookResult, ConfigError>;
  readonly installValue: (
    repoRoot: string,
    key: string,
    value: string,
  ) => Effect.Effect<InstalledHookValue, ConfigError>;
}

export class HookService extends ServiceMap.Service<HookService, HookServiceShape>()(
  "@ai-commit/HookService",
) {}

export const HookServiceLive = Layer.effect(
  HookService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;

    const executeShellHook = Effect.fn(function* (hookPath: string, input: HookInput) {
      const info = yield* fs.stat(hookPath).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message: `failed to read hook "${hookPath}"`,
              cause,
            }),
        ),
      );

      if ((info.mode & 0o111) === 0) {
        return yield* new ConfigError({
          message: `hook is not executable: ${hookPath}`,
        });
      }

      return yield* runProcess({
        command: "/bin/sh",
        args: [hookPath],
        stdin: Formatter.formatJson(encodeHookInputToJson(input)),
        allowFailure: true,
      }).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
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
              message: `failed to run hook "${hookPath}"`,
              cause,
            }),
        ),
      );
    });

    const execute: HookServiceShape["execute"] = Effect.fn("Commit.run-hooks")(function* (
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

    const installValue: HookServiceShape["installValue"] = Effect.fn(function* (
      repoRoot: string,
      key: string,
      value: string,
    ) {
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
      const destination = path.join(repoRoot, ".ai-commit", "hooks", "pre-commit");

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

    return {
      execute,
      installValue,
    } satisfies HookServiceShape;
  }),
);
