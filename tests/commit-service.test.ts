import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CommitGroup } from "../src/domain/commit";
import type { CommitRequest } from "../src/services/commit-service";
import { ensureJjWorkingCopyMatchesPlan } from "../src/services/commit-service";
import type { VcsClient } from "../src/services/vcs";

const makeRequest = (files: ReadonlyArray<string>) =>
  ({
    cwd: "/repo",
    vcs: {
      unstagedDiff: () =>
        Effect.succeed({
          files: [...files],
          content: "",
          lines: 0,
        }),
    } as unknown as VcsClient,
  }) as CommitRequest;

const group = (files: ReadonlyArray<string>) =>
  ({
    files: [...files],
    message: undefined,
  }) satisfies CommitGroup;

describe("ensureJjWorkingCopyMatchesPlan", () => {
  it("succeeds when the working copy still matches the remaining groups", async () => {
    await expect(
      Effect.runPromise(
        ensureJjWorkingCopyMatchesPlan(makeRequest(["src/feature.ts"]), [
          group(["src/feature.ts"]),
        ]) as Effect.Effect<void, unknown, never>,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails when unexpected files appear in the jj working copy", async () => {
    await expect(
      Effect.runPromise(
        ensureJjWorkingCopyMatchesPlan(makeRequest(["src/feature.ts", "src/unexpected.ts"]), [
          group(["src/feature.ts"]),
        ]) as Effect.Effect<void, unknown, never>,
      ),
    ).rejects.toMatchObject({
      message:
        "jj working copy drifted after commit; expected remaining files: src/feature.ts; actual remaining files: src/feature.ts, src/unexpected.ts",
    });
  });
});
