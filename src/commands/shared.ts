import { Option } from "effect";
import { Flag } from "effect/unstable/cli";
import { cwdEnvironment } from "../config/env.ts";

export const cwdFlag = Flag.string("cwd").pipe(
  Flag.withFallbackConfig(cwdEnvironment),
  Flag.withDescription("Working directory to operate on."),
);

export const vcsFlag = Flag.optional(
  Flag.choice("vcs", ["git", "jj"] as const).pipe(
    Flag.withDescription("Explicit VCS mode. Defaults to auto-detect."),
  ),
);

export const apiKeyFlag = Flag.optional(
  Flag.string("api-key").pipe(Flag.withDescription("API key for the AI provider.")),
);

export const baseUrlFlag = Flag.optional(
  Flag.string("base-url").pipe(Flag.withDescription("OpenAI-compatible base URL.")),
);

export const modelFlag = Flag.optional(
  Flag.string("model").pipe(Flag.withDescription("Model name for generation.")),
);

export const freeFlag = Flag.boolean("free").pipe(
  Flag.withDescription("Use only build-time embedded credentials."),
);

export const toOptionalString = (value: Option.Option<string>): string | undefined =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (text) => (text.trim().length > 0 ? text.trim() : undefined),
  });
