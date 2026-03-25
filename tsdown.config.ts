import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  platform: "node",
  format: "esm",
  dts: false,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  ignoreWatch: [
    ".git",
    ".repo",
    ".direnv",
    ".lalph",
    ".codemogger",
    ".specs",
    ".jj",
    "dist",
    "node_modules",
    "bun.lock",
    "flake.lock",
  ],
  exports: { all: true },
});
