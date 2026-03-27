import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import {
  createJjRepo,
  jj,
  jjCommitAll,
  makeMockHttpClientLayer,
  projectScopesConfig,
  readTextFile,
  runCli,
  startMockGitignoreServer,
  startMockLlmServer,
  trimmedLines,
  writeTextFile,
} from "./integration/helpers.ts";

const seedJjRepo = Effect.fn(function* () {
  const repo = yield* createJjRepo();
  yield* writeTextFile(repo, "src/app.ts", "export const value = 'before';\n");
  yield* writeTextFile(repo, "src/feature.ts", "export const feature = true;\n");
  yield* jjCommitAll(repo, "chore: seed repo", ["src/app.ts", "src/feature.ts"]);
  return repo;
});

const seedJjRepoWithScopes = Effect.fn(function* () {
  const repo = yield* seedJjRepo();
  yield* writeTextFile(
    repo,
    ".ai-commit/config.yml",
    projectScopesConfig([
      ["cli", "Command line flows"],
      ["core", "Shared application logic"],
    ]),
  );
  yield* jjCommitAll(repo, "chore: add repo config", [".ai-commit/config.yml"]);
  return repo;
});

describe.concurrent("CLI integration (jj)", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "jj init full wizard writes scopes, gitignore, and default conventional hook",
      Effect.fn(function* () {
        const repo = yield* seedJjRepo();
        const llm = yield* startMockLlmServer([
          {
            content: {
              technologies: ["node"],
            },
          },
          {
            content: {
              scopes: [{ name: "core", description: "Shared application logic" }],
            },
          },
        ]);
        const gitignore = yield* startMockGitignoreServer({
          node: "# Created by https://www.toptal.com/developers/gitignore/api/node\nnode_modules/\n",
        });

        const result = yield* runCli(
          ["init", "--api-key", "test-key", "--base-url", llm.baseUrl, "--model", "test-model"],
          {
            cwd: repo,
            env: {
              GIT_AGENT_GITIGNORE_BASE_URL: gitignore.baseUrl,
            },
            httpClientLayer: makeMockHttpClientLayer(llm.handler, gitignore.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Generate .gitignore");
        expect(result.stdout).toContain("Generate scopes");
        expect(result.stdout).toContain("Write default hook");
        expect(result.stdout).toContain(".gitignore updated: node");
        expect(result.stdout).toContain("scopes written");

        const config = yield* readTextFile(repo, ".ai-commit/config.yml");
        const ignore = yield* readTextFile(repo, ".gitignore");
        expect(config).toContain("name: core");
        expect(config).toContain("hook:");
        expect(config).toContain("- conventional");
        expect(ignore).toContain("node_modules/");
        expect(llm.requests).toHaveLength(2);
      }),
    );

    it.effect(
      "jj commit --dry-run works against a temporary jj repo",
      Effect.fn(function* () {
        const repo = yield* seedJjRepoWithScopes();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'after';\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              title: "fix(cli): refine app output",
              bullets: ["Update the working-copy value"],
              explanation: "Keeps jj dry-run output deterministic for the test.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--dry-run",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("fix(cli): refine app output");
        expect(result.stdout).toContain("src/app.ts");
        expect(llm.requests).toHaveLength(1);
        expect(
          trimmedLines(
            (yield* jj(repo, [
              "log",
              "--no-graph",
              "-r",
              "all()",
              "-T",
              'description.first_line() ++ "\\n"',
            ])).stdout,
          ).slice(0, 2),
        ).toEqual(["chore: add repo config", "chore: seed repo"]);
      }),
    );

    it.effect(
      "jj commit creates split commits and leaves an empty working copy",
      Effect.fn(function* () {
        const repo = yield* seedJjRepoWithScopes();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'after';\n");
        yield* writeTextFile(repo, "src/feature.ts", "export const feature = false;\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts"],
                  title: "fix(cli): refine app output",
                },
                {
                  files: ["src/feature.ts"],
                  title: "fix(core): adjust feature flag",
                },
              ],
            },
          },
          {
            content: {
              title: "fix(cli): refine app output",
              bullets: ["Update the working-copy value"],
              explanation: "Refines the app output in the jj working copy.",
            },
          },
          {
            content: {
              title: "fix(core): adjust feature flag",
              bullets: ["Update the feature toggle"],
              explanation: "Adjusts the feature toggle in a separate jj commit.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.remainingResponses()).toBe(0);
        expect(result.stdout).toContain("Scan changes");
        expect(result.stdout).toContain('vcs="jj"');
        expect(result.stdout).toContain("Plan commits");
        expect(result.stdout).toContain("Generate commit message");
        expect(result.stdout).toContain("Create commit");
        expect(result.stdout).toContain("Created 2 commits.");
        expect(result.stdout).toContain("1. fix(cli): refine app output");
        expect(result.stdout).toContain("Files: src/app.ts");
        expect(result.stdout).toContain("- Update the working-copy value");
        expect(result.stdout).toContain("2. fix(core): adjust feature flag");
        expect(result.stdout).toContain("Files: src/feature.ts");
        expect(result.stdout).toContain("- Update the feature toggle");
        expect(result.stdout).toContain("Working copy  (@) now at:");
        expect(result.stdout).toContain("Parent commit (@-)");

        const descriptions = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );
        const workingCopyFiles = trimmedLines(
          (yield* jj(repo, ["diff", "-r", "@", "--name-only"])).stdout,
        );
        const headFiles = trimmedLines(
          (yield* jj(repo, ["diff", "-r", "@-", "--name-only"])).stdout,
        );
        const previousFiles = trimmedLines(
          (yield* jj(repo, ["diff", "-r", "@--", "--name-only"])).stdout,
        );

        expect(descriptions.slice(0, 3)).toEqual([
          "fix(core): adjust feature flag",
          "fix(cli): refine app output",
          "chore: add repo config",
        ]);
        expect(workingCopyFiles).toEqual([]);
        expect(headFiles).toEqual(["src/feature.ts"]);
        expect(previousFiles).toEqual(["src/app.ts"]);
      }),
    );

    it.effect(
      "jj commit rejects planner output with overlapping files",
      Effect.fn(function* () {
        const repo = yield* seedJjRepoWithScopes();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'after';\n");
        yield* writeTextFile(repo, "src/feature.ts", "export const feature = false;\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts"],
                  title: "fix(cli): refine app output",
                },
                {
                  files: ["src/app.ts", "src/feature.ts"],
                  title: "fix(core): adjust feature flag",
                },
              ],
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--dry-run",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("planner returned overlapping files for jj");
        expect(result.stderr).toContain("src/app.ts");
        expect(llm.requests).toHaveLength(1);
      }),
    );

    it.effect(
      "jj commit --amend rewrites the previous jj change description",
      Effect.fn(function* () {
        const repo = yield* createJjRepo();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* jjCommitAll(repo, "chore: seed repo", ["src/app.ts"]);
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* jjCommitAll(repo, "feat(core): old message", ["src/app.ts"]);

        const llm = yield* startMockLlmServer([
          {
            content: {
              title: "fix(core): clarify app update",
              bullets: ["Describe the updated jj app value"],
              explanation: "Keeps the jj change but rewrites its description.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--amend",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.requests).toHaveLength(1);

        const descriptions = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );
        expect(descriptions.slice(0, 3)).toEqual([
          "fix(core): clarify app update",
          "chore: seed repo",
        ]);
      }),
    );

    it.effect(
      "jj commit retries after hook rejection and resubmits the previous message",
      Effect.fn(function* () {
        const repo = yield* createJjRepo();
        yield* writeTextFile(
          repo,
          ".ai-commit/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* jjCommitAll(repo, "chore: seed repo", [".ai-commit/config.yml", "src/app.ts"]);
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");

        const firstTitle =
          "feat(core): this title is intentionally far too long for the hook validation";
        const llm = yield* startMockLlmServer([
          {
            content: {
              title: firstTitle,
              bullets: ["Add updated app value"],
              explanation: "Updates the app value in the working tree.",
            },
          },
          {
            content: {
              title: "feat(core): update app value",
              bullets: ["Add app value update"],
              explanation: "Updates the app value in the working tree.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.requests).toHaveLength(2);
        expect(llm.requests[1]?.systemPrompt).toContain("Fix the commit message");
        expect(llm.requests[1]?.userPrompt).toContain(firstTitle);
        expect(llm.requests[1]?.userPrompt).toContain("title must be 50 characters or less");

        const descriptions = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );
        expect(descriptions[0]).toBe("feat(core): update app value");
      }),
    );

    it.effect(
      "jj commit exits with hook-blocked status after repeated hook failures",
      Effect.fn(function* () {
        const repo = yield* createJjRepo();
        yield* writeTextFile(
          repo,
          ".ai-commit/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* jjCommitAll(repo, "chore: seed repo", [".ai-commit/config.yml", "src/app.ts"]);
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");

        const badMessage = {
          title: "feat(core): this title is still too long for the commit hook to accept",
          bullets: ["Add updated app value"],
          explanation: "Updates the app value in the working tree.",
        };
        const llm = yield* startMockLlmServer([
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("commit blocked after retries");
        expect(result.stderr).toContain("hook rejected:");
        expect(result.stderr).toContain("rejected message:");
        expect(llm.requests).toHaveLength(9);

        const descriptions = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );
        expect(descriptions[0]).toBe("chore: seed repo");
      }),
    );

    it.effect(
      "jj commit fails safely when there are no changes",
      Effect.fn(function* () {
        const repo = yield* seedJjRepo();
        const before = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );
        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--dry-run",
            "--api-key",
            "test-key",
            "--base-url",
            "http://127.0.0.1:9/v1",
            "--model",
            "test-model",
          ],
          { cwd: repo },
        );
        const after = trimmedLines(
          (yield* jj(repo, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'description.first_line() ++ "\\n"',
          ])).stdout,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("no changes");
        expect(after).toEqual(before);
      }),
    );

    it.effect(
      "jj commit rejects --no-stage like the git implementation contract expects",
      Effect.fn(function* () {
        const repo = yield* createJjRepo();
        const result = yield* runCli(
          [
            "commit",
            "--vcs",
            "jj",
            "--no-stage",
            "--dry-run",
            "--api-key",
            "test-key",
            "--base-url",
            "http://127.0.0.1:9/v1",
            "--model",
            "test-model",
          ],
          { cwd: repo },
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--no-stage is not supported for jj");
      }),
    );
  });
});
