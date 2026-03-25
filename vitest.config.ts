import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.repo/**",
      "**/.direnv/**",
      "**/.lalph/**",
      "**/.codemogger/**",
      "**/.specs/**",
      "**/.jj/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
  },
});
