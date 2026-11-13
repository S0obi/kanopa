import type { TreeNode } from "@/api/backend";
import type { Platform } from "@/lib/platform";
import { sameDn, splitDn } from "@/lib/dn";
import type { MenuItem } from "@/ui";
import type { Mark } from "./changes";

export type TreeAction = "copy" | "new" | "addMember" | "rename" | "delete";

export interface TreeMenuContext {
  /** The connection can write: not read-only, and connected. */
  canWrite: boolean;
  /** The base DN and the naming contexts: the roots, which are never renamed or deleted. */
  roots: string[];
  /** The entry's pending change, if any. */
  mark?: Mark;
  platform: Platform;
}

/** The shortcut each action has while the tree has focus. */
function shortcutOf(action: TreeAction, platform: Platform): string[] | undefined {
  switch (action) {
    case "copy":
      return ["mod", "c"];
    case "rename":
      return ["F2"];
    case "delete":
      return platform === "mac" ? ["mod", "backspace"] : ["delete"];
  }
  return undefined;
}

/** Why an action can't run on this entry; undefined when it can. */
export function blockedReason(action: TreeAction, n: TreeNode, ctx: TreeMenuContext): string | undefined {
  if (action === "copy") return undefined;
  if (ctx.mark === "new") return "Not created yet";
  if (ctx.mark === "deleted") return "Marked for deletion";
  if (!ctx.canWrite) return "Read-only";
  if (action === "new" || action === "addMember") return undefined;
  if (ctx.roots.some((r) => sameDn(r, n.dn))) return "Root entry";
  if (action === "rename") {
    if ((splitDn(n.dn)[0] ?? "").replace(/\\./g, "").includes("+")) return "Multi-valued RDN";
    if (n.hasChildren) return "Has children";
  }
  return undefined;
}

/** Whether the action is offered at all for this kind of entry. */
export function offered(action: TreeAction, n: TreeNode): boolean {
  if (action === "new") return n.type === "root" || n.type === "ou";
  if (action === "addMember") return n.type === "group";
  return true;
}

/**
 * The tree's right-click menu for an entry. Actions that don't fit the kind of entry are left
 * out; actions the rules forbid stay, disabled, with the reason.
 */
export function treeMenu(n: TreeNode, ctx: TreeMenuContext): MenuItem[] {
  const item = (id: TreeAction, label: string, icon: Extract<MenuItem, { id: string }>["icon"], danger?: boolean): MenuItem[] => {
    if (!offered(id, n)) return [];
    const reason = blockedReason(id, n, ctx);
    return [{ id, label, icon, danger, disabled: !!reason, hint: reason, shortcut: shortcutOf(id, ctx.platform) }];
  };
  return [
    ...item("copy", "Copy DN", "copy"),
    ...item("new", "New child entry…", "plus"),
    ...item("addMember", "Add member…", "users"),
    ...item("rename", "Rename…", "pencil"),
    { separator: true },
    ...item("delete", "Delete…", "trash", true),
  ];
}
