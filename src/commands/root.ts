import { Command } from "effect/unstable/cli";
import { commandCommit } from "./commit";
import { commandConfig } from "./config";
import { commandInit } from "./init";
import { commandVersion } from "./version";

export const commandRoot = Command.make("git-agent").pipe(
  Command.withDescription("AI-first Git/JJ CLI for atomic commits and generated messages."),
  Command.withSubcommands([commandCommit, commandConfig, commandInit, commandVersion]),
);
