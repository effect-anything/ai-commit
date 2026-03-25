#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import PackageJson from "../package.json" with { type: "json" };
import { commandRoot } from "./commands/root";
import { renderError } from "./shared/errors";

const Live = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
);

const program = Command.run(commandRoot, {
  version: PackageJson.version,
}).pipe(
  Effect.provide(Live),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(renderError(error));
      process.exitCode =
        error != null &&
        typeof error === "object" &&
        "_tag" in error &&
        error._tag === "HookBlockedError"
          ? 2
          : 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
