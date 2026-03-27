import { NodeServices } from "@effect/platform-node";
import { Cause, ConfigProvider, Effect, Layer } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http";
import PackageJson from "../package.json" with { type: "json" };
import { commandRoot } from "./commands/root.ts";
import { ConfigServiceLive } from "./config/service.ts";
import { CommitLlmServicesLive, CommitServiceLive } from "./services/commit-service.ts";
import { GitignoreServiceLive } from "./services/gitignore-service.ts";
import { HookServiceLive } from "./services/hooks.ts";
import { LlmClientLive } from "./services/openai-client.ts";
import { ScopeServiceLive } from "./services/scope-service.ts";
import { VcsLive } from "./services/vcs.ts";
import { renderError } from "./shared/errors.ts";
import { gitAgentProgressRenderConfig } from "./shared/progress-config.ts";
import { makeProgressLayer } from "./shared/tracing.ts";

const toConfigEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

export const makePlatformLayer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
) => Layer.mergeAll(NodeServices.layer, httpClientLayer);

const makeServicesLayer = (
  configProvider: Layer.Layer<never>,
  platformLayer?: Layer.Layer<HttpClient.HttpClient | NodeServices.NodeServices> | undefined,
) => {
  const platform = platformLayer ?? makePlatformLayer();
  const coreServices = Layer.mergeAll(VcsLive, HookServiceLive, LlmClientLive).pipe(
    Layer.provideMerge(platform),
  );
  const configServices = ConfigServiceLive.pipe(
    Layer.provideMerge(Layer.mergeAll(platform, configProvider)),
  );

  const featureServices = Layer.mergeAll(
    CommitLlmServicesLive,
    ScopeServiceLive,
    GitignoreServiceLive,
  ).pipe(Layer.provideMerge(Layer.mergeAll(coreServices, configServices)));

  const commitRuntime = CommitServiceLive.pipe(
    Layer.provideMerge(Layer.mergeAll(coreServices, configServices, featureServices)),
  );

  return Layer.mergeAll(
    coreServices,
    configServices,
    featureServices,
    commitRuntime,
    makeProgressLayer(gitAgentProgressRenderConfig),
  );
};

interface CliProgramOptions {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly platformLayer?:
    | Layer.Layer<HttpClient.HttpClient | NodeServices.NodeServices>
    | undefined;
}

export const makeCliProgram = (
  args: ReadonlyArray<string>,
  options: CliProgramOptions = {},
): Effect.Effect<number, never> => {
  const configProvider = ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: toConfigEnv(options.env ?? process.env) }),
  );
  const services = makeServicesLayer(configProvider, options.platformLayer);
  const live = Layer.mergeAll(services, configProvider);

  return Command.runWith(commandRoot, {
    version: PackageJson.version,
  })(args).pipe(
    Effect.provide(live),
    Effect.as(0),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        if (CliError.isCliError(error) && error._tag === "ShowHelp") {
          return error.errors.length > 0 ? 1 : 0;
        }

        console.error(renderError(error));

        return error != null &&
          typeof error === "object" &&
          "_tag" in error &&
          error._tag === "HookBlockedError"
          ? 2
          : 1;
      }),
    ),
  );
};
