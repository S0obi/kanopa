import { create } from "zustand";
import type { EntryAttribute, EntryChange, EntryView, TreeNode } from "@/api/backend";
import { parentDn, rdnParts, splitDn } from "@/lib/dn";
import { dnKey } from "./store";

/**
 * Pending changes: the UI holds them, Go stays stateless and receives the whole set on
 * Preview and Apply (it orders them: renames, adds, modifies, deletes). They are kept per
 * connection, across Reconnect, until applied or discarded.
 */

export type ValueKind = "text" | "dn" | "binary" | "password";

/**
 * One attribute of one entry, as read and as the person wants it. Either a whole new set of
 * values (before → after), or values to add and remove (membership): add / remove.
 */
export interface PendingAttr {
  name: string;
  kind: ValueKind;
  /** Values as read: the values themselves, or the ids of binary and password values. */
  before: string[];
  /** Wanted values (ids for binary and password); empty removes the attribute. */
  after: string[];
  /** Binary and password values as the entry view described them, by id. */
  shown?: Record<string, string>;
  /** A new password; never shown. */
  password?: string;
  /** Membership: values to add and to remove, whatever else the attribute holds. */
  add?: string[];
  remove?: string[];
}

/** A group update that came with a rename or a delete, and goes when that is undone. */
export interface Link {
  group: string;
  title: string;
  attr: string; // member or uniqueMember
}

export interface PendingEntry {
  /** The entry's DN on the server (for a new entry, the DN it will have). */
  dn: string;
  title: string;
  /** add: not on the server yet. delete: marked for deletion. Otherwise it is modified. */
  op?: "add" | "delete";
  /** A new entry's tile type. */
  type?: string;
  /** Rename: the new value of the naming attribute, as typed. */
  rename?: string;
  /** Group updates the rename or delete added. */
  links?: Link[];
  attrs: PendingAttr[];
}

/** Pending entries of one connection, by DN key, in the order they were first changed. */
export type ChangeSet = Record<string, PendingEntry>;

const lower = (s: string) => s.toLowerCase();
const rdnOf = (dn: string) => splitDn(dn)[0] ?? dn;

/** Values compared exactly, in any order. */
export function sameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // Sets: a group's member attribute holds thousands of values, and includes() on each would be quadratic.
  const inA = new Set(a);
  const inB = new Set(b);
  return a.every((v) => inB.has(v)) && b.every((v) => inA.has(v));
}

export const isDelta = (a: PendingAttr) => a.add !== undefined || a.remove !== undefined;

/** True when the attribute would change on the server. */
export function isChange(a: PendingAttr): boolean {
  if (isDelta(a)) return (a.add?.length ?? 0) + (a.remove?.length ?? 0) > 0;
  return !!a.password || !sameValues(a.before, a.after);
}

/** An entry with nothing left to do drops out of the set. */
const keep = (e: PendingEntry) => !!e.op || e.rename !== undefined || e.attrs.length > 0;

function put(set: ChangeSet, e: PendingEntry): ChangeSet {
  const next = { ...set };
  if (keep(e)) next[dnKey(e.dn)] = e;
  else delete next[dnKey(e.dn)];
  return next;
}

/** Puts one attribute change into the set, replacing an earlier one; an edit back to the read values drops it. */
export function stage(set: ChangeSet, entry: Pick<EntryView, "dn" | "title">, attr: PendingAttr): ChangeSet {
  const current = set[dnKey(entry.dn)] ?? { dn: entry.dn, title: entry.title, attrs: [] };
  const attrs = current.attrs.filter((a) => lower(a.name) !== lower(attr.name));
  if (isChange(attr) || current.op === "add") attrs.push(attr);
  return put(set, { ...current, attrs });
}

/** The pending change of one attribute, if any. */
export function pendingOf(set: ChangeSet | undefined, dn: string, name: string): PendingAttr | undefined {
  return set?.[dnKey(dn)]?.attrs.find((a) => lower(a.name) === lower(name));
}

