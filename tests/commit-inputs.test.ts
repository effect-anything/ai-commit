import { describe, expect, it } from "vitest";
import { parseTrailerText } from "../src/domain/commit";
import { parseCsvValues } from "../src/shared/text";

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
});
