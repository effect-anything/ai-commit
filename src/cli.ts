#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import PackageJson from "../package.json" with { type: "json" };
import { commandRoot } from "./commands/root.ts";
import { CommitLlmServicesLive, CommitServiceLive } from "./services/commit-service.ts";
import { GitignoreServiceLive } from "./services/gitignore-service.ts";
import { HookServiceLive } from "./services/hooks.ts";
import { LlmClientLive } from "./services/openai-client.ts";
import { ScopeServiceLive } from "./services/scope-service.ts";
import { VcsLive } from "./services/vcs.ts";
import { renderError } from "./shared/errors.ts";
import { gitAgentProgressRenderConfig } from "./shared/progress-config.ts";
import { makeProgressLayer } from "./shared/tracing.ts";

const PlatformLive = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const CoreServicesLive = Layer.mergeAll(VcsLive, HookServiceLive, LlmClientLive).pipe(
  Layer.provideMerge(PlatformLive),
);

const FeatureServicesLive = Layer.mergeAll(
  CommitLlmServicesLive,
  ScopeServiceLive,
  GitignoreServiceLive,
).pipe(Layer.provideMerge(CoreServicesLive));

const CommitRuntimeLive = CommitServiceLive.pipe(
  Layer.provideMerge(Layer.mergeAll(CoreServicesLive, FeatureServicesLive)),
);

const ServicesLive = Layer.mergeAll(
  CoreServicesLive,
  FeatureServicesLive,
  CommitRuntimeLive,
  makeProgressLayer(gitAgentProgressRenderConfig),
);

const Live = ServicesLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())));

const program = Command.run(commandRoot, {
  version: PackageJson.version,
}).pipe(
  Effect.provide(Live),
  Effect.catch((error) =>
    Effect.sync(() => {
      if (CliError.isCliError(error) && error._tag === "ShowHelp") {
        process.exitCode = error.errors.length > 0 ? 1 : 0;
        return;
      }

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
