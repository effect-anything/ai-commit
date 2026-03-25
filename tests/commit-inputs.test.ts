import { describe, expect, it } from "vitest";
import { parseTrailerText } from "../src/domain/commit";
import { countLines, parseCsvValues, wrapExplanation } from "../src/shared/text";

describe("repeatable commit inputs", () => {
  it("flattens repeated and comma-separated values", () => {
    expect(parseCsvValues(["alice", "bob, carol", "dave"])).toEqual([
      "alice",
      "bob",
      "carol",
      "dave",
    ]);
  });

  it("parses a valid trailer value", () => {
    expect(parseTrailerText("Reviewed-by: Ada Lovelace")).toEqual({
      key: "Reviewed-by",
      value: "Ada Lovelace",
    });
  });

  it("rejects trailer values without the required separator", () => {
    expect(parseTrailerText("Reviewed-by:Ada")).toBeUndefined();
    expect(parseTrailerText("Reviewed-by")).toBeUndefined();
  });

  it("counts lines correctly with and without a trailing newline", () => {
    expect(countLines("single line")).toBe(1);
    expect(countLines("first\nsecond")).toBe(2);
    expect(countLines("first\nsecond\n")).toBe(2);
  });

  it("wraps explanation lines once they exceed the requested width", () => {
    const wrapped = wrapExplanation("a".repeat(73), 72);

    expect(wrapped).toBe(`${"a".repeat(72)}\na`);
  });
});
