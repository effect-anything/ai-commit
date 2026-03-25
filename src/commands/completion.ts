import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { UnsupportedFeatureError } from "../shared/errors";
import { runProcess } from "../shared/process";

const supportedShells = ["bash", "zsh", "fish", "powershell"] as const;

export const commandCompletion = Command.make(
  "completion",
  {
    shell: Argument.choice("shell", supportedShells).pipe(
      Argument.withDescription("Shell to generate completions for."),
    ),
  },
  Effect.fn(function* (input) {
    if (input.shell === "powershell") {
      return yield* Effect.fail(
        new UnsupportedFeatureError({
          message: "powershell completion is not supported by the current Effect CLI runtime",
        }),
      );
    }

    const executable = process.argv[0];
    const entrypoint = process.argv[1];

    if (executable == null || entrypoint == null) {
      return yield* Effect.fail(
        new UnsupportedFeatureError({
          message: "cannot determine the current CLI entrypoint for completion generation",
        }),
      );
    }

    const result = yield* runProcess({
      command: executable,
      args: [entrypoint, "--completions", input.shell],
    });
    yield* Effect.sync(() => {
      process.stdout.write(result.stdout);
    });
  }),
).pipe(Command.withDescription("Generate shell completion scripts."));
