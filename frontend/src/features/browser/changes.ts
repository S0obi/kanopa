import { create } from "zustand";
import type { EntryChange, EntryView } from "@/api/backend";
import { splitDn } from "@/lib/dn";
import { dnKey } from "./store";

/**
 * Pending changes: the UI holds them, Go stays stateless and receives the whole set on
 * Preview and Apply. They are kept per connection, across Reconnect, until applied or discarded.
 */

export type ValueKind = "text" | "dn" | "binary" | "password";

/** One attribute of one entry, as read and as the person wants it. */
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
}

export interface PendingEntry {
  dn: string;
  title: string;
  attrs: PendingAttr[];
}

/** Pending entries of one connection, by DN key, in the order they were first changed. */
export type ChangeSet = Record<string, PendingEntry>;

const lower = (s: string) => s.toLowerCase();

/** Values compared exactly, in any order. */
export function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v)) && b.every((v) => a.includes(v));
}

/** True when the attribute would change on the server. */
export function isChange(a: PendingAttr): boolean {
  return !!a.password || !sameValues(a.before, a.after);
}

/** Puts one attribute change into the set, replacing an earlier one; an edit back to the read values drops it. */
export function stage(set: ChangeSet, entry: Pick<EntryView, "dn" | "title">, attr: PendingAttr): ChangeSet {
  const k = dnKey(entry.dn);
  const current = set[k] ?? { dn: entry.dn, title: entry.title, attrs: [] };
  const attrs = current.attrs.filter((a) => lower(a.name) !== lower(attr.name));
  if (isChange(attr)) attrs.push(attr);
  const next = { ...set };
  if (attrs.length) next[k] = { ...current, attrs };
  else delete next[k];
  return next;
}

/** The pending change of one attribute, if any. */
export function pendingOf(set: ChangeSet | undefined, dn: string, name: string): PendingAttr | undefined {
  return set?.[dnKey(dn)]?.attrs.find((a) => lower(a.name) === lower(name));
}

/** What Preview and Apply receive. */
export function toEntryChanges(set: ChangeSet): EntryChange[] {
  return Object.values(set).map((e) => ({
    dn: e.dn,
    title: e.title,
    attributes: e.attrs.map((a) => ({ name: a.name, kind: a.kind, before: a.before, after: a.after, password: a.password ?? "" })),
  }));
}

export interface Summary {
  count: number; // attribute changes
  entries: number;
  text: string;
}

const rdnOf = (dn: string) => splitDn(dn)[0] ?? dn;

/** "Pending change: title on uid=ada" or "3 pending changes on 2 entries". */
export function summarize(set: ChangeSet | undefined): Summary {
  const entries = Object.values(set ?? {});
  const count = entries.reduce((n, e) => n + e.attrs.length, 0);
  if (count === 1) return { count, entries: 1, text: `Pending change: ${entries[0].attrs[0].name} on ${rdnOf(entries[0].dn)}` };
  return { count, entries: entries.length, text: `${count} pending changes on ${entries.length} ${entries.length === 1 ? "entry" : "entries"}` };
}

export interface DiffRow {
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
  for (const v of a.before) if (a.after.includes(v)) rows.push({ sign: " ", value: show(v) });
  for (const v of a.before) if (!a.after.includes(v)) rows.push({ sign: "−", value: show(v) });
  for (const v of a.after) if (!a.before.includes(v)) rows.push({ sign: "+", value: show(v) });
  return rows;
}

/** One value as the attributes table draws it. */
export interface Cell {
  value: string;
  state: "same" | "edited" | "added" | "removed";
  was?: string;
}

/** The cells of one attribute with its pending change applied: "was …" for a single edited value. */
export function cells(values: string[], pending: PendingAttr | undefined): Cell[] {
  if (!pending) return values.map((value) => ({ value, state: "same" }));
  const show = (v: string) => pending.shown?.[v] ?? v;
  if (pending.kind === "password" && pending.password)
    return [{ value: "New password (hidden)", state: "edited", was: pending.before.length ? "current password" : undefined }];
  const removed = pending.before.filter((v) => !pending.after.includes(v));
  const added = pending.after.filter((v) => !pending.before.includes(v));
  const kept = pending.after.filter((v) => pending.before.includes(v));
  if (removed.length === 1 && added.length === 1 && kept.length === 0) return [{ value: added[0], state: "edited", was: removed[0] }];
  return [
    ...kept.map((v): Cell => ({ value: show(v), state: "same" })),
    ...added.map((v): Cell => ({ value: v, state: "added" })),
    ...removed.map((v): Cell => ({ value: show(v), state: "removed" })),
  ];
}

export interface EditorRules {
  name: string;
  kind: ValueKind;
  singleValue: boolean;
  baseDn: string;
}

const DN_SYNTAX = /^\s*[A-Za-z][A-Za-z0-9-]*\s*=\s*[^,]+(\s*,\s*[A-Za-z][A-Za-z0-9-]*\s*=\s*[^,]+)*\s*$/;

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
  for (const [i, v] of vals.entries())
    if (vals.indexOf(v) !== i) {
      out.push(`Attribute or value exists (20) — ${r.name} lists “${v}” twice.`);
      break;
    }
  return out;
}

/* ---------- store ---------- */

interface ChangesState {
  byConnection: Record<string, ChangeSet>;
  stage(connectionId: string, entry: Pick<EntryView, "dn" | "title">, attr: PendingAttr): void;
  /** Drops every pending change of the connection. */
  discard(connectionId: string): void;
  /** Drops the changes of the entries that were applied. */
  applied(connectionId: string, dns: string[]): void;
}

export const useChanges = create<ChangesState>((set) => ({
  byConnection: {},
  stage: (id, entry, attr) => set((s) => ({ byConnection: { ...s.byConnection, [id]: stage(s.byConnection[id] ?? {}, entry, attr) } })),
  discard: (id) =>
    set((s) => {
      const next = { ...s.byConnection };
      delete next[id];
      return { byConnection: next };
    }),
  applied: (id, dns) =>
    set((s) => {
      const cs = { ...(s.byConnection[id] ?? {}) };
      for (const dn of dns) delete cs[dnKey(dn)];
      return { byConnection: { ...s.byConnection, [id]: cs } };
    }),
}));

/** Pending entries across every connection, for the window-close guard. */
export function pendingEntries(s: Pick<ChangesState, "byConnection">): number {
  return Object.values(s.byConnection).reduce((n, cs) => n + Object.keys(cs).length, 0);
}
