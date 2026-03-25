import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Vcs, VcsLive } from "../src/services/vcs";
import { createJjRepo, writeTextFile } from "./integration/helpers";

describe.concurrent("Vcs", () => {
  layer(Layer.mergeAll(NodeServices.layer, VcsLive.pipe(Layer.provide(NodeServices.layer))))(
    (it) => {
      it.effect("jj filesystem scan respects ignored directories from .gitignore", () =>
        Effect.gen(function* () {
          const repo = yield* createJjRepo();
          yield* writeTextFile(repo, ".gitignore", "node_modules/\ndist/\npackages/tmp/\n");
          yield* writeTextFile(repo, "src/app.ts", "export const value = 1;\n");
          yield* writeTextFile(repo, "packages/app/index.ts", "export const nested = true;\n");
          yield* writeTextFile(repo, "packages/tmp/generated.ts", "export const ignored = true;\n");
          yield* writeTextFile(repo, "node_modules/lib/index.js", "module.exports = 1;\n");
          yield* writeTextFile(repo, "dist/out.js", "export const built = true;\n");

          const vcsService = yield* Vcs;
          const { client } = yield* vcsService.resolve(repo, "jj");
          const dirs = yield* client.topLevelDirs(repo);
          const files = yield* client.projectFiles(repo);

          expect(dirs).toEqual(["packages", "src"]);
          expect(files).toContain("packages/app/index.ts");
          expect(files).toContain("src/app.ts");
          expect(files).not.toContain("dist/out.js");
          expect(files).not.toContain("node_modules/lib/index.js");
          expect(files).not.toContain("packages/tmp/generated.ts");
        }),
      );
    },
  );
});
