import { describe, expect, it } from "vitest";
import { formatLastUsed, plural } from "./time";

const now = new Date(2026, 10, 6, 15, 0);
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();

describe("formatLastUsed", () => {
  it.each([
    ["", "Never"],
    [at(2026, 10, 6, 9, 12), "Today, 09:12"],
    [at(2026, 10, 5, 14, 3), "Yesterday, 14:03"],
    [at(2026, 9, 28, 11, 22), "28 Oct, 11:22"],
    [at(2025, 9, 28, 11, 22), "28 Oct 2025"],
  ])("%s → %s", (iso, want) => expect(formatLastUsed(iso, now)).toBe(want));
});

describe("plural", () => {
  it("uses exact counts with separators", () => {
    expect(plural(1, "saved connection")).toBe("1 saved connection");
    expect(plural(1284, "entry", "entries")).toBe("1,284 entries");
  });
});