/* ---------- entries ---------- */

/** A new entry joins the set. */
export function addEntry(set: ChangeSet, e: Omit<PendingEntry, "op">): ChangeSet {
  return put(set, { ...e, op: "add" });
}

/** Undoes a new entry, or every change to an existing one. */
export function dropEntry(set: ChangeSet, dn: string): ChangeSet {
  const e = set[dnKey(dn)];
  let next = { ...set };
  delete next[dnKey(dn)];
  if (e?.links) next = unlink(next, e, e.links);
  return next;
}

/** Marks an entry for deletion; its other pending changes go. links remove it from those groups. */
export function markDelete(set: ChangeSet, entry: Pick<EntryView, "dn" | "title">, links: Link[]): ChangeSet {
  let next = dropEntry(set, entry.dn);
  for (const l of links) next = membership(next, { dn: l.group, title: l.title }, l.attr, { remove: entry.dn });
  return put(next, { dn: entry.dn, title: entry.title, op: "delete", links, attrs: [] });
}

export function undoDelete(set: ChangeSet, dn: string): ChangeSet {
  return dropEntry(set, dn);
}

/**
 * Renames an entry: its naming attribute takes value. links are the groups that list it; they
 * swap the old DN for the new one. Renaming back to the current value undoes the rename.
 */
export function renameEntry(set: ChangeSet, entry: Pick<EntryView, "dn" | "title">, value: string, links: Link[]): ChangeSet {
  let next = undoRename(set, entry.dn);
  const [, current] = rdnParts(rdnOf(entry.dn));
  if (value === unescapeRdnValue(current)) return next;
  const to = renamedDn(entry.dn, value);
  for (const l of links) {
    next = membership(next, { dn: l.group, title: l.title }, l.attr, { remove: entry.dn });
    next = membership(next, { dn: l.group, title: l.title }, l.attr, { add: to });
  }
  const e = next[dnKey(entry.dn)] ?? { dn: entry.dn, title: entry.title, attrs: [] };
  return put(next, { ...e, rename: value, links });
}

export function undoRename(set: ChangeSet, dn: string): ChangeSet {
  const e = set[dnKey(dn)];
  if (!e || e.rename === undefined) return set;
  const next = unlink(set, e, e.links ?? []);
  return put(next, { ...e, rename: undefined, links: undefined });
}

/** Takes back the group updates a rename or delete of e added. */
function unlink(set: ChangeSet, e: PendingEntry, links: Link[]): ChangeSet {
  let next = set;
  for (const l of links) {
    next = membership(next, { dn: l.group, title: l.title }, l.attr, { add: e.dn }, true);
    if (e.rename !== undefined) next = membership(next, { dn: l.group, title: l.title }, l.attr, { remove: renamedDn(e.dn, e.rename) }, true);
  }
  return next;
}

/** The DN an entry gets when its naming attribute takes value. */
export function renamedDn(dn: string, value: string): string {
  const [attr] = rdnParts(rdnOf(dn));
  const parent = parentDn(dn);
  return `${attr}${escapeRdnValue(value)}${parent ? `,${parent}` : ""}`;
}

/**
 * Adds or removes one value of a group's membership attribute. Adding a value that is pending
 * removal cancels the removal, and the other way round. undo only cancels, it never adds a new
 * change (used to take back a rename's or delete's group updates).
 */
