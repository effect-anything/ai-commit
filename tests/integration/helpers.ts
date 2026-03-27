import { Effect, FileSystem, Layer, Path } from "effect";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { makeCliProgram, makePlatformLayer } from "../../src/cli-app.ts";
import { runProcess, type ProcessResult } from "../../src/shared/process.ts";

const mockLlmBaseUrl = "https://mock-llm.invalid/v1";
const mockGitignoreBaseUrl = "https://mock-gitignore.invalid";
const textDecoder = new TextDecoder();
let cliRunQueue: Promise<void> = Promise.resolve();

export interface CliOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly allowFailure?: boolean | undefined;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient> | undefined;
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
  readonly handler: MockHttpHandler;
}

export interface MockGitignoreServer {
  readonly baseUrl: string;
  readonly requests: Array<string>;
  readonly handler: MockHttpHandler;
}

export interface MockHttpRequest {
  readonly url: string;
  readonly body: HttpBody.HttpBody;
}

export type MockHttpHandler = (
  request: MockHttpRequest,
) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

const readRequestBody = (body: HttpBody.HttpBody): string => {
  switch (body._tag) {
    case "Uint8Array":
      return textDecoder.decode(body.body);
    case "Raw":
      if (typeof body.body === "string") {
        return body.body;
      }
      if (body.body instanceof Uint8Array) {
        return textDecoder.decode(body.body);
      }
      if (body.body instanceof ArrayBuffer) {
        return textDecoder.decode(new Uint8Array(body.body));
      }
      return "";
    default:
      return "";
  }
};

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
  const root = yield* createTempDir("ai-commit-git-");
  const dir = path.join(root, "repo");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* run("git", ["init"], dir);
  yield* run("git", ["config", "user.name", "Ai Commit Test"], dir);
  yield* run("git", ["config", "user.email", "ai-commit@example.com"], dir);
  return dir;
});

export const createJjRepo = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* createTempDir("ai-commit-jj-");
  const dir = path.join(root, "repo");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* run("jj", ["git", "init", "."], dir);
  yield* run("jj", ["config", "set", "--repo", "user.name", "Ai Commit Test"], dir);
  yield* run("jj", ["config", "set", "--repo", "user.email", "ai-commit@example.com"], dir);
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
  const env = {
    PWD: options.cwd,
    XDG_CONFIG_HOME: isolatedConfigHome,
    OPENAI_COMPACT_API_KEY: "",
    OPENAI_COMPACT_API_BASE_URL: "",
    OPENAI_COMPACT_MODEL: "",
    GIT_AGENT_BUILD_API_KEY: "",
    GIT_AGENT_BUILD_BASE_URL: "",
    GIT_AGENT_BUILD_MODEL: "",
    ...options.env,
  } satisfies Record<string, string | undefined>;

  return Effect.promise(async () => {
    const previousRun = cliRunQueue;
    let releaseQueue!: () => void;
    cliRunQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousRun;

    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalConsole = {
      debug: console.debug,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    const originalExitCode = process.exitCode;

    const captureWrite =
      (chunks: Array<string>) =>
      (
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        chunks.push(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
        if (typeof encoding === "function") {
          encoding();
        } else {
          callback?.();
        }
        return true;
      };

    const captureConsole =
      (chunks: Array<string>) =>
      (...items: ReadonlyArray<unknown>) => {
        chunks.push(`${items.map((item) => String(item)).join(" ")}\n`);
      };

    process.stdout.write = captureWrite(stdout) as typeof process.stdout.write;
    process.stderr.write = captureWrite(stderr) as typeof process.stderr.write;
    console.debug = captureConsole(stdout);
    console.info = captureConsole(stdout);
    console.log = captureConsole(stdout);
    console.warn = captureConsole(stderr);
    console.error = captureConsole(stderr);
    process.exitCode = 0;

    try {
      const exitCode = await Effect.runPromise(
        makeCliProgram(args, {
          env,
          platformLayer: makePlatformLayer(options.httpClientLayer),
        }),
      );

      const result = {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode,
      } satisfies ProcessResult;

      if (result.exitCode !== 0 && !(options.allowFailure ?? true)) {
        throw new Error(
          result.stderr || result.stdout || `CLI failed with exit code ${result.exitCode}`,
        );
      }

      return result;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.debug = originalConsole.debug;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      process.exitCode = originalExitCode;
      releaseQueue();
    }
  });
};

export const makeHttpClientLayer = (
  handler: (request: MockHttpRequest) => Response | Promise<Response>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.tryPromise({
        try: async () =>
          HttpClientResponse.fromWeb(
            request,
            await handler({ url: String(url), body: request.body }),
          ),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause,
              description: cause instanceof Error ? cause.message : "Mock HTTP request failed.",
            }),
          }),
      }),
    ),
  );

export const makeMockHttpClientLayer = (...handlers: ReadonlyArray<MockHttpHandler>) =>
  makeHttpClientLayer(async (request) => {
    for (const handler of handlers) {
      const response = await handler(request);
      if (response != null) {
        return response;
      }
    }

    return new Response(
      JSON.stringify({
        error: {
          message: `unexpected mock http request: ${request.url}`,
        },
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  });

export const startMockLlmServer = (responses: ReadonlyArray<MockLlmResponse>) =>
  Effect.sync(() => {
    const requests: Array<MockLlmRequest> = [];
    let index = 0;

    const handler: MockHttpHandler = async ({ url, body }) => {
      const requestUrl = new URL(url);
      if (
        requestUrl.origin !== "https://mock-llm.invalid" ||
        requestUrl.pathname !== "/v1/responses"
      ) {
        return undefined;
      }

      const rawBody = readRequestBody(body);
      const parsed = JSON.parse(rawBody) as {
        model?: string | undefined;
        input?: Array<{ role?: string | undefined; content?: unknown | undefined }> | undefined;
        tool_choice?: unknown | undefined;
        temperature?: number | null | undefined;
        top_p?: number | null | undefined;
      };
      const input = Array.isArray(parsed.input) ? parsed.input : [];
      const requestInfo = {
        path: `${requestUrl.pathname}${requestUrl.search}`,
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
        return new Response(JSON.stringify({ error: { message: "no mock response configured" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      const content = typeof next.content === "function" ? next.content(requestInfo) : next.content;
      const status = next.status ?? 200;
      const headers = {
        "content-type": "application/json",
        ...next.headers,
      };

      if (status !== 200) {
        return new Response(
          typeof content === "string"
            ? content
            : JSON.stringify(content ?? { error: { message: "mock llm error" } }),
          {
            status,
            headers,
          },
        );
      }

      const text = typeof content === "string" ? content : JSON.stringify(content);
      return new Response(
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
        {
          status,
          headers,
        },
      );
    };

    return {
      baseUrl: mockLlmBaseUrl,
      requests,
      remainingResponses: () => responses.length - index,
      handler,
    } satisfies MockLlmServer;
  });

export const startMockGitignoreServer = (templates: Record<string, string>) =>
  Effect.sync(() => {
    const requests: Array<string> = [];

    const handler: MockHttpHandler = ({ url }) => {
      const requestUrl = new URL(url);
      if (requestUrl.origin !== "https://mock-gitignore.invalid") {
        return undefined;
      }

      requests.push(`${requestUrl.pathname}${requestUrl.search}`);
      const key = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
      const template = templates[key];

      if (template == null) {
        return new Response("missing template", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      return new Response(template, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    return {
      baseUrl: mockGitignoreBaseUrl,
      requests,
      handler,
    } satisfies MockGitignoreServer;
  });

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
