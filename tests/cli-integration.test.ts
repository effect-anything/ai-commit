import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import {
  chmodFile,
  createGitRepo,
  createJjRepo,
  fileExists,
  git,
  gitCommitAll,
  jj,
  jjCommitAll,
  projectScopesConfig,
  readTextFile,
  runCli,
  startMockGitignoreServer,
  startMockLlmServer,
  trimmedLines,
  writeTextFile,
} from "./integration/helpers";

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
    ".git-agent/config.yml",
    projectScopesConfig([
      ["api", "Backend API handlers"],
      ["web", "Frontend pages"],
      ["core", "Shared application logic"],
    ]),
  );
  return repo;
});

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
    ".git-agent/config.yml",
    projectScopesConfig([
      ["cli", "Command line flows"],
      ["core", "Shared application logic"],
    ]),
  );
  yield* jjCommitAll(repo, "chore: add repo config", [".git-agent/config.yml"]);
  return repo;
});

describe.concurrent("CLI integration", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "get prefers local hook over project hook",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(repo, ".git-agent/config.yml", "hook:\n  - conventional\n");
        yield* writeTextFile(repo, ".git-agent/config.local.yml", "hook:\n  - empty\n");

        const result = yield* runCli(["config", "get", "hook"], {
          cwd: repo,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("empty");
        expect(result.stdout).toContain("local");
      }),
    );

    it.effect(
      "config set hook installs the script into .git-agent/hooks",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const hookPath = yield* writeTextFile(repo, "scripts/pre-commit.sh", "#!/bin/sh\nexit 0\n");
        yield* chmodFile(hookPath, 0o755);

        const result = yield* runCli(["config", "set", "--scope", "project", "hook", hookPath], {
          cwd: repo,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`installed hook: ${hookPath}`);
        expect(yield* fileExists(repo, ".git-agent/hooks/pre-commit")).toBe(true);
        expect(yield* readTextFile(repo, ".git-agent/config.yml")).toContain(hookPath);
      }),
    );

    it.effect(
      "config show resolves provider settings from user scope",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(["config", "show"], {
          cwd: repo,
          env: {
            GIT_AGENT_BUILD_API_KEY: "",
            GIT_AGENT_BUILD_BASE_URL: "https://build.example/v1",
            GIT_AGENT_BUILD_MODEL: "build-model",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("api_key:  (not set)");
        expect(result.stdout).toContain("model:    build-model");
        expect(result.stdout).toContain("base_url: https://build.example/v1");
      }),
    );

    it.effect(
      "config set model defaults to user scope and writes isolated user config",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(["config", "set", "model", "gpt-4o-mini"], {
          cwd: repo,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("set model = gpt-4o-mini  (user)");

        const userConfig = yield* readTextFile(repo, "../.xdg/git-agent/config.yml");
        expect(userConfig).toContain("model: gpt-4o-mini");
      }),
    );

    it.effect(
      "config set rejects provider keys in project scope",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(
          ["config", "set", "--scope", "project", "api_key", "sk-test"],
          { cwd: repo },
        );

        expect(result.exitCode).not.toBe(0);
        expect(yield* fileExists(repo, ".git-agent/config.yml")).toBe(false);
      }),
    );

    it.effect(
      "init --local rejects runs that do not request any action",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(["init", "--local"], { cwd: repo });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--local requires at least one action flag");
      }),
    );

    it.effect(
      "git init --scope writes generated scopes into project config",
      Effect.fn(function* () {
        const repo = yield* seedGitRepo();
        const llm = yield* startMockLlmServer([
          {
            content: {
              scopes: [
                { name: "api", description: "Backend API handlers" },
                { name: "web", description: "Frontend pages" },
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
          { cwd: repo },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("scopes written");
        const config = yield* readTextFile(repo, ".git-agent/config.yml");
        expect(config).toContain("name: api");
        expect(config).toContain("description: Backend API handlers");
        expect(config).toContain("name: web");
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
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(".gitignore updated: node, visualstudiocode");
        const content = yield* readTextFile(repo, ".gitignore");
        expect(content).toContain("### git-agent auto-generated");
        expect(content).toContain("# Technologies: node, visualstudiocode");
        expect(content).toContain("node_modules/");
        expect(content).toContain(".vscode/");
        expect(content).toContain("### custom rules ###");
        expect(content).toContain("custom.cache");
        expect(gitignore.requests).toEqual(["/node,visualstudiocode"]);
      }),
    );

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
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Generate .gitignore");
        expect(result.stdout).toContain("Generate scopes");
        expect(result.stdout).toContain("Write default hook");
        expect(result.stdout).toContain(".gitignore updated: node");
        expect(result.stdout).toContain("scopes written");

        const config = yield* readTextFile(repo, ".git-agent/config.yml");
        const ignore = yield* readTextFile(repo, ".gitignore");
        expect(config).toContain("name: core");
        expect(config).toContain("hook:");
        expect(config).toContain("- conventional");
        expect(ignore).toContain("node_modules/");
        expect(llm.requests).toHaveLength(2);
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
      "removed commit --all flag stays rejected",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(["commit", "--all"], { cwd: repo });

        expect(result.exitCode).not.toBe(0);
      }),
    );

    it.effect(
      "removed add command stays rejected",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const result = yield* runCli(["add", "somefile.txt"], { cwd: repo });

        expect(result.exitCode).not.toBe(0);
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
          { cwd: repo },
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
          { cwd: repo },
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
          ".git-agent/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
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
          { cwd: repo },
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
          { cwd: repo },
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
          { cwd: repo },
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
          ".git-agent/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
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
          { cwd: repo },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("error: commit blocked after retries");
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
          { cwd: repo },
        );

        expect(result.exitCode).toBe(0);
        expect(llm.requests).toHaveLength(1);
        expect((yield* git(repo, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
          "fix(core): clarify app update",
        );
        expect((yield* git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
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
          { cwd: repo },
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
          { cwd: repo },
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
          { cwd: repo },
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
          { cwd: repo },
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
          ".git-agent/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* jjCommitAll(repo, "chore: seed repo", [".git-agent/config.yml", "src/app.ts"]);
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
          { cwd: repo },
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
          ".git-agent/config.yml",
          "scopes:\n  - name: core\n    description: Shared application logic\nhook:\n  - conventional\n",
        );
        yield* writeTextFile(repo, "src/app.ts", "export const value = 'base';\n");
        yield* jjCommitAll(repo, "chore: seed repo", [".git-agent/config.yml", "src/app.ts"]);
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
          { cwd: repo },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("error: commit blocked after retries");
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
