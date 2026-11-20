import { describe, expect, it } from "vitest";
import { DEFAULT_META_API_BASE, getMetaApiBase } from "./graph-base";

describe("getMetaApiBase", () => {
  it("defaults to Meta's Graph API when the override is unset", () => {
    expect(getMetaApiBase({})).toBe(DEFAULT_META_API_BASE);
  });

  it("ignores a blank override", () => {
    expect(getMetaApiBase({ META_GRAPH_BASE_URL: "   " })).toBe(
      DEFAULT_META_API_BASE,
    );
  });

  it("uses the override and strips trailing slashes", () => {
    expect(
      getMetaApiBase({ META_GRAPH_BASE_URL: "https://sim.example.com/v21.0//" }),
    ).toBe("https://sim.example.com/v21.0");
  });
});
