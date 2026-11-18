import { describe, expect, it } from "vitest";
import { PASSWORD_ALPHABET, PASSWORD_LENGTH, generatePassword } from "./password";

describe("generatePassword", () => {
  it("makes 20 characters with every kind, and none that is left out, over many runs", () => {
    for (let i = 0; i < 10_000; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(PASSWORD_LENGTH);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!#%*+\-=?@_]/);
      expect(p).not.toMatch(/[0O1lI'"`\\~^¨\s]/);
      for (const ch of p) expect(PASSWORD_ALPHABET).toContain(ch);
    }
  });

  it("has an alphabet of 67 characters", () => expect(new Set(PASSWORD_ALPHABET).size).toBe(67));

  it("does not repeat itself, and is not shaped by where the required characters were placed", () => {
    const seen = new Set<string>();
    const firstKinds = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const p = generatePassword();
      seen.add(p);
      firstKinds.add(/[A-Z]/.test(p[0]!) ? "upper" : /[a-z]/.test(p[0]!) ? "lower" : /[0-9]/.test(p[0]!) ? "digit" : "symbol");
    }
    expect(seen.size).toBe(2_000);
    expect(firstKinds.size).toBe(4); // the first position is not always the upper-case one
  });
});
