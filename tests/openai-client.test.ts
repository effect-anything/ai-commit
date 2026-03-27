import { describe, expect, it } from "vitest";
import { isReasoningModel } from "../src/services/openai-client.ts";

describe("isReasoningModel", () => {
  it("accepts current reasoning model families", () => {
    expect(isReasoningModel("o1")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("codex-mini-latest")).toBe(true);
    expect(isReasoningModel("computer-use-preview")).toBe(true);
    expect(isReasoningModel("gpt-5")).toBe(true);
    expect(isReasoningModel("gpt-5-mini")).toBe(true);
  });

  it("rejects non-reasoning models", () => {
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    expect(isReasoningModel("gpt-5-chat-latest")).toBe(false);
    expect(isReasoningModel("claude-sonnet-4")).toBe(false);
  });

  it("handles provider-prefixed model ids", () => {
    expect(isReasoningModel("openai/gpt-5")).toBe(true);
    expect(isReasoningModel("openrouter/openai/o4-mini")).toBe(true);
    expect(isReasoningModel("openai/gpt-5-chat-latest")).toBe(false);
  });
});
