import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { it } from "vitest";
import type { CommitGroup } from "../src/domain/commit.ts";
import type { CommitRequest } from "../src/services/commit-service.ts";
import {
  ensureJjWorkingCopyMatchesPlan,
  normalizePlannedGroups,
} from "../src/services/commit-service.ts";
import type { VcsClient } from "../src/services/vcs.ts";

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
  layer(Layer.empty)((it) => {
    it.effect(
      "succeeds when the working copy still matches the remaining groups",
      Effect.fn(function* () {
        yield* ensureJjWorkingCopyMatchesPlan(makeRequest(["src/feature.ts"]), [
          group(["src/feature.ts"]),
        ]);
      }),
    );

    it.effect(
      "fails when unexpected files appear in the jj working copy",
      Effect.fn(function* () {
        const error = yield* Effect.flip(
          ensureJjWorkingCopyMatchesPlan(makeRequest(["src/feature.ts", "src/unexpected.ts"]), [
            group(["src/feature.ts"]),
          ]),
        );

        expect(error.message).toBe(
          "jj working copy drifted after commit; expected remaining files: src/feature.ts; actual remaining files: src/feature.ts, src/unexpected.ts",
        );
      }),
    );
  });
});

describe("normalizePlannedGroups", () => {
  it("moves user-staged files into the first group and removes them from later groups", () => {
    const groups = normalizePlannedGroups(
      [group(["src/unstaged.ts"]), group(["src/staged.ts"])],
      new Set(["src/staged.ts", "src/unstaged.ts"]),
      ["src/staged.ts"],
    );

    expect(groups).toEqual([group(["src/staged.ts", "src/unstaged.ts"])]);
  });

  it("falls back to the real changed files when the planner omits every allowed file", () => {
    const groups = normalizePlannedGroups([], new Set(["src/app.ts", "src/feature.ts"]), []);

    expect(groups).toEqual([group(["src/app.ts", "src/feature.ts"])]);
  });
});
