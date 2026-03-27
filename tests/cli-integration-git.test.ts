import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import {
  createGitRepo,
  fileExists,
  git,
  gitCommitAll,
  makeMockHttpClientLayer,
  projectScopesConfig,
  readTextFile,
  runCli,
  startMockGitignoreServer,
  startMockLlmServer,
  trimmedLines,
  writeTextFile,
} from "./integration/helpers.ts";

const seedGitRepo = Effect.fn(function* () {
  const repo = yield* createGitRepo();
  yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v1';\n");
  yield* writeTextFile(repo, "web/page.tsx", "export const page = 'home';\n");
  yield* gitCommitAll(repo, "chore: seed repo");
  return repo;
});

const seedGitRepoWithScopes = Effect.fn(function* () {
  const repo = yield* seedGitRepo();
  yield* writeTextFile(
    repo,
    ".ai-commit/config.json",
    projectScopesConfig([
      ["api", "Backend API handlers"],
      ["web", "Frontend pages"],
      ["core", "Shared application logic"],
    ]),
  );
  return repo;
});

const stagePartialHunk = (cwd: string, relativePath: string, from: string, to: string): void => {
  execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], {
    cwd,
    input:
      `diff --git a/${relativePath} b/${relativePath}\n` +
      `--- a/${relativePath}\n` +
      `+++ b/${relativePath}\n` +
      "@@ -1 +1 @@\n" +
      `-${from}\n` +
      `+${to}\n`,
  });
};