export function membership(set: ChangeSet, group: { dn: string; title: string }, attr: string, change: { add?: string; remove?: string }, undo = false): ChangeSet {
  const g = set[dnKey(group.dn)] ?? { dn: group.dn, title: group.title, attrs: [] };
  const existing = g.attrs.find((a) => lower(a.name) === lower(attr));
  const same = (a: string, b: string) => dnKey(a) === dnKey(b);
  let a: PendingAttr = existing ?? { name: attr, kind: "dn", before: [], after: [], add: [], remove: [] };
  if (!isDelta(a)) {
    // The attribute was edited as a whole set: change that set.
    let after = a.after;
    if (change.add && !after.some((v) => same(v, change.add!))) after = undo ? after : [...after, change.add];
    if (change.remove) after = after.filter((v) => !same(v, change.remove!));
    a = { ...a, after };
  } else {
    let add = a.add ?? [];
    let remove = a.remove ?? [];
    if (change.add) {
      if (remove.some((v) => same(v, change.add!))) remove = remove.filter((v) => !same(v, change.add!));
      else if (!undo && !add.some((v) => same(v, change.add!))) add = [...add, change.add];
    }
    if (change.remove) {
      if (add.some((v) => same(v, change.remove!))) add = add.filter((v) => !same(v, change.remove!));
      else if (!undo && !remove.some((v) => same(v, change.remove!))) remove = [...remove, change.remove];
    }
    a = { ...a, add, remove };
  }
  const attrs = g.attrs.filter((x) => lower(x.name) !== lower(attr));
  if (isChange(a)) attrs.push(a);
  return put(set, { ...g, attrs });
}

/* ---------- escaping ---------- */

/** RFC 4514 escaping of an RDN value, as Go's ldapx.EscapeRDNValue. */
export function escapeRdnValue(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\0") {
      out += "\\00";
      continue;
    }
    if (`,+"\\<>;`.includes(c) || (i === 0 && (c === " " || c === "#")) || (i === v.length - 1 && c === " ")) out += "\\";
    out += c;
  }
  return out;
}

/** Reads an escaped RDN value back. */
export function unescapeRdnValue(v: string): string {
  return v.replace(/\\([0-9a-fA-F]{2}|.)/g, (_, x: string) => (x.length === 2 ? String.fromCharCode(parseInt(x, 16)) : x));
}

/* ---------- what Go receives ---------- */

/** A stand-in for a new password: Preview only needs to know one is set. */
const PASSWORD_SET = "(set)";

/** Which part of a pending entry a change carries, to drop it once applied. */
interface Part {
  key: string;
  part: "add" | "delete" | "rename" | "modify";
  attrs: PendingAttr[];
  /** rename: the value sent, which the person may change again while Apply runs. */
  rename?: string;
}

/**
 * What Preview and Apply receive, and which pending part each change is. For a preview the new
 * password is replaced by a stand-in, so the cleartext only ever crosses to Go to be applied.
 */
export function buildChanges(set: ChangeSet, opts: { preview?: boolean } = {}): { changes: EntryChange[]; parts: Part[] } {
  const pw = (a: PendingAttr) => (a.password ? (opts.preview ? PASSWORD_SET : a.password) : "");
  const attrOf = (a: PendingAttr) => ({
    name: a.name, kind: a.kind, before: isDelta(a) ? [] : a.before, after: isDelta(a) ? [] : a.after, password: pw(a), add: a.add ?? [], remove: a.remove ?? [],
  });
  const changes: EntryChange[] = [];
  const parts: Part[] = [];
  const push = (key: string, part: Part["part"], c: Partial<EntryChange> & { dn: string; title: string }, attrs: PendingAttr[] = []) => {
    changes.push({ op: part, newRdn: "", attributes: [], ...c });
    parts.push({ key, part, attrs, rename: part === "rename" ? c.newRdn : undefined });
  };
  for (const [key, e] of Object.entries(set)) {
    if (e.op === "add") push(key, "add", { dn: e.dn, title: e.title, attributes: e.attrs.map(attrOf) }, e.attrs);
    else if (e.op === "delete") push(key, "delete", { dn: e.dn, title: e.title });
    else {
      if (e.rename !== undefined) push(key, "rename", { dn: e.dn, title: e.title, newRdn: e.rename });
      if (e.attrs.length) push(key, "modify", { dn: e.dn, title: e.title, attributes: e.attrs.map(attrOf) }, e.attrs);
    }
  }
  return { changes, parts };
}

