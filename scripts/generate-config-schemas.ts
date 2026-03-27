import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectConfigSchemaFileName,
  UserConfigSchemaFileName,
  projectConfigJsonSchema,
  userConfigJsonSchema,
} from "../src/config/file-schema.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const outputs = [
  [UserConfigSchemaFileName, userConfigJsonSchema()],
  [ProjectConfigSchemaFileName, projectConfigJsonSchema()],
] as const;

for (const [relativePath, content] of outputs) {
  const absolutePath = resolve(repoRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}
