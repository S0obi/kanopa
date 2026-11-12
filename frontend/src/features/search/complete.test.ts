import { describe, expect, it } from "vitest";
import { accept, parseAttributes, suggest, tokenAt } from "./complete";

const names = ["cn", "description", "displayName", "departmentNumber", "mail", "member", "memberOf", "uid"];

describe("completing attribute names", () => {
  it("finds the name right after a ( in a filter, and nothing inside a value", () => {
    expect(tokenAt("(&(me", 5, "filter")).toEqual({ text: "me", start: 3, end: 5 });
    expect(tokenAt("(uid=ada)", 3, "filter")).toEqual({ text: "ui", start: 1, end: 4 });
    expect(tokenAt("(uid=ad", 7, "filter")).toBeNull();
    expect(tokenAt("(uid=ada)(", 10, "filter")).toBeNull();
    expect(tokenAt("uid", 3, "filter")).toBeNull();
  });

  it("finds the word being typed in a list", () => {
    expect(tokenAt("mail, di", 8, "list")).toEqual({ text: "di", start: 6, end: 8 });
    expect(tokenAt("mail", 4, "list")).toEqual({ text: "mail", start: 0, end: 4 });
    expect(tokenAt("mail,", 5, "list")).toBeNull();
  });

  it("suggests names by their start, shortest first", () => {
    expect(suggest(names, "me")).toEqual(["member", "memberOf"]);
    expect(suggest(names, "D")).toEqual(["description", "displayName", "departmentNumber"].sort((a, b) => a.length - b.length || a.localeCompare(b)));
    expect(suggest(names, "")).toEqual([]);
    expect(suggest(names, "zz")).toEqual([]);
  });

  it("accepts a name, adding = in a filter", () => {
    const f = "(&(me)(uid=x))";
    const t = tokenAt(f, 5, "filter")!;
    expect(accept(f, t, "member", "filter")).toEqual({ value: "(&(member=)(uid=x))", caret: 10 });
    const already = "(&(me=1))";
    expect(accept(already, tokenAt(already, 5, "filter")!, "member", "filter").value).toBe("(&(member=1))");
    const l = "mail, di";
    expect(accept(l, tokenAt(l, 8, "list")!, "displayName", "list")).toEqual({ value: "mail, displayName", caret: 17 });
  });

  it("reads the attribute list", () => {
    expect(parseAttributes(" mail, title  Mail ,, sn")).toEqual(["mail", "title", "sn"]);
    expect(parseAttributes("")).toEqual([]);
  });
});
