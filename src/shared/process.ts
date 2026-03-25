import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ProcessExecutionError } from "./errors";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunProcessOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: string;
  readonly allowFailure?: boolean;
}

const encoder = new TextEncoder();

const renderCommand = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ");

const toProcessExecutionError = (command: string, args: ReadonlyArray<string>, cause: unknown) =>
  new ProcessExecutionError({
    command: renderCommand(command, args),
    exitCode: 1,
    stdout: "",
    stderr: cause instanceof Error ? cause.message : String(cause),
  });

export const runProcess = ({
  command,
  args = [],
  cwd,
  env,
  stdin,
  allowFailure = false,
}: RunProcessOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command, [...args], {
        cwd,
        env,
        extendEnv: true,
        ...(typeof stdin === "string" ? { stdin: Stream.succeed(encoder.encode(stdin)) } : {}),
      });
      const { stdout, stderr, exitCode } = yield* Effect.all({
        stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
        stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
        exitCode: handle.exitCode,
      });
      const result = {
        stdout,
        stderr,
        exitCode: Number(exitCode),
      } satisfies ProcessResult;

      if (result.exitCode !== 0 && !allowFailure) {
        return yield* new ProcessExecutionError({
          command: renderCommand(command, args),
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      return result;
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof ProcessExecutionError
          ? Effect.failSync(() => cause)
          : Effect.failSync(() => toProcessExecutionError(command, args, cause)),
      ),
    ),
  );
