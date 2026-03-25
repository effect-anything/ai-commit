import { Console, Effect } from "effect";
import type { SingleCommitResult } from "../domain/commit";

export const printDryRunResult = (commits: ReadonlyArray<SingleCommitResult>) =>
  Effect.forEach(commits, (commit, index) =>
    Console.log(`${index + 1}. ${commit.title}\n   ${commit.files.join(", ")}`),
  );

export const printCommitResult = (commits: ReadonlyArray<SingleCommitResult>) =>
  Effect.forEach(commits, (commit) =>
    Console.log(
      [commit.output?.trim(), commit.explanation.trim()]
        .filter((value) => value != null && value.length > 0)
        .join("\n"),
    ),
  );
