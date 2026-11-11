import { describe, expect, it } from "vitest";
import { passwordErrors, passwordHint } from "./editors";

describe("passwords typed twice", () => {
  it("needs the same password in both fields", () => {
    expect(passwordErrors("s3cret", "s3cret", true)).toEqual([]);
    expect(passwordErrors("s3cret", "s3cre", true)).toEqual(["The passwords don't match. Type the same password in both fields."]);
    expect(passwordErrors("s3cret", "", false)).toHaveLength(1);
  });
  it("is required only where a password must be set", () => {
    expect(passwordErrors("", "", true)).toEqual(["Constraint violation (19) — enter a password, or cancel to keep the current one."]);
    expect(passwordErrors("", "", false)).toEqual([]);
  });
  it("says the server hashes it", () => {
    expect(passwordHint("LDAPS")).toBe("Sent over LDAPS. The server hashes it with its own scheme and never shows it again.");
    expect(passwordHint("an unencrypted link")).toBe("The server hashes it with its own scheme and never shows it again.");
  });
});
