import { Effect, FileSystem, Path } from "effect";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, type ProcessResult } from "../../src/shared/process.ts";

const cliEntry = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface CliOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly allowFailure?: boolean | undefined;
}

export interface MockLlmRequest {
  readonly path: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface MockLlmResponse {
  readonly content?:
    | string
    | Record<string, unknown>
    | ((request: MockLlmRequest) => string | Record<string, unknown>)
    | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly status?: number | undefined;
}

export interface MockLlmServer {
  readonly baseUrl: string;
  readonly requests: Array<MockLlmRequest>;
  readonly remainingResponses: () => number;
}

export interface MockGitignoreServer {
  readonly baseUrl: string;
  readonly requests: Array<string>;
}

const closeServer = (server: Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error != null) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  ).pipe(Effect.catchDefect(() => Effect.void));

const listenServer = (server: Server) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("error", onError);
          reject(error);
        };
        server.on("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address();
          if (address == null || typeof address === "string") {
            reject(new Error("mock llm server did not expose a tcp port"));
            return;
          }
          resolve(address.port);
        });
      }),
  );

const readRequestBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const readInputText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      typeof part === "object" && part != null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
};

const removeDirectory = (dir: string) =>
  Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(
    Effect.catchDefect(() => Effect.void),
  );

const createTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    removeDirectory,
  );

const run = (command: string, args: ReadonlyArray<string>, cwd: string, allowFailure = false) =>
  runProcess({
    command,
    args,
    cwd,
    allowFailure,
  });

export const writeTextFile = Effect.fn(function* (
  root: string,
  relativePath: string,
  content: string,
  mode = 420,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fullPath = path.join(root, relativePath);
  yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
  yield* fs.writeFileString(fullPath, content, { mode });
  return fullPath;
});

export const readTextFile = Effect.fn(function* (root: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(root, relativePath), "utf8");
});

export const fileExists = Effect.fn(function* (root: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(root, relativePath));
});

export const chmodFile = (pathValue: string, mode: number) =>
  Effect.promise(() => chmod(pathValue, mode));

export const createGitRepo = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* createTempDir("git-agent-git-");
  const dir = path.join(root, "repo");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* run("git", ["init"], dir);
  yield* run("git", ["config", "user.name", "Git Agent Test"], dir);
  yield* run("git", ["config", "user.email", "git-agent@example.com"], dir);
  return dir;
});

export const createJjRepo = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* createTempDir("git-agent-jj-");
  const dir = path.join(root, "repo");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* run("jj", ["git", "init", "."], dir);
  yield* run("jj", ["config", "set", "--repo", "user.name", "Git Agent Test"], dir);
  yield* run("jj", ["config", "set", "--repo", "user.email", "git-agent@example.com"], dir);
  return dir;
});

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
): Effect.Effect<ProcessResult, unknown, any> => run("git", args, cwd, allowFailure);

export const jj = (
  cwd: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
): Effect.Effect<ProcessResult, unknown, any> => run("jj", args, cwd, allowFailure);

export const gitCommitAll = Effect.fn(function* (cwd: string, message: string) {
  yield* git(cwd, ["add", "-A"]);
  yield* git(cwd, ["commit", "-m", message]);
});

export const jjCommitAll = (cwd: string, message: string, files: ReadonlyArray<string>) =>
  jj(cwd, ["commit", "-m", message, ...files]).pipe(Effect.asVoid);

export const runCli = (args: ReadonlyArray<string>, options: CliOptions) => {
  const isolatedConfigHome = join(dirname(options.cwd), ".xdg");
  return runProcess({
    command: "node",
    args: [cliEntry, ...args],
    cwd: options.cwd,
    allowFailure: options.allowFailure ?? true,
    env: {
      PWD: options.cwd,
      XDG_CONFIG_HOME: isolatedConfigHome,
      OPENAI_COMPACT_API_KEY: "",
      OPENAI_COMPACT_API_BASE_URL: "",
      OPENAI_COMPACT_MODEL: "",
      GIT_AGENT_BUILD_API_KEY: "",
      GIT_AGENT_BUILD_BASE_URL: "",
      GIT_AGENT_BUILD_MODEL: "",
      ...options.env,
    },
  });
};

