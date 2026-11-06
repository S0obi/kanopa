import { describe, expect, it } from "vitest";
import { lineage, parentDn, rdnParts, sameDn, splitDn } from "./dn";

describe("DN helpers", () => {
  it("split on commas that are not escaped", () => {
    const escaped = String.raw`cn=Lovelace\, Ada`; // the comma is part of the RDN value
    expect(splitDn(`${escaped},ou=people, dc=example,dc=org`)).toEqual([escaped, "ou=people", "dc=example", "dc=org"]);
    expect(splitDn("")).toEqual([]);
  });
  it("walk up and down the tree", () => {
    expect(parentDn("uid=ada,ou=people,dc=example,dc=org")).toBe("ou=people,dc=example,dc=org");
    expect(lineage("uid=ada,ou=people,dc=org")).toEqual(["dc=org", "ou=people,dc=org", "uid=ada,ou=people,dc=org"]);
  });
  it("compare case-insensitively, ignoring spaces after commas", () => {
    expect(sameDn("UID=ada, OU=People,dc=org", "uid=ada,ou=people,dc=org")).toBe(true);
    expect(sameDn("uid=ada,dc=org", "uid=alan,dc=org")).toBe(false);
  });
  it("split an RDN", () => {
    expect(rdnParts("uid=ada")).toEqual(["uid=", "ada"]);
    expect(rdnParts("plain")).toEqual(["", "plain"]);
  });
});
