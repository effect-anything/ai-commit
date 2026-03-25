import { platform } from "node:os";
import { Effect, FileSystem, Path } from "effect";
import { ApiError } from "../shared/errors";
import { buildEnvironment } from "../config/env";
import { detectTechnologies, type ProviderConfig } from "./openai-client";
import type { VcsClient } from "./vcs";

const autoGenStart = "### git-agent auto-generated — DO NOT EDIT this block ###";
const legacyAutoGenStart = "### git-agent auto-generated - DO NOT EDIT this block ###";
const autoGenEnd = "### end git-agent ###";
const customSection = "### custom rules ###";

const runtimeOs = (): string => {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
};

const wrapGenerated = (content: string, technologies: ReadonlyArray<string>): string =>
  `${autoGenStart}\n# Technologies: ${technologies.join(", ")}\n${content.trimEnd()}\n${autoGenEnd}\n`;

const toptalTechs = (content: string): Array<string> => {
  for (const line of content.split("\n").slice(0, 10)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# Created by")) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const url = fields[fields.length - 1];
    if (url == null) {
      break;
    }
    const marker = "/api/";
    const index = url.lastIndexOf(marker);
    if (index !== -1) {
      return url
        .slice(index + marker.length)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    break;
  }
  return [];
};

const mergeGitignore = (existing: string, generated: string): string => {
  const userLines: Array<string> = [];
  let insideBlock = false;

  for (const line of existing.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === autoGenStart || trimmed === legacyAutoGenStart) {
      insideBlock = true;
      continue;
    }
    if (trimmed === autoGenEnd) {
      insideBlock = false;
      continue;
    }
    if (trimmed === customSection) {
      continue;
    }
    if (!insideBlock) {
      userLines.push(line);
    }
  }

  const covered = new Set(
    generated
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  const unique = userLines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith("#") || !covered.has(trimmed);
  });

  while (unique.length > 0 && unique[0]?.trim().length === 0) {
    unique.shift();
  }
  while (unique.length > 0 && unique[unique.length - 1]?.trim().length === 0) {
    unique.pop();
  }

  if (unique.length === 0) {
    return generated;
  }
  return `${generated.trimEnd()}\n\n${customSection}\n${unique.join("\n")}\n`;
};

const fetchGitignore = (technologies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const env = yield* buildEnvironment;
    const baseUrl = env.gitignoreBaseUrl.replace(/\/$/, "");
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          `${baseUrl}/${technologies.map((item) => encodeURIComponent(item)).join(",")}`,
        );
        const text = await response.text();
        if (!response.ok) {
          throw new ApiError({
            message: `failed to fetch gitignore template (${response.status})`,
            status: response.status,
            body: text,
          });
        }
        return text;
      },
      catch: (cause) =>
        cause instanceof ApiError
          ? cause
          : new ApiError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    });
  });

export const generateGitignore = (provider: ProviderConfig, vcs: VcsClient, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [dirs, files] = yield* Effect.all([vcs.topLevelDirs(cwd), vcs.projectFiles(cwd)]);
    let technologies = yield* detectTechnologies(provider, runtimeOs(), dirs, files);
    const fetched = yield* fetchGitignore(technologies);
    const actualTechnologies = toptalTechs(fetched);
    if (actualTechnologies.length > 0) {
      technologies = actualTechnologies;
    }

    const gitignorePath = path.join(cwd, ".gitignore");
    const existing = yield* fs.exists(gitignorePath).pipe(
      Effect.flatMap((exists) =>
        exists ? fs.readFileString(gitignorePath, "utf8") : Effect.succeed(""),
      ),
      Effect.mapError(
        (cause) =>
          new ApiError({
            message: `failed to write .gitignore: ${cause.message}`,
          }),
      ),
    );
    const generated = wrapGenerated(fetched, technologies);
    const content = existing.length === 0 ? generated : mergeGitignore(existing, generated);

    yield* fs.writeFileString(gitignorePath, content, { mode: 0o644 }).pipe(
      Effect.mapError(
        (cause) =>
          new ApiError({
            message: `failed to write .gitignore: ${cause.message}`,
          }),
      ),
    );
    return technologies;
  });
