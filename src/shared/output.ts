import { Console, Effect } from "effect";
import type { SingleCommitResult } from "../domain/commit";

const indent = (value: string, prefix = "   "): string =>
  value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

const renderFiles = (files: ReadonlyArray<string>): string =>
  files.length === 0 ? "Files: none" : `Files: ${files.join(", ")}`;

const renderCommitBlock = (commit: SingleCommitResult, index: number): string => {
  const sections = [`${index + 1}. ${commit.title}`, indent(renderFiles(commit.files))];

  for (const bullet of commit.bullets) {
    sections.push(indent(`- ${bullet}`));
  }

  if (commit.explanation.trim().length > 0) {
    sections.push(indent(commit.explanation.trim()));
  }

  if (commit.output?.trim().length) {
    sections.push(indent(commit.output.trim()));
  }

  return sections.join("\n");
};

export const printDryRunResult = (commits: ReadonlyArray<SingleCommitResult>) =>
  Effect.forEach(commits, (commit, index) => Console.log(renderCommitBlock(commit, index)));

export const printCommitResult = (commits: ReadonlyArray<SingleCommitResult>) =>
  Console.log(
    [`Created ${commits.length} commit${commits.length === 1 ? "" : "s"}.`, ""]
      .concat(commits.map((commit, index) => renderCommitBlock(commit, index)).join("\n\n"))
      .join("\n"),
  );
