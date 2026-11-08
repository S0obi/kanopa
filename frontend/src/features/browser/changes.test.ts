import { beforeEach, describe, expect, it } from "vitest";
import { cells, diff, pendingEntries, pendingOf, stage, summarize, toEntryChanges, useChanges, valueErrors, type PendingAttr } from "./changes";

const ada = { dn: "uid=ada,ou=people,dc=example,dc=org", title: "Ada Lovelace" };
const title = (after: string[]): PendingAttr => ({ name: "title", kind: "text", before: ["Principal engineer"], after });
const phone: PendingAttr = { name: "telephoneNumber", kind: "text", before: ["+41 1"], after: ["+41 1", "+41 2"] };

describe("change set", () => {
  it("stages, replaces and drops edits", () => {
    let set = stage({}, ada, title(["Chief engineer"]));
    set = stage(set, ada, phone);
    expect(summarize(set)).toEqual({ count: 2, entries: 1, text: "2 pending changes on 1 entry" });
    set = stage(set, ada, title(["Analyst"]));
    expect(pendingOf(set, "UID=ada, ou=people,dc=example,dc=org", "TITLE")?.after).toEqual(["Analyst"]);
    // Back to what the server holds: no change any more.
    set = stage(set, ada, title(["Principal engineer"]));
    expect(summarize(set).text).toBe("Pending change: telephoneNumber on uid=ada");
    set = stage(set, ada, { ...phone, after: ["+41 1"] });
    expect(set).toEqual({});
  });

  it("sends what Go expects, passwords included but never shown", () => {
    const pw: PendingAttr = { name: "userPassword", kind: "password", before: ["id1"], after: ["id1"], shown: { id1: "{SSHA} hashed" }, password: "s3cret" };
    const set = stage(stage({}, ada, title(["Chief engineer"])), ada, pw);
    expect(toEntryChanges(set)).toEqual([
      {
        dn: ada.dn,
        title: "Ada Lovelace",
        attributes: [
          { name: "title", kind: "text", before: ["Principal engineer"], after: ["Chief engineer"], password: "" },
          { name: "userPassword", kind: "password", before: ["id1"], after: ["id1"], password: "s3cret" },
        ],
      },
    ]);
    expect(diff(pw).map((r) => r.value).join()).not.toContain("s3cret");
  });

  it("diffs against the server", () => {
    expect(diff(phone)).toEqual([
      { sign: " ", value: "+41 1" },
      { sign: "+", value: "+41 2" },
    ]);
    const photo: PendingAttr = { name: "jpegPhoto", kind: "binary", before: ["a", "b"], after: ["b"], shown: { a: "JPEG image · 10 bytes", b: "PNG image · 4 bytes" } };
    expect(diff(photo)).toEqual([
      { sign: " ", value: "PNG image · 4 bytes" },
      { sign: "−", value: "JPEG image · 10 bytes" },
    ]);
  });

  it("draws one edited value as 'was …', others as added and removed", () => {
    expect(cells(["Principal engineer"], title(["Chief engineer"]))).toEqual([{ value: "Chief engineer", state: "edited", was: "Principal engineer" }]);
    expect(cells(["+41 1"], phone)).toEqual([
      { value: "+41 1", state: "same" },
      { value: "+41 2", state: "added" },
    ]);
    expect(cells(["Principal engineer"], title([]))).toEqual([{ value: "Principal engineer", state: "removed" }]);
  });
});

describe("value rules", () => {
  const rules = { name: "displayName", kind: "text" as const, singleValue: true, baseDn: "dc=example,dc=org" };
  it("follows the schema's single-value rule", () => {
    expect(valueErrors(rules, ["Ada", " "])).toEqual([]);
    expect(valueErrors(rules, ["Ada", "Lovelace"])).toEqual(["Constraint violation (19) — displayName holds a single value."]);
  });
  it("refuses duplicates and malformed DNs", () => {
    expect(valueErrors({ ...rules, singleValue: false }, ["a", "a "])).toEqual(["Attribute or value exists (20) — displayName lists “a” twice."]);
    expect(valueErrors({ ...rules, name: "manager", kind: "dn", singleValue: false }, ["grace"])).toEqual([
      "Invalid DN syntax (34) — manager needs a DN such as uid=…,ou=people,dc=example,dc=org.",
    ]);
    expect(valueErrors({ ...rules, name: "manager", kind: "dn", singleValue: false }, ["uid=grace,ou=people,dc=example,dc=org"])).toEqual([]);
  });
});

describe("store", () => {
  beforeEach(() => useChanges.setState({ byConnection: {} }));
  it("keeps changes per connection until applied or discarded", () => {
    const s = useChanges.getState();
    s.stage("prod", ada, title(["Chief engineer"]));
    s.stage("prod", { dn: "uid=alan,ou=people,dc=example,dc=org", title: "Alan Turing" }, title(["x"]));
    s.stage("staging", ada, phone);
    expect(pendingEntries(useChanges.getState())).toBe(3);
    useChanges.getState().applied("prod", [ada.dn]);
    expect(Object.keys(useChanges.getState().byConnection.prod)).toEqual(["uid=alan,ou=people,dc=example,dc=org"]);
    useChanges.getState().discard("staging");
    expect(pendingEntries(useChanges.getState())).toBe(1);
  });
});
