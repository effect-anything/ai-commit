import { Command } from "effect/unstable/cli";
import { commandCommit } from "./commit.ts";
import { commandConfig } from "./config.ts";
import { commandInit } from "./init.ts";
import { commandVersion } from "./version.ts";

export const commandRoot = Command.make("ai-commit").pipe(
  Command.withDescription("AI-first Git/JJ CLI for atomic commits and generated messages."),
  Command.withSubcommands([commandCommit, commandConfig, commandInit, commandVersion]),
  Command.withExamples([
    {
      command: "config set api_key sk-xxx",
      description: "Write your user-level API key.",
    },
    {
      command: "init",
      description: "Initialize ai-commit in the current repository.",
    },
    {
      command: "commit --dry-run",
      description: "Preview the generated commit plan without creating commits.",
    },
    {
      command: 'commit --intent "split auth refactor from API cleanup"',
      description: "Guide the planner toward a specific grouping intent.",
    },
  ]),
);
