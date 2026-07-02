import { normalizeGroups } from "./normalizeGroups";

describe("normalizeGroups", () => {
  it("wraps a single string in an array", () => {
    expect(normalizeGroups("engineering")).toEqual(["engineering"]);
  });

  it("does not split comma-delimited strings", () => {
    expect(normalizeGroups("a, b")).toEqual(["a, b"]);
  });

  it("passes through an array of strings", () => {
    expect(normalizeGroups(["beta", "alpha"])).toEqual(["alpha", "beta"]);
  });

  it("maps objects using id, then value, then name", () => {
    expect(
      normalizeGroups([
        { id: "g1", name: "Group One" },
        { value: "g2" },
        { name: "g3" },
      ])
    ).toEqual(["g1", "g2", "g3"]);
  });

  it("trims whitespace and drops empty values", () => {
    expect(normalizeGroups(["  alpha  ", "", "   ", "beta"])).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("deduplicates repeated groups", () => {
    expect(normalizeGroups(["alpha", "alpha", "beta"])).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("sorts groups for deterministic ordering", () => {
    expect(normalizeGroups(["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for missing or invalid values", () => {
    expect(normalizeGroups(undefined)).toEqual([]);
    expect(normalizeGroups(null)).toEqual([]);
    expect(normalizeGroups(42)).toEqual([]);
    expect(normalizeGroups({})).toEqual([]);
    expect(normalizeGroups([{ foo: "bar" }, 7, null])).toEqual([]);
  });
});