export function toEntryChanges(set: ChangeSet, opts: { preview?: boolean } = {}): EntryChange[] {
  return buildChanges(set, opts).changes;
}

/** Drops the parts Apply took. A rename moves what is left of the entry to its new DN. */
export function dropApplied(set: ChangeSet, done: Part[]): ChangeSet {
  let next = { ...set };
  for (const p of done) {
    const e = next[p.key];
    if (!e) continue;
    if (p.part === "add" || p.part === "delete") {
      // An attribute staged on a new entry while Apply ran stays as a change to it.
      const left = p.part === "add" ? e.attrs.filter((a) => !p.attrs.includes(a)) : [];
      delete next[p.key];
      if (left.length) next = put(next, { dn: e.dn, title: e.title, attrs: left.filter(isChange) });
      continue;
    }
    if (p.part === "modify") {
      next = put(next, { ...e, attrs: e.attrs.filter((a) => !p.attrs.includes(a)) });
      continue;
    }
    // rename: the server now has the entry at the DN the sent value gives.
    const to = renamedDn(e.dn, p.rename ?? e.rename ?? "");
    delete next[p.key];
    // Renamed again while Apply ran: that rename stays, from the new DN.
    const again = e.rename !== undefined && e.rename !== p.rename && e.rename !== unescapeRdnValue(rdnParts(rdnOf(to))[1]) ? e.rename : undefined;
    next = put(next, { ...e, dn: to, rename: again, links: undefined });
    next = followRename(next, e.dn, to);
  }
  return next;
}

/** Pending DN values that name from now name to: the server renamed the entry. */
function followRename(set: ChangeSet, from: string, to: string): ChangeSet {
  const same = (v: string) => dnKey(v) === dnKey(from);
  const swap = (vals: string[] | undefined) => (vals?.some(same) ? vals.map((v) => (same(v) ? to : v)) : vals);
  const next: ChangeSet = {};
  for (const [k, e] of Object.entries(set)) {
    const attrs = e.attrs.map((a) => (a.kind === "dn" ? { ...a, after: swap(a.after) ?? [], add: swap(a.add) } : a));
    next[k] = attrs.some((a, i) => a !== e.attrs[i]) ? { ...e, attrs } : e;
  }
  return next;
}

/* ---------- summary ---------- */

interface Summary {
  count: number; // changes: an add, a delete, a rename, or one attribute
  entries: number;
  text: string;
}

function countOf(e: PendingEntry): number {
  return (e.op ? 1 : 0) + (e.rename !== undefined ? 1 : 0) + (e.op ? 0 : e.attrs.length);
}

/** "Pending change: title on uid=ada" or "3 pending changes on 2 entries". */
export function summarize(set: ChangeSet | undefined): Summary {
  const entries = Object.values(set ?? {});
  const count = entries.reduce((n, e) => n + countOf(e), 0);
  if (count === 1) {
    const e = entries.find((x) => countOf(x) === 1)!;
    return { count, entries: 1, text: `Pending change: ${describe(e)}` };
  }
  return { count, entries: entries.length, text: `${count} pending changes on ${entries.length} ${entries.length === 1 ? "entry" : "entries"}` };
}

function describe(e: PendingEntry): string {
  if (e.op === "add") return `new entry ${rdnOf(e.dn)}`;
  if (e.op === "delete") return `delete ${rdnOf(e.dn)}`;
  if (e.rename !== undefined) return `rename ${rdnOf(e.dn)} to ${rdnOf(renamedDn(e.dn, e.rename))}`;
  return `${e.attrs[0].name} on ${rdnOf(e.dn)}`;
}

/* ---------- the tree and the entry view ---------- */

export type Mark = "new" | "deleted" | "renamed";

