import { describe, expect, it } from "vitest";
import {
  addEntry, buildChanges, dropApplied, escapeRdnValue, markDelete, marks, membership, newChildren, renameEntry, renamedDn, summarize,
  undoDelete, undoRename, unescapeRdnValue, type ChangeSet,
} from "./changes";

const people = "ou=people,dc=example,dc=org";
const ada = { dn: `uid=ada,${people}`, title: "Ada Lovelace" };
const admins = { group: "cn=admins,ou=groups,dc=example,dc=org", title: "admins", attr: "member" };
const research = { group: "cn=research,ou=groups,dc=example,dc=org", title: "research", attr: "member" };

describe("RDN escaping", () => {
  it("mirrors Go's ldapx.EscapeRDNValue", () => {
    const cases: Record<string, string> = {
      "Ada Lovelace": "Ada Lovelace",
      "Doe, John": String.raw`Doe\, John`,
      "a+b": String.raw`a\+b`,
      'say "hi"': String.raw`say \"hi\"`,
      "back\\slash": String.raw`back\\slash`,
      " leading": String.raw`\ leading`,
      "trailing ": String.raw`trailing\ `,
      "#hash": String.raw`\#hash`,
      "mid#hash": "mid#hash",
      "a=b": "a=b",
    };
    for (const [v, want] of Object.entries(cases)) {
      expect({ v, got: escapeRdnValue(v) }).toEqual({ v, got: want });
      expect(unescapeRdnValue(escapeRdnValue(v))).toBe(v);
    }
    expect(renamedDn(String.raw`cn=Doe\, Jane,${people}`, "Doe, John")).toBe(String.raw`cn=Doe\, John,${people}`);
  });
});

describe("shaping the tree", () => {
  it("a rename swaps the DN in every group, and undo takes it all back", () => {
    let set: ChangeSet = renameEntry({}, ada, "ada.l", [admins, research]);
    const to = `uid=ada.l,${people}`;
    const member = (g: string) => set[g.toLowerCase()]?.attrs[0];
    expect(member(admins.group)).toMatchObject({ name: "member", add: [to], remove: [ada.dn] });
    expect(summarize(set)).toMatchObject({ count: 3, entries: 3 });
    expect(marks(set)[ada.dn.toLowerCase()]).toBe("renamed");
    // Renaming again replaces the first rename.
    set = renameEntry(set, ada, "ada.lovelace", [admins, research]);
    expect(member(admins.group)).toMatchObject({ add: [`uid=ada.lovelace,${people}`], remove: [ada.dn] });
    // Back to the current name: nothing left.
    expect(renameEntry(set, ada, "ada", [admins, research])).toEqual({});
    expect(undoRename(set, ada.dn)).toEqual({});
  });

  it("a delete removes the entry from its groups, and undo restores them", () => {
    let set: ChangeSet = membership({}, { dn: admins.group, title: "admins" }, "member", { add: `uid=grace,${people}` });
    set = markDelete(set, ada, [admins]);
    expect(set[admins.group.toLowerCase()].attrs[0]).toMatchObject({ add: [`uid=grace,${people}`], remove: [ada.dn] });
    expect(summarize(set).text).toBe("2 pending changes on 2 entries");
    set = undoDelete(set, ada.dn);
    // Grace's join, staged before, stays.
    expect(set[admins.group.toLowerCase()].attrs[0]).toMatchObject({ add: [`uid=grace,${people}`], remove: [] });
    expect(set[ada.dn.toLowerCase()]).toBeUndefined();
  });

  it("membership changes cancel each other out", () => {
    const g = { dn: admins.group, title: "admins" };
    let set = membership({}, g, "member", { add: ada.dn });
    set = membership(set, g, "member", { remove: ada.dn });
    expect(set).toEqual({});
    set = membership({}, g, "member", { remove: ada.dn });
    set = membership(set, g, "member", { add: ada.dn.toUpperCase() });
    expect(set).toEqual({});
  });

  it("new entries join the tree under their parent", () => {
    const set = addEntry({}, { dn: `uid=zoe,${people}`, title: "Zoe", type: "person", attrs: [] });
    expect(newChildren(set)[people.toLowerCase()]).toMatchObject([{ dn: `uid=zoe,${people}`, rdn: "uid=zoe", type: "person" }]);
    expect(summarize(set).text).toBe("Pending change: new entry uid=zoe");
  });

  it("builds Go's change set and drops what Apply took", () => {
    let set: ChangeSet = renameEntry({}, ada, "ada.l", [admins]);
    set = { ...set, [ada.dn.toLowerCase()]: { ...set[ada.dn.toLowerCase()], attrs: [{ name: "title", kind: "text", before: ["a"], after: ["b"] }] } };
    set = markDelete(set, { dn: `uid=old,${people}`, title: "Old" }, []);
    const { changes, parts } = buildChanges(set);
    expect(changes.map((c) => `${c.op} ${c.dn}${c.newRdn ? ` -> ${c.newRdn}` : ""}`)).toEqual([
      `modify ${admins.group}`,
      `rename ${ada.dn} -> ada.l`,
      `modify ${ada.dn}`,
      `delete uid=old,${people}`,
    ]);
    expect(changes[0].attributes?.[0]).toMatchObject({ before: [], after: [], add: [`uid=ada.l,${people}`], remove: [ada.dn] });
    // The rename and the group update went through; the title edit was refused.
    const left = dropApplied(set, [parts[0], parts[1], parts[3]]);
    expect(Object.keys(left)).toEqual([`uid=ada.l,${people}`]);
    expect(left[`uid=ada.l,${people}`]).toMatchObject({ dn: `uid=ada.l,${people}`, rename: undefined, attrs: [{ name: "title" }] });
  });
});
