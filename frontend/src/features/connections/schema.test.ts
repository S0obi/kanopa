import { describe, expect, it } from "vitest";
import { advancedSummary, connectionFormSchema, emptyConnectionForm, toParams } from "./schema";

const valid = { ...emptyConnectionForm, url: "ldaps://ldap.example.org", bindDn: "cn=admin,dc=example,dc=org", password: "x" };

function messages(values: object) {
  const r = connectionFormSchema.safeParse(values);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
}

describe("connectionFormSchema", () => {
  it("accepts a complete form", () => expect(messages(valid)).toEqual({}));

  it("words every problem the way the design does", () => {
    expect(messages({ ...emptyConnectionForm })).toEqual({
      url: "Enter an LDAP URL such as ldaps://ldap.example.org:636.",
      bindDn: "Enter a bind DN, or choose Anonymous.",
    });
    expect(messages({ ...valid, bindDn: "admin" })).toEqual({
      bindDn: "Invalid DN syntax (34) — a bind DN looks like cn=admin,dc=example,dc=org.",
    });
    expect(messages({ ...valid, baseDn: "example.org" })).toEqual({
      baseDn: "Invalid DN syntax (34) — a base DN looks like dc=example,dc=org.",
    });
  });

  it("needs no bind DN for an anonymous bind", () => expect(messages({ ...valid, bind: "anonymous", bindDn: "" })).toEqual({}));

  it("checks the advanced numbers", () => {
    expect(messages({ ...valid, timeoutSeconds: 0 })).toEqual({ timeoutSeconds: "Use at least 1 second." });
    expect(messages({ ...valid, pageSize: Number.NaN }).pageSize).toBeDefined();
  });
});

describe("toParams", () => {
  it("drops credentials for an anonymous bind and trims", () => {
    expect(toParams({ ...valid, url: " ldap://h ", bind: "anonymous" })).toEqual({
      url: "ldap://h",
      security: "ldaps",
      bind: "anonymous",
      bindDn: "",
      password: "",
      timeoutSeconds: 10,
      verifyCert: true,
    });
  });
});

describe("advancedSummary", () => {
  it("summarises timeout, page size and referrals", () =>
    expect(advancedSummary({ timeoutSeconds: 10, pageSize: 1500, referrals: "ignore" })).toBe("timeout 10 s · page size 1,500 · referrals ignored"));
});
