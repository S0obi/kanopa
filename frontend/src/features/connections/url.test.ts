import { describe, expect, it } from "vitest";
import { parseLdapUrl, securityForUrl, urlForSecurity } from "./url";

describe("parseLdapUrl", () => {
  it.each([
    ["ldaps://ldap.example.org:636", { scheme: "ldaps", host: "ldap.example.org", port: 636 }],
    ["ldap://localhost", { scheme: "ldap", host: "localhost", port: undefined }],
    ["LDAPS://Host.example.org/", { scheme: "ldaps", host: "Host.example.org", port: undefined }],
    ["  ldap://127.0.0.1:10389 ", { scheme: "ldap", host: "127.0.0.1", port: 10389 }],
  ])("reads %s", (raw, want) => {
    expect(parseLdapUrl(raw)).toEqual(want);
  });

  it.each(["", "ldap.example.org", "http://ldap.example.org", "ldap://", "ldap://host:0", "ldap://host:70000", "ldap://host/dc=x"])(
    "refuses %j",
    (raw) => expect(parseLdapUrl(raw)).toBeNull(),
  );
});

describe("securityForUrl", () => {
  it("ldaps:// always means LDAPS", () => expect(securityForUrl("ldaps://h", "none")).toBe("ldaps"));
  it("ldap:// turns LDAPS into StartTLS", () => expect(securityForUrl("ldap://h", "ldaps")).toBe("starttls"));
  it("ldap:// keeps None", () => expect(securityForUrl("ldap://h", "none")).toBe("none"));
  it("keeps the choice while the URL is incomplete", () => expect(securityForUrl("ldap:/", "ldaps")).toBe("ldaps"));
});

describe("urlForSecurity", () => {
  it("LDAPS → StartTLS rewrites scheme and default port", () =>
    expect(urlForSecurity("ldaps://localhost:636", "starttls")).toBe("ldap://localhost:389"));
  it("None → LDAPS swaps 389 for 636", () => expect(urlForSecurity("ldap://localhost", "ldaps")).toBe("ldaps://localhost:636"));
  it("keeps a custom port", () => expect(urlForSecurity("ldap://localhost:10389", "ldaps")).toBe("ldaps://localhost:10389"));
  it("leaves an unparseable URL alone", () => expect(urlForSecurity("localhost", "ldaps")).toBe("localhost"));
});
