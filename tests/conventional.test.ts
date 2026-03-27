import { describe, expect, it } from "vitest";
import { hasErrors, validateConventional } from "../src/services/conventional.ts";

describe("validateConventional", () => {
  it("accepts a valid conventional commit", () => {
    const result = validateConventional(
      "feat(auth): add login flow\n\n- add auth service\n- add login tests\n\nThis introduces a basic login flow.",
    );
    expect(hasErrors(result)).toBe(false);
  });

  it("rejects a missing body", () => {
    const result = validateConventional("feat: add login");
    expect(hasErrors(result)).toBe(true);
  });
});