describe.concurrent("CLI integration (git)", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "git init --scope writes generated scopes into project config",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        const llm = yield* startMockLlmServer([
          {
            content: {
              scopes: [
                { name: "api", description: "Backend API handlers" },
                { name: "web", description: "Frontend pages " },
              ],
            },
          },
        ]);

        const result = yield* runCli(
          [
            "init",
            "--scope",
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
        expect(result.stdout).toContain("scopes written");
        const config = yield* readTextFile(repo, ".ai-commit/config.json");
        expect(config).toContain('"name": "api"');
        expect(config).toContain('"description": "Backend API handlers"');
        expect(config).toContain('"name": "web"');
        expect(llm.requests).toHaveLength(1);
      }),
    );

    it.effect(
      "git init --gitignore merges generated rules and preserves custom entries",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        yield* writeTextFile(repo, ".gitignore", "dist/\n\n# keep me\ncustom.cache\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              technologies: ["node", "visualstudiocode"],
            },
          },
        ]);
        const gitignore = yield* startMockGitignoreServer({
          "node,visualstudiocode":
            "# Created by https://www.toptal.com/developers/gitignore/api/node,visualstudiocode\nnode_modules/\n.vscode/\n",
        });

        const result = yield* runCli(
          [
            "init",
            "--gitignore",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            env: {
              GIT_AGENT_GITIGNORE_BASE_URL: gitignore.baseUrl,
            },
            httpClientLayer: makeMockHttpClientLayer(llm.handler, gitignore.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(".gitignore updated: node, visualstudiocode");
        const content = yield* readTextFile(repo, ".gitignore");
        expect(content).toContain("### ai-commit auto-generated");
        expect(content).toContain("# Technologies: node, visualstudiocode");
        expect(content).toContain("node_modules/");
        expect(content).toContain(".vscode/");
        expect(content).toContain("### custom rules ###");
        expect(content).toContain("custom.cache");
        expect(gitignore.requests).toEqual(["/node,visualstudiocode"]);
      }),
    );

    it.effect(
      "git init --gitignore works when project config already exists",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        yield* writeTextFile(repo, ".ai-commit/config.json", '{\n  "hook": ["conventional"]\n}\n');

        const llm = yield* startMockLlmServer([
          {
            content: {
              technologies: ["node"],
            },
          },
        ]);
        const gitignore = yield* startMockGitignoreServer({
          node: "# Created by https://www.toptal.com/developers/gitignore/api/node\nnode_modules/\n",
        });

        const result = yield* runCli(
          [
            "init",
            "--gitignore",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
          ],
          {
            cwd: repo,
            env: {
              GIT_AGENT_GITIGNORE_BASE_URL: gitignore.baseUrl,
            },
            httpClientLayer: makeMockHttpClientLayer(llm.handler, gitignore.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(".gitignore updated: node");
        expect(yield* readTextFile(repo, ".ai-commit/config.json")).toContain("conventional");
      }),
    );

    it.effect(
      "git commit fails without an API key before mutating the repository",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v2';\n");

        const before = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();
        const result = yield* runCli(["commit", "--dry-run"], { cwd: repo });
        const after = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("API key");
        expect(after).toBe(before);
      }),
    );

    it.effect(
      "git commit fails safely when there are no changes",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        const before = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();
        const result = yield* runCli(
          [
            "commit",
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
        const after = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("no changes");
        expect(after).toBe(before);
      }),
    );

    it.effect(
      "git commit rejects invalid trailer syntax before creating any commit",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v2';\n");

        const before = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();
        const result = yield* runCli(
          [
            "commit",
            "--dry-run",
            "--api-key",
            "test-key",
            "--base-url",
            "http://127.0.0.1:9/v1",
            "--model",
            "test-model",
            "--trailer",
            "badformat",
          ],
          { cwd: repo },
        );
        const after = (yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim();

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('invalid --trailer format "badformat"');
        expect(after).toBe(before);
      }),
    );

    it.effect(
      "git commit --dry-run preserves a partially staged index",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(
          repo,
          "src/app.ts",
          "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
        );
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(
          repo,
          ".ai-commit/config.json",
          projectScopesConfig([["core", "Core"]]),
        );
        yield* writeTextFile(
          repo,
          "src/app.ts",
          "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n",
        );
        stagePartialHunk(repo, "src/app.ts", "one", "ONE");

        const llm = yield* startMockLlmServer([
          {
            content: {
              title: "fix(core): preserve staged patch",
              bullets: ["Keep the dry run read-only"],
              explanation: "Ensures dry-run does not rewrite the git index.",
            },
          },
        ]);

        const beforeCached = yield* git(repo, ["diff", "--cached", "--binary"]);
        const beforeUnstaged = yield* git(repo, ["diff", "--binary"]);
        const result = yield* runCli(
          [
            "commit",
            "--dry-run",
            "--no-stage",
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
        const afterCached = yield* git(repo, ["diff", "--cached", "--binary"]);
        const afterUnstaged = yield* git(repo, ["diff", "--binary"]);

        expect(result.exitCode).toBe(0);
        expect(afterCached.stdout).toBe(beforeCached.stdout);
        expect(afterUnstaged.stdout).toBe(beforeUnstaged.stdout);
      }),
    );

    it.effect(
      "git commit rejects --amend and --no-stage together",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(
          [
            "commit",
            "--amend",
            "--no-stage",
            "--api-key",
            "test-key",
            "--base-url",
            "http://127.0.0.1:9/v1",
            "--model",
            "test-model",
          ],
          { cwd: repo },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--amend and --no-stage cannot be used together");
      }),
    );

    it.effect(
      "git commit --no-stage preserves unstaged hunks in a partially staged file",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(
          repo,
          "src/app.ts",
          "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
        );
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(
          repo,
          ".ai-commit/config.json",
          projectScopesConfig([["core", "Core"]]),
        );
        yield* writeTextFile(
          repo,
          "src/app.ts",
          "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n",
        );
        stagePartialHunk(repo, "src/app.ts", "one", "ONE");

        const llm = yield* startMockLlmServer([
          {
            content: {
              title: "fix(core): preserve staged hunk",
              bullets: ["Commit only the staged part"],
              explanation: "Leaves the remaining working tree change untouched.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--no-stage",
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

        const committed = yield* git(repo, ["show", "HEAD:src/app.ts"]);
        const unstaged = yield* git(repo, ["diff", "--", "src/app.ts"]);
        const cached = yield* git(repo, ["diff", "--cached", "--", "src/app.ts"]);

        expect(result.exitCode).toBe(0);
        expect(committed.stdout).toBe("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
        expect(unstaged.stdout).toContain("-eight");
        expect(unstaged.stdout).toContain("+EIGHT");
        expect(unstaged.stdout).not.toContain("-one");
        expect(unstaged.stdout).not.toContain("+ONE");
        expect(cached.stdout).toBe("");
      }),
    );

    it.effect(
      "git commit --dry-run plans and renders split commits from real file changes",
      Effect.fn(function* () {
        const repo = yield* seedGitRepoWithScopes();
        yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v2';\n");
        yield* writeTextFile(repo, "web/page.tsx", "export const page = 'dashboard';\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["api/routes.ts"],
                  title: "feat(api): update routes",
                },
                {
                  files: ["web/page.tsx"],
                  title: "feat(web): refresh page",
                },
              ],
            },
          },
          {
            content: {
              title: "feat(api): update routes",
              bullets: ["Adjust API routing output"],
              explanation: "Updates the API route response shape.",
            },
          },
          {
            content: {
              title: "feat(web): refresh page",
              bullets: ["Refresh dashboard copy"],
              explanation: "Updates the main page copy for the new flow.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
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
        expect(result.stdout).toContain("1. feat(api): update routes");
        expect(result.stdout).toContain("api/routes.ts");
        expect(result.stdout).toContain("2. feat(web): refresh page");
        expect(result.stdout).toContain("web/page.tsx");
        expect(llm.requests).toHaveLength(3);
        expect(llm.requests[0]?.userPrompt).toContain("api/routes.ts");
        expect(llm.requests[0]?.userPrompt).toContain("web/page.tsx");
        expect(llm.remainingResponses()).toBe(0);
        expect((yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
      }),
    );

    it.effect(
      "git commit --dry-run does not persist auto-generated scopes",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v2';\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              scopes: [{ name: "api", description: "Backend API handlers" }],
            },
          },
          {
            content: {
              scopes: [{ name: "api", description: "Backend API handlers" }],
            },
          },
          {
            content: {
              title: "feat(api): update routes",
              bullets: ["Adjust API routing output"],
              explanation: "Updates the API route response shape.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
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
        expect(result.stdout).toContain("feat(api): update routes");
        expect(yield* fileExists(repo, ".ai-commit/config.json")).toBe(false);
        expect(llm.requests).toHaveLength(3);
      }),
    );

    it.effect(
      "git commit creates split commits that match the planner groups",
      Effect.fn(function* () {
        const repo = yield* seedGitRepoWithScopes();
        yield* writeTextFile(repo, "api/routes.ts", "export const route = 'v2';\n");
        yield* writeTextFile(repo, "web/page.tsx", "export const page = 'dashboard';\n");

        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["api/routes.ts"],
                  title: "feat(api): update routes",
                },
                {
                  files: ["web/page.tsx"],
                  title: "feat(web): refresh page",
                },
              ],
            },
          },
          {
            content: {
              title: "feat(api): update routes",
              bullets: ["Adjust API routing output"],
              explanation: "Updates the API route response shape.",
            },
          },
          {
            content: {
              title: "feat(web): refresh page",
              bullets: ["Refresh dashboard copy"],
              explanation: "Updates the main page copy for the new flow.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
            "--api-key",
            "test-key",
            "--base-url",
            llm.baseUrl,
            "--model",
            "test-model",
            "--trailer",
            "Reviewed-by: Test Runner",
          ],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.remainingResponses()).toBe(0);
        expect(result.stdout).toContain("Scan changes");
        expect(result.stdout).toContain("Plan commits");
        expect(result.stdout).toContain("Generate commit message");
        expect(result.stdout).toContain('group="1/2"');
        expect(result.stdout).toContain("Create commit");
        expect(result.stdout).toContain("Created 2 commits.");
        expect(result.stdout).toContain("1. feat(api): update routes");
        expect(result.stdout).toContain("Files: api/routes.ts");
        expect(result.stdout).toContain("- Adjust API routing output");
        expect(result.stdout).toContain("2. feat(web): refresh page");
        expect(result.stdout).toContain("Files: web/page.tsx");
        expect(result.stdout).toContain("- Refresh dashboard copy");

        const subjects = trimmedLines((yield* git(repo, ["log", "--format=%s", "-n", "2"])).stdout);
        expect(subjects).toEqual(["feat(web): refresh page", "feat(api): update routes"]);

        const headFiles = trimmedLines(
          (yield* git(repo, ["show", "--name-only", "--format=", "HEAD"])).stdout,
        );
        const previousFiles = trimmedLines(
          (yield* git(repo, ["show", "--name-only", "--format=", "HEAD~1"])).stdout,
        );
        const body = (yield* git(repo, ["log", "-1", "--format=%B", "HEAD"])).stdout;
        const status = (yield* git(repo, ["status", "--short"])).stdout;

        expect(headFiles).toContain("web/page.tsx");
        expect(previousFiles).toContain("api/routes.ts");
        expect(body).toContain("Reviewed-by: Test Runner");
        expect(status.trim()).toBe("");
      }),
    );

    it.effect(
      "git commit retries after conventional hook rejection and passes feedback to the next LLM call",

      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(
          repo,
          ".ai-commit/config.json",
          '{\n  "scopes": [\n    {\n      "name": "core",\n      "description": "Shared application logic"\n    }\n  ],\n  "hook": ["conventional"]\n}\n',
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* writeTextFile(repo, "src/extra.ts", "export const extra = 'base';\n");
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* writeTextFile(repo, "src/extra.ts", "export const extra = 'next';\n");

        const firstTitle =
          "feat(core): this title is intentionally far too long for the hook validation";
        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts", "src/extra.ts"],
                  title: "feat(core): update app value",
                },
              ],
            },
          },
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
          ["commit", "--api-key", "test-key", "--base-url", llm.baseUrl, "--model", "test-model"],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.requests).toHaveLength(3);
        expect(llm.requests[2]?.systemPrompt).toContain("Fix the commit message");
        expect(llm.requests[2]?.userPrompt).toContain("Fix the following commit message");
        expect(llm.requests[2]?.userPrompt).toContain(firstTitle);
        expect(llm.requests[2]?.userPrompt).toContain("title must be 50 characters or less");
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "feat(core): update app value",
        );
      }),
    );

    it.effect(
      "git commit retries transient llm failures in the http client layer",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* gitCommitAll(repo, "feat(core): old message");

        const llm = yield* startMockLlmServer([
          {
            status: 503,
            content: {
              error: {
                message: "temporary upstream failure",
              },
            },
          },
          {
            content: {
              title: "fix(core): update app value",
              bullets: ["Update app value output"],
              explanation: "Updates the app value in the working tree.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
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
        expect(llm.requests).toHaveLength(2);
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "fix(core): update app value",
        );
      }),
    );

    it.effect(
      "git commit retries invalid llm json output",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* gitCommitAll(repo, "feat(core): old message");

        const llm = yield* startMockLlmServer([
          {
            content:
              '{"title":"fix(core): update app value","bullets":["Update app value output"],"explanation":"Updates the app value"',
          },
          {
            content: {
              title: "fix(core): update app value",
              bullets: ["Update app value output"],
              explanation: "Updates the app value in the working tree.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
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
        expect(llm.requests).toHaveLength(2);
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "fix(core): update app value",
        );
      }),
    );

    it.effect(
      "git commit exits with hook-blocked status after repeated conventional hook failures",

      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(
          repo,
          ".ai-commit/config.json",
          '{\n  "scopes": [\n    {\n      "name": "core",\n      "description": "Shared application logic"\n    }\n  ],\n  "hook": ["conventional"]\n}\n',
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* writeTextFile(repo, "src/extra.ts", "export const extra = 'base';\n");
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* writeTextFile(repo, "src/extra.ts", "export const extra = 'next';\n");

        const badMessage = {
          title: "feat(core): this title is still too long for the commit hook to accept",
          bullets: ["Add updated app value"],
          explanation: "Updates the app value in the working tree.",
        };
        const llm = yield* startMockLlmServer([
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts", "src/extra.ts"],
                  title: "feat(core): update app value",
                },
              ],
            },
          },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts", "src/extra.ts"],
                  title: "feat(core): update app value",
                },
              ],
            },
          },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
          {
            content: {
              groups: [
                {
                  files: ["src/app.ts", "src/extra.ts"],
                  title: "feat(core): update app value",
                },
              ],
            },
          },
          { content: badMessage },
          { content: badMessage },
          { content: badMessage },
        ]);

        const result = yield* runCli(
          ["commit", "--api-key", "test-key", "--base-url", llm.baseUrl, "--model", "test-model"],
          {
            cwd: repo,
            httpClientLayer: makeMockHttpClientLayer(llm.handler),
          },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("commit blocked after retries");
        expect(result.stderr).toContain("hook rejected:");
        expect(result.stderr).toContain("rejected message:");
        expect(llm.requests).toHaveLength(12);
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "chore: seed repo",
        );
      }),
    );

    it.effect(
      "git commit --amend rewrites the last commit message without creating a new commit",

      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* gitCommitAll(repo, "chore: seed repo");
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'next';\n");
        yield* gitCommitAll(repo, "feat(core): old message");

        const llm = yield* startMockLlmServer([
          {
            content: {
              title: "fix(core): clarify app update",
              bullets: ["Describe the updated app value"],
              explanation: "Keeps the last commit but rewrites its message.",
            },
          },
        ]);

        const result = yield* runCli(
          [
            "commit",
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
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "fix(core): clarify app update",
        );
        expect((yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
      }),
    );
  });
});