export const startMockLlmServer = (responses: ReadonlyArray<MockLlmResponse>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const requests: Array<MockLlmRequest> = [];
      let index = 0;

      const server = createServer(async (request, response) => {
        if (
          request.method !== "POST" ||
          request.url == null ||
          !request.url.endsWith("/responses")
        ) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "not found" } }));
          return;
        }

        const rawBody = await readRequestBody(request);
        const parsed = JSON.parse(rawBody) as {
          model?: string | undefined;
          input?: Array<{ role?: string | undefined; content?: unknown | undefined }> | undefined;
          tool_choice?: unknown | undefined;
          temperature?: number | null | undefined;
          top_p?: number | null | undefined;
        };
        const input = Array.isArray(parsed.input) ? parsed.input : [];
        const requestInfo = {
          path: request.url,
          model: typeof parsed.model === "string" ? parsed.model : "",
          systemPrompt: readInputText(
            input.find((message) => message.role === "system" || message.role === "developer")
              ?.content,
          ),
          userPrompt: readInputText(input.find((message) => message.role === "user")?.content),
        } satisfies MockLlmRequest;
        requests.push(requestInfo);

        const next = responses[index];
        index += 1;

        if (next == null) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "no mock response configured" } }));
          return;
        }

        const content =
          typeof next.content === "function" ? next.content(requestInfo) : next.content;
        const status = next.status ?? 200;
        const headers = {
          "content-type": "application/json",
          ...next.headers,
        };
        if (status !== 200) {
          response.writeHead(status, headers);
          response.end(
            typeof content === "string"
              ? content
              : JSON.stringify(content ?? { error: { message: "mock llm error" } }),
          );
          return;
        }
        response.writeHead(status, headers);
        const text = typeof content === "string" ? content : JSON.stringify(content);
        response.end(
          JSON.stringify({
            id: `resp_${index}`,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            model: typeof parsed.model === "string" ? parsed.model : "test-model",
            temperature: parsed.temperature ?? null,
            top_p: parsed.top_p ?? null,
            tools: [],
            tool_choice:
              parsed.tool_choice === "auto" ||
              parsed.tool_choice === "required" ||
              parsed.tool_choice === "none"
                ? parsed.tool_choice
                : "none",
            input,
            output: [
              {
                id: `msg_${index}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text,
                    annotations: [],
                    logprobs: [],
                  },
                ],
              },
            ],
            output_text: text,
            usage: {
              input_tokens: 0,
              input_tokens_details: {
                cached_tokens: 0,
              },
              output_tokens: 0,
              output_tokens_details: {
                reasoning_tokens: 0,
              },
              total_tokens: 0,
            },
            parallel_tool_calls: false,
          }),
        );
      });

      const port = yield* listenServer(server);
      return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        remainingResponses: () => responses.length - index,
        server,
      };
    }),
    ({ server }) => closeServer(server),
  ).pipe(
    Effect.map(({ baseUrl, requests, remainingResponses }) => ({
      baseUrl,
      requests,
      remainingResponses,
    })),
  );

export const startMockGitignoreServer = (templates: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const server = createServer((request, response) => {
        const url = request.url ?? "/";
        requests.push(url);
        const key = url.replace(/^\//, "");
        const template = templates[key];

        if (template == null) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("missing template");
          return;
        }

        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(template);
      });

      const port = yield* listenServer(server);
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        server,
      };
    }),
    ({ server }) => closeServer(server),
  ).pipe(
    Effect.map(({ baseUrl, requests }) => ({
      baseUrl,
      requests,
    })),
  );

export const projectScopesConfig = (scopes: ReadonlyArray<readonly [string, string?]>) =>
  [
    "scopes:",
    ...scopes.flatMap(([name, description]) =>
      description == null
        ? [`  - name: ${name}`]
        : [`  - name: ${name}`, `    description: ${description}`],
    ),
  ].join("\n") + "\n";

export const trimmedLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
