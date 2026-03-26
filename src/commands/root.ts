import { Command } from "effect/unstable/cli";
import { commandCommit } from "./commit.ts";
import { commandConfig } from "./config.ts";
import { commandInit } from "./init.ts";
import { commandVersion } from "./version.ts";

export const commandRoot = Command.make("git-agent").pipe(
  Command.withDescription("AI-first Git/JJ CLI for atomic commits and generated messages."),
  Command.withSubcommands([commandCommit, commandConfig, commandInit, commandVersion]),
  Command.withExamples([
    {
      command: "",
      description: "",
    },
  ]),
);