/** How the tree marks pending entries, by DN key. */
export function marks(set: ChangeSet | undefined): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const [k, e] of Object.entries(set ?? {})) {
    if (e.op === "add") out[k] = "new";
    else if (e.op === "delete") out[k] = "deleted";
    else if (e.rename !== undefined) out[k] = "renamed";
  }
  return out;
}

/** New entries the tree shows below their parent, by the parent's DN key. */
export function newChildren(set: ChangeSet | undefined): Record<string, TreeNode[]> {
  const out: Record<string, TreeNode[]> = {};
  for (const e of Object.values(set ?? {})) {
    if (e.op !== "add") continue;
    const p = dnKey(parentDn(e.dn));
    (out[p] ??= []).push({ dn: e.dn, rdn: rdnOf(e.dn), type: e.type ?? "entry", sub: e.title, hasChildren: false, count: 0, referral: false });
  }
  return out;
}

/** A new entry shown as the entry view shows one from the server. */
export function pendingView(e: PendingEntry): EntryView {
  const oc = e.attrs.find((a) => lower(a.name) === "objectclass")?.after ?? [];
  const attributes: EntryAttribute[] = e.attrs
    .filter((a) => a.after.length || a.password)
    .map((a) => ({
      name: a.name, kind: a.kind, values: a.kind === "password" ? ["New password (hidden)"] : a.after, ids: [], operational: false, singleValue: false, required: false,
    }));
  return {
    dn: e.dn, title: e.title, subtitle: "", type: e.type ?? "entry", objectClasses: oc, attributes, allowed: [], ldif: "", referral: false, elapsedMs: 0, failure: null,
  };
}

/* ---------- values ---------- */

interface DiffRow {
  sign: " " | "+" | "−";
  value: string;
}

/** "Change against the server": kept values, then removed, then added. */
export function diff(a: PendingAttr): DiffRow[] {
  const show = (v: string) => a.shown?.[v] ?? v;
  const rows: DiffRow[] = [];
  if (a.kind === "password" && a.password) {
    if (a.before.length) rows.push({ sign: "−", value: "current password (hidden)" });
    rows.push({ sign: "+", value: "new password (hidden)" });
    return rows;
  }
  // Sets: an attribute can hold thousands of values (a group's members), and includes() on each would be quadratic.
  const before = new Set(a.before);
  const after = new Set(a.after);
  for (const v of a.before) if (after.has(v)) rows.push({ sign: " ", value: show(v) });
  for (const v of a.before) if (!after.has(v)) rows.push({ sign: "−", value: show(v) });
  for (const v of a.after) if (!before.has(v)) rows.push({ sign: "+", value: show(v) });
  return rows;
}

/** One value as the attributes table draws it. */
interface Cell {
  value: string;
  state: "same" | "edited" | "added" | "removed";
  was?: string;
}

/** The cells of one attribute with its pending change applied: "was …" for a single edited value. */
export function cells(values: string[], pending: PendingAttr | undefined): Cell[] {
  if (!pending) return values.map((value) => ({ value, state: "same" }));
  if (isDelta(pending)) {
    const removing = new Set((pending.remove ?? []).map(dnKey));
    const gone = (v: string) => removing.has(dnKey(v));
    return [
      ...values.filter((v) => !gone(v)).map((value): Cell => ({ value, state: "same" })),
      ...(pending.add ?? []).map((value): Cell => ({ value, state: "added" })),
      ...values.filter(gone).map((value): Cell => ({ value, state: "removed" })),
    ];
  }
  const show = (v: string) => pending.shown?.[v] ?? v;
  if (pending.kind === "password" && pending.password)
    return [{ value: "New password (hidden)", state: "edited", was: pending.before.length ? "current password" : undefined }];
  const was = new Set(pending.before);
  const now = new Set(pending.after);
  const removed = pending.before.filter((v) => !now.has(v));
  const added = pending.after.filter((v) => !was.has(v));
  const kept = pending.after.filter((v) => was.has(v));
  if (removed.length === 1 && added.length === 1 && kept.length === 0) return [{ value: added[0], state: "edited", was: removed[0] }];
  return [
    ...kept.map((v): Cell => ({ value: show(v), state: "same" })),
    ...added.map((v): Cell => ({ value: v, state: "added" })),
    ...removed.map((v): Cell => ({ value: show(v), state: "removed" })),
  ];
}

