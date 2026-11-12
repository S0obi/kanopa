import { describe, expect, it } from "vitest";
import { countText, highlight, searchable, wordsOf } from "./quick";

describe("marking what was typed", () => {
  it("marks every place a word appears, ignoring case", () => {
    expect(highlight("Ada Lovelace", ["ada"])).toEqual([
      { text: "Ada", hit: true },
      { text: " Lovelace", hit: false },
    ]);
    expect(highlight("Canada Adams", ["ada"])).toEqual([
      { text: "Can", hit: false },
      { text: "ada", hit: true },
      { text: " ", hit: false },
      { text: "Ada", hit: true },
      { text: "ms", hit: false },
    ]);
    expect(highlight("Ada Lovelace", ["ada", "lov"]).filter((s) => s.hit).map((s) => s.text)).toEqual(["Ada", "Lov"]);
  });

  it("leaves a name alone when nothing matches, and treats the words as text, not patterns", () => {
    expect(highlight("Ada", ["zzz"])).toEqual([{ text: "Ada", hit: false }]);
    expect(highlight("Ada", [])).toEqual([{ text: "Ada", hit: false }]);
    expect(highlight("a.b (c)", ["."])).toEqual([
      { text: "a", hit: false },
      { text: ".", hit: true },
      { text: "b (c)", hit: false },
    ]);
  });
});

describe("what the field sends", () => {
  it("needs a word of two characters, or the start of a filter", () => {
    expect(searchable("")).toBe(false);
    expect(searchable(" a ")).toBe(false);
    expect(searchable("a b c")).toBe(false);
    expect(searchable("ada l")).toBe(true);
    expect(searchable("ad")).toBe(true);
    expect(searchable("(")).toBe(true);
    expect(searchable("Zö")).toBe(true);
  });

  it("splits words on any space", () => {
    expect(wordsOf("  ada   lov ")).toEqual(["ada", "lov"]);
    expect(wordsOf("")).toEqual([]);
  });

  it("says how many are shown of how many", () => {
    expect(countText({ total: 3, more: false, hits: [1, 2, 3] as never })).toBe("3");
    expect(countText({ total: 83, more: false, hits: new Array(10) as never })).toBe("10 of 83");
    expect(countText({ total: 200, more: true, hits: new Array(10) as never })).toBe("10 of 200+");
    expect(countText({ total: 1200, more: true, hits: new Array(10) as never })).toBe("10 of 1,200+");
  });
});
