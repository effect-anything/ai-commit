import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  outDir: "dist",
  platform: "node",
  format: "esm",
  dts: false,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outputOptions: {
    comments: false,
  },
  minify: {
    codegen: { removeWhitespace: false },
    compress: true,
    mangle: true,
  },
  treeshake: true,
  target: ["node24", "esnext"],
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
});