/** The values an attribute will hold once its pending change applies. */
export function valuesAfter(values: string[], pending: PendingAttr | undefined): string[] {
  return cells(values, pending)
    .filter((c) => c.state !== "removed")
    .map((c) => c.value);
}

interface EditorRules {
  name: string;
  kind: ValueKind;
  singleValue: boolean;
  baseDn: string;
}

// attr=value pairs separated by commas (RFC 4514); a value may hold escaped characters such as "\,".
const RDN_PART = String.raw`\s*(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)\s*=\s*(?:\\.|[^,+\\])+`;
const DN_SYNTAX = new RegExp(String.raw`^${RDN_PART}(?:\+${RDN_PART})*(?:,${RDN_PART}(?:\+${RDN_PART})*)*\s*$`);

export const isDnSyntax = (v: string) => DN_SYNTAX.test(v);

/** The values the editor would stage: trimmed, blanks dropped. */
export function cleanValues(values: string[]): string[] {
  return values.map((v) => v.trim()).filter(Boolean);
}

/** Problems the server would refuse, worded like its answer. Empty when the values can be staged. */
export function valueErrors(r: EditorRules, values: string[]): string[] {
  const vals = cleanValues(values);
  const out: string[] = [];
  if (r.singleValue && vals.length > 1) out.push(`Constraint violation (19) — ${r.name} holds a single value.`);
  if (r.kind === "dn")
    for (const v of vals)
      if (!DN_SYNTAX.test(v)) {
        out.push(`Invalid DN syntax (34) — ${r.name} needs a DN such as uid=…,ou=people,${r.baseDn || "dc=example,dc=org"}.`);
        break;
      }
  const seen = new Set<string>();
  for (const v of vals) {
    if (seen.has(v)) {
      out.push(`Type or value exists (20) — ${r.name} lists “${v}” twice.`);
      break;
    }
    seen.add(v);
  }
  return out;
}

/* ---------- store ---------- */

type Change = (set: ChangeSet) => ChangeSet;

interface ChangesState {
  byConnection: Record<string, ChangeSet>;
  stage(connectionId: string, entry: Pick<EntryView, "dn" | "title">, attr: PendingAttr): void;
  /** Applies any change-set operation (addEntry, markDelete, renameEntry, membership…). */
  update(connectionId: string, f: Change): void;
  /** Drops every pending change of the connection. */
  discard(connectionId: string): void;
  /** Drops the parts Apply took. Anything staged while Apply ran stays. */
  applied(connectionId: string, done: Part[]): void;
}

export const useChanges = create<ChangesState>((set) => ({
  byConnection: {},
  stage: (id, entry, attr) => set((s) => ({ byConnection: { ...s.byConnection, [id]: stage(s.byConnection[id] ?? {}, entry, attr) } })),
  update: (id, f) => set((s) => ({ byConnection: { ...s.byConnection, [id]: f(s.byConnection[id] ?? {}) } })),
  discard: (id) =>
    set((s) => {
      const next = { ...s.byConnection };
      delete next[id];
      return { byConnection: next };
    }),
  applied: (id, done) => set((s) => ({ byConnection: { ...s.byConnection, [id]: dropApplied(s.byConnection[id] ?? {}, done) } })),
}));

/** Pending entries across every connection, for the window-close guard. */
export function pendingEntries(s: Pick<ChangesState, "byConnection">): number {
  return Object.values(s.byConnection).reduce((n, cs) => n + Object.keys(cs).length, 0);
}
