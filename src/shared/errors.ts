import { Schema } from "effect";

class CliUsageError extends Schema.TaggedErrorClass<CliUsageError>()("CliUsageError", {
  message: Schema.String,
}) {
  static is = Schema.is(this);
}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  static is = Schema.is(this);
}

export class ProcessExecutionError extends Schema.TaggedErrorClass<ProcessExecutionError>()(
  "ProcessExecutionError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
  },
) {
  static is = Schema.is(this);
}

export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {
  static is = Schema.is(this);
}

export class HookBlockedError extends Schema.TaggedErrorClass<HookBlockedError>()(
  "HookBlockedError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.String),
    lastMessage: Schema.optional(Schema.String),
  },
) {
  static is = Schema.is(this);
}

export class CommitPlanError extends Schema.TaggedErrorClass<CommitPlanError>()("CommitPlanError", {
  message: Schema.String,
}) {
  static is = Schema.is(this);
}

export class UnsupportedFeatureError extends Schema.TaggedErrorClass<UnsupportedFeatureError>()(
  "UnsupportedFeatureError",
  {
    message: Schema.String,
  },
) {
  static is = Schema.is(this);
}

export const renderError = (error: unknown): string => {
  if (CliUsageError.is(error)) {
    return error.message;
  }
  if (ConfigError.is(error)) {
    return error.message;
  }
  // if (ApiError.is(error)) {
  //   const parts = [error.message];
  //   if (typeof error.status === "number") {
  //     parts.push(`status: ${error.status}`);
  //   }
  //   if (typeof error.body === "string" && error.body.trim().length > 0) {
  //     parts.push(error.body.trim());
  //   }
  //   return parts.join("\n");
  // }
  if (ProcessExecutionError.is(error)) {
    const details = error.stderr.trim().length > 0 ? error.stderr.trim() : error.stdout.trim();
    return `${error.command} exited with code ${error.exitCode}${details.length > 0 ? `\n${details}` : ""}`;
  }
  if (HookBlockedError.is(error)) {
    const lines = [error.message];
    if (typeof error.reason === "string" && error.reason.trim().length > 0) {
      lines.push("", `hook rejected: ${error.reason.trim()}`);
    }
    if (typeof error.lastMessage === "string" && error.lastMessage.trim().length > 0) {
      lines.push("", "rejected message:", "", error.lastMessage.trim());
    }
    return lines.join("\n");
  }
  if (CommitPlanError.is(error)) {
    return error.message;
  }
  if (UnsupportedFeatureError.is(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}\n${error.message}`;
  }
  return String(error);
};
