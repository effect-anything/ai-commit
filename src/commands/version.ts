import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import PackageJson from "../../package.json" with { type: "json" };

export const commandVersion = Command.make(
  "version",
  {},
  Effect.fn(function* () {
    yield* Console.log(PackageJson.version);
  }),
).pipe(Command.withDescription("Print the ai-commit version."));
