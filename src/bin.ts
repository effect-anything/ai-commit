#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { makeCliProgram } from "./cli-app.ts";

NodeRuntime.runMain(
  Effect.flatMap(
    Effect.sync(() => process.argv.slice(2)),
    (args) =>
      makeCliProgram(args).pipe(
        Effect.flatMap((exitCode) =>
          Effect.sync(() => {
            process.exitCode = exitCode;
          }),
        ),
      ),
  ),
  { disableErrorReporting: true },
);
