import { describe, expect, it } from "vitest";
import { defaultScopeForKey, normalizeValue, resolveKey } from "../src/config/keys";

describe("config keys", () => {
  it("normalizes kebab-case aliases", () => {
    expect(resolveKey("api-key")).toBe("api_key");
    expect(resolveKey("max-diff-lines")).toBe("max_diff_lines");
  });

  it("defaults provider keys to user scope", () => {
    expect(defaultScopeForKey("api_key")).toBe("user");
    expect(defaultScopeForKey("hook")).toBe("project");
  });

  it("normalizes slice values", () => {
    expect(normalizeValue("hook", "conventional, empty")).toBe("conventional,empty");
  });
});
