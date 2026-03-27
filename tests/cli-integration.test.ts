import { NodeServices } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import {
  chmodFile,
  createGitRepo,
  fileExists,
  readTextFile,
  runCli,
  writeTextFile,
} from "./integration/helpers.ts";

describe.concurrent("CLI integration", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "get prefers local hook over project hook",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        yield* writeTextFile(repo, ".ai-commit/config.json", '{\n  "hook": ["conventional"]\n}\n');
        yield* writeTextFile(repo, ".ai-commit/config.local.json", '{\n  "hook": ["empty"]\n}\n');

        const result = yield* runCli(["config", "get", "hook"], {
          cwd: repo,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("empty");
        expect(result.stdout).toContain("local");
      }),
    );

    it.effect(
      "config set hook installs the script into .ai-commit/hooks",
      Effect.fn(function* () {
        const repo = yield* createGitRepo();
        const hookPath = yield* writeTextFile(repo, "scripts/pre-commit.sh", "#!/bin/sh\nexit 0\n");
        yield* chmodFile(hookPath, 0o755);

        const result = yield* runCli(["config", "set", "--scope", "project", "hook", hookPath], {
          cwd: repo,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`installed hook: ${hookPath}`);
        expect(yield* fileExists(repo, ".ai-commit/hooks/pre-commit")).toBe(true);
        expect(yield* readTextFile(repo, ".ai-commit/config.json")).toContain(hookPath);
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

        const userConfig = yield* readTextFile(repo, "../.xdg/ai-commit/config.json");
        expect(userConfig).toContain('"model": "gpt-4o-mini"');
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
        expect(yield* fileExists(repo, ".ai-commit/config.json")).toBe(false);
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
  });
});
