import { Schema } from "effect";

export class CliUsageError extends Schema.TaggedErrorClass<CliUsageError>()("CliUsageError", {
  message: Schema.String,
}) {}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class ProcessExecutionError extends Schema.TaggedErrorClass<ProcessExecutionError>()(
  "ProcessExecutionError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
  },
) {}

export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.String),
}) {}

export class HookBlockedError extends Schema.TaggedErrorClass<HookBlockedError>()(
  "HookBlockedError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.String),
    lastMessage: Schema.optional(Schema.String),
  },
) {}

export class CommitPlanError extends Schema.TaggedErrorClass<CommitPlanError>()("CommitPlanError", {
  message: Schema.String,
}) {}

export class UnsupportedFeatureError extends Schema.TaggedErrorClass<UnsupportedFeatureError>()(
  "UnsupportedFeatureError",
  {
    message: Schema.String,
  },
) {}

export const renderError = (error: unknown): string => {
  if (error instanceof CliUsageError) {
    return error.message;
  }
  if (error instanceof ConfigError) {
    return error.message;
  }
  if (error instanceof ApiError) {
    const parts = [error.message];
    if (typeof error.status === "number") {
      parts.push(`status: ${error.status}`);
    }
    if (typeof error.body === "string" && error.body.trim().length > 0) {
      parts.push(error.body.trim());
    }
    return parts.join("\n");
  }
  if (error instanceof ProcessExecutionError) {
    const details = error.stderr.trim().length > 0 ? error.stderr.trim() : error.stdout.trim();
    return `${error.command} exited with code ${error.exitCode}${details.length > 0 ? `\n${details}` : ""}`;
  }
  if (error instanceof HookBlockedError) {
    const lines = [error.message];
    if (typeof error.reason === "string" && error.reason.trim().length > 0) {
      lines.push("", `hook rejected: ${error.reason.trim()}`);
    }
    if (typeof error.lastMessage === "string" && error.lastMessage.trim().length > 0) {
      lines.push("", "rejected message:", "", error.lastMessage.trim());
    }
    return lines.join("\n");
  }
  if (error instanceof CommitPlanError) {
    return error.message;
  }
  if (error instanceof UnsupportedFeatureError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}\n${error.message}`;
  }
  return String(error);
};
