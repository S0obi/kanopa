import { beforeEach, describe, expect, it } from "vitest";
import { buildChanges, cells, diff, isChange, pendingEntries, pendingOf, sameValues, stage, summarize, toEntryChanges, useChanges, valueErrors, type PendingAttr } from "./changes";

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
        op: "modify",
        newRdn: "",
        dn: ada.dn,
        title: "Ada Lovelace",
        attributes: [
          { name: "title", kind: "text", before: ["Principal engineer"], after: ["Chief engineer"], password: "", add: [], remove: [] },
          { name: "userPassword", kind: "password", before: ["id1"], after: ["id1"], password: "s3cret", add: [], remove: [] },
        ],
      },
    ]);
    expect(diff(pw).map((r) => r.value).join()).not.toContain("s3cret");
    expect(JSON.stringify(toEntryChanges(set, { preview: true }))).not.toContain("s3cret");
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
    expect(valueErrors({ ...rules, singleValue: false }, ["a", "a "])).toEqual(["Type or value exists (20) — displayName lists “a” twice."]);
    expect(valueErrors({ ...rules, name: "manager", kind: "dn", singleValue: false }, ["grace"])).toEqual([
      "Invalid DN syntax (34) — manager needs a DN such as uid=…,ou=people,dc=example,dc=org.",
    ]);
    expect(valueErrors({ ...rules, name: "manager", kind: "dn", singleValue: false }, ["uid=grace,ou=people,dc=example,dc=org"])).toEqual([]);
    const dn = { ...rules, name: "manager", kind: "dn" as const, singleValue: false };
    for (const ok of [String.raw`cn=Doe\, John,ou=people,dc=example,dc=org`, String.raw`cn=a\+b+uid=x,dc=org`,"CN=Kanopa Reader,OU=Service Accounts,DC=corp,DC=example,DC=com", "2.5.4.3=x,dc=org"])
      expect({ dn: ok, errors: valueErrors(dn, [ok]) }).toEqual({ dn: ok, errors: [] });
    for (const bad of ["cn=,dc=org", "cn=a,,dc=org", "cn=trailing\\"]) expect({ dn: bad, errors: valueErrors(dn, [bad]).length }).toEqual({ dn: bad, errors: 1 });
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
    // Apply is under way with Ada's title when the person also adds a phone number.
    const sent = buildChanges(useChanges.getState().byConnection.prod).parts;
    useChanges.getState().stage("prod", ada, phone);
    useChanges.getState().applied("prod", sent);
    expect(useChanges.getState().byConnection.prod).toEqual({ "uid=ada,ou=people,dc=example,dc=org": { ...ada, attrs: [phone] } });
    useChanges.getState().stage("prod", ada, { ...phone, after: phone.before });
    // An attribute edited again while Apply ran is a new change and stays.
    useChanges.getState().stage("prod", ada, title(["Analyst"]));
    const again = buildChanges(useChanges.getState().byConnection.prod).parts;
    useChanges.getState().stage("prod", ada, title(["Fellow"]));
    useChanges.getState().applied("prod", again);
    expect(pendingOf(useChanges.getState().byConnection.prod, ada.dn, "title")?.after).toEqual(["Fellow"]);
    useChanges.getState().applied("prod", buildChanges(useChanges.getState().byConnection.prod).parts);
    useChanges.getState().discard("staging");
    expect(pendingEntries(useChanges.getState())).toBe(0);
  });
});

describe("long attributes (a group of 5,000 members)", () => {
  const members = Array.from({ length: 5000 }, (_, i) => `uid=arch${String(i).padStart(5, "0")},ou=archive,dc=example,dc=org`);
  const reversed = [...members].reverse();

  it("compares, diffs and checks thousands of values without comparing each with each", () => {
    const start = performance.now();
    expect(sameValues(members, reversed)).toBe(true);
    expect(sameValues(members, [...members.slice(1), "uid=other,dc=example,dc=org"])).toBe(false);
    const attr: PendingAttr = { name: "member", kind: "dn", before: members, after: [...members.slice(0, 4990), "uid=new,dc=example,dc=org"] };
    expect(isChange(attr)).toBe(true);
    const rows = diff(attr);
    expect(rows.filter((r) => r.sign === "−")).toHaveLength(10);
    expect(rows.filter((r) => r.sign === "+")).toHaveLength(1);
    expect(cells(members, attr).filter((c) => c.state === "removed")).toHaveLength(10);
    expect(valueErrors({ name: "member", kind: "dn", singleValue: false, baseDn: "dc=example,dc=org" }, members)).toEqual([]);
    // Each of these was a quarter of a billion comparisons once; together they take a few milliseconds.
    expect(performance.now() - start).toBeLessThan(600);
  });

  it("names a repeated value among thousands", () => {
    const withDup = [...members, members[1234]!];
    expect(valueErrors({ name: "member", kind: "dn", singleValue: false, baseDn: "dc=example,dc=org" }, withDup)[0]).toMatch(/Type or value exists \(20\)/);
  });
});
