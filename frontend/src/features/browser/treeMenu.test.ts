import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/api/backend";
import { blockedReason, canHaveChildren, treeMenu, type TreeMenuContext } from "./treeMenu";

const node = (dn: string, type: string, hasChildren = false): TreeNode => ({ dn, rdn: dn.split(",")[0], type, sub: "", hasChildren, count: -1, referral: false });
const ctx = (patch: Partial<TreeMenuContext> = {}): TreeMenuContext => ({ canWrite: true, roots: ["dc=example,dc=org"], platform: "windows", ...patch });
const ids = (n: TreeNode, c = ctx()) => treeMenu(n, c).map((i) => ("id" in i ? i.id : "—"));
const item = (n: TreeNode, id: string, c = ctx()) => treeMenu(n, c).find((i) => "id" in i && i.id === id) as Extract<ReturnType<typeof treeMenu>[number], { id: string }>;

describe("the tree's menu", () => {
  it("offers New child only on containers and Add member only on groups", () => {
    expect(ids(node("ou=people,dc=example,dc=org", "ou", true))).toEqual(["copy", "new", "rename", "—", "delete"]);
    expect(ids(node("cn=admins,ou=groups,dc=example,dc=org", "group"))).toEqual(["copy", "addMember", "rename", "—", "delete"]);
    expect(ids(node("uid=ada,ou=people,dc=example,dc=org", "person"))).toEqual(["copy", "rename", "—", "delete"]);
  });

  it("keeps forbidden actions, disabled with the reason", () => {
    const root = node("DC=Example, dc=org", "root", true);
    expect(item(root, "rename")).toMatchObject({ disabled: true, hint: "Root entry" });
    expect(item(root, "delete")).toMatchObject({ disabled: true, hint: "Root entry" });
    expect(item(root, "new")).toMatchObject({ disabled: false });
    expect(item(node("ou=hosts,dc=example,dc=org", "ou", true), "rename")).toMatchObject({ disabled: true, hint: "Has children" });
    expect(item(node("ou=hosts,dc=example,dc=org", "ou", true), "delete")).toMatchObject({ disabled: false });
    expect(item(node("cn=a+sn=b,dc=example,dc=org", "person"), "rename")).toMatchObject({ hint: "Multi-valued RDN" });
  });

  it("leaves only Copy DN on pending new and deleted entries, and on a read-only connection", () => {
    const g = node("cn=x,ou=groups,dc=example,dc=org", "group");
    for (const [c, why] of [[ctx({ mark: "new" }), "Not created yet"], [ctx({ mark: "deleted" }), "Marked for deletion"], [ctx({ canWrite: false }), "Read-only"]] as const) {
      expect(item(g, "copy", c).disabled).toBe(false);
      for (const id of ["addMember", "rename", "delete"]) expect(item(g, id, c)).toMatchObject({ disabled: true, hint: why });
    }
    expect(blockedReason("copy", g, ctx({ canWrite: false }))).toBeUndefined();
  });

  it("shows the shortcuts the platform's way", () => {
    const p = node("uid=ada,ou=people,dc=example,dc=org", "person");
    expect(item(p, "copy").shortcut).toEqual(["mod", "c"]);
    expect(item(p, "rename").shortcut).toEqual(["F2"]);
    expect(item(p, "delete").shortcut).toEqual(["delete"]);
    expect(item(p, "delete", ctx({ platform: "mac" })).shortcut).toEqual(["mod", "backspace"]);
  });
});

describe("canHaveChildren", () => {
  const can = (type: string, hasChildren = false, referral = false) => canHaveChildren({ type, hasChildren, referral });

  it("takes the root, organizational units and other entries, such as an organizationalRole", () => {
    expect(can("root")).toBe(true);
    expect(can("ou")).toBe(true);
    expect(can("entry")).toBe(true);
  });

  it("takes a person, group or device only when it already has children", () => {
    for (const type of ["person", "group", "server"]) {
      expect(can(type)).toBe(false);
      expect(can(type, true)).toBe(true);
    }
  });

  it("never takes a referral", () => {
    expect(can("entry", false, true)).toBe(false);
    expect(can("ou", true, true)).toBe(false);
  });

  it("puts New child entry in the menu of an organizationalRole", () => {
    expect(treeMenu(node("cn=Group factory,dc=example,dc=org", "entry", true), ctx()).some((i) => "id" in i && i.id === "new")).toBe(true);
  });
});
