import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useBackend, type ClassInfo, type EntryView, type RelatedEntry, type SessionInfo } from "@/api/backend";
import { hostOf } from "@/features/connections/url";
import { parentDn, rdnParts, sameDn, splitDn } from "@/lib/dn";
import { plural } from "@/lib/time";
import { useWindow } from "@/lib/useWindow";
import { Banner, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Select, Skeleton, TextField, TypeTile, cx } from "@/ui";
import {
  addEntry, cells, escapeRdnValue, isDelta, isDnSyntax, isUidAttr, markDelete, membership, renameEntry, renamedDn, unescapeRdnValue, useChanges, valuesAfter,
  type ChangeSet, type Link, type PendingAttr, type ValueKind,
} from "./changes";
import { PasswordPair, passwordErrors, passwordHint } from "./editors";
import { dnKey, useBrowser } from "./store";

/* ---------- shared lookups ---------- */

/** Groups that list dn (member / uniqueMember), or its uid (memberUid), as links a rename or delete updates. */
function useReferrers(id: string, dn: string, enabled = true) {
  const backend = useBackend();
  return useQuery({
    queryKey: ["referrers", id, dnKey(dn)],
    queryFn: () => backend.referrers(id, dn),
    enabled,
    staleTime: 10_000,
  });
}

const linksOf = (groups: RelatedEntry[]): Link[] =>
  groups.filter((g) => g.memberAttr && (!isUidAttr(g.memberAttr) || g.uid)).map((g) => ({ group: g.dn, title: g.name, attr: g.memberAttr, uid: g.uid || undefined }));

/** The RDN value of a DN, unescaped: "uid=ada,…" → "ada". */
const rdnValue = (dn: string) => unescapeRdnValue(rdnParts(splitDn(dn)[0] ?? "")[1]);
const rdnAttrOf = (dn: string) => rdnParts(splitDn(dn)[0] ?? "")[0].replace(/=$/, "");
const rdnOf = (dn: string) => splitDn(dn)[0] ?? dn;

/** True when the DN is taken by an entry the tree has read, or by a pending new entry. */
function useTaken(id: string) {
  const nodes = useBrowser((s) => s.nodes);
  const set = useChanges((s) => s.byConnection[id]);
  return (dn: string, except?: string) => {
    if (except && sameDn(dn, except)) return false;
    const k = dnKey(dn);
    const pending = set?.[k];
    if (pending?.op === "delete") return false;
    return !!nodes[k] || pending?.op === "add";
  };
}

/* ---------- Rename ---------- */

export function RenameDialog({ id, entry, onClose }: { id: string; entry: EntryView; onClose: () => void }) {
  const update = useChanges((s) => s.update);
  const pending = useChanges((s) => s.byConnection[id]?.[dnKey(entry.dn)]);
  const attr = rdnAttrOf(entry.dn);
  const current = rdnValue(entry.dn);
  const [value, setValue] = useState(pending?.rename ?? current);
  const [tried, setTried] = useState(false);
  const refs = useReferrers(id, entry.dn);
  const taken = useTaken(id);
  const parent = parentDn(entry.dn);
  const to = renamedDn(entry.dn, value.trim());
  // A posixGroup lists a uid, so only the rename of a uid changes what it holds.
  const groups = (refs.data?.entries ?? []).filter((g) => !isUidAttr(g.memberAttr) || attr.toLowerCase() === "uid");
  // Without the groups that list it, a rename would leave them pointing at the old DN.
  const lookup = refs.data?.failure ? `Kanopa couldn't find the groups that list this entry, so it can't keep them in step. ${refs.data.failure.message}` : "";

  const error = lookup
    ? lookup
    : !value.trim()
    ? `Naming violation (64) — enter a value for ${attr}.`
    : value.trim() === current
      ? "Enter a new name; this is the current one."
      : taken(to, entry.dn)
        ? `Entry already exists (68) — ${rdnOf(to)},${parent} is taken.`
        : "";

  function save() {
    setTried(true);
    if (error || refs.isPending) return;
    update(id, (set) => renameEntry(set, entry, value.trim(), linksOf(groups)));
    onClose();
  }

  const hint = `Kanopa sends a modrdn and replaces the old ${attr} value (deleteoldrdn: 1). The entry keeps its other attributes${
    refs.isPending ? "." : groups.length ? ` and its group memberships: ${plural(groups.length, "group")} listing it ${groups.length === 1 ? "is" : "are"} updated too.` : "."
  }`;
  return (
    <Dialog
      title={
        <>
          Rename <code className="!text-[16px]">{rdnOf(entry.dn)}</code>
        </>
      }
      description={
        <>
          Changes the entry's RDN. It stays in <code>{parent}</code>.
        </>
      }
      onClose={onClose}
      width={560}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Rename entry", onClick: save, busy: refs.isPending }}
    >
      <TextField
        label={
          <>
            New name <code>{attr}=</code>
          </>
        }
        mono
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={tried && !!error}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        placeholder={current}
      />
      <DnPreview rdn={rdnOf(to)} parent={parent} />
      <span className="text-[12px] leading-4 text-ink-muted">{hint}</span>
      {(tried || lookup) && error && (
        <Banner tone="danger" title="Not renamed yet.">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

function DnPreview({ rdn, parent, label = "New DN" }: { rdn: string; parent: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="type-label">{label}</span>
      <code className="kn-dn-preview">
        <strong>{rdn}</strong>
        {parent ? `,${parent}` : ""}
      </code>
    </div>
  );
}

/* ---------- Delete ---------- */

export function DeleteDialog({ id, entry, host, onClose }: { id: string; entry: EntryView; host: string; onClose: () => void }) {
  const backend = useBackend();
  const update = useChanges((s) => s.update);
  const node = useBrowser((s) => s.nodes[dnKey(entry.dn)]);
  const refs = useReferrers(id, entry.dn);
  const [cleanup, setCleanup] = useState(true);
  // Children: what the tree read, else ask the server.
  const known = node?.children ? (node.total ?? node.children.length) : node && !node.node.hasChildren ? 0 : undefined;
  const count = useQuery({
    queryKey: ["childCount", id, dnKey(entry.dn)],
    queryFn: () => backend.countChildren(id, entry.dn),
    enabled: known === undefined,
  });
  const below = known ?? (count.data && !count.data.failure ? count.data.count : undefined);
  const groups = refs.data?.entries ?? [];
  const lookup = refs.data?.failure ?? (count.data?.failure || undefined);
  const rdn = rdnOf(entry.dn);
  const isGroup = entry.type === "group";
  const members = (entry.attributes ?? []).filter((a) => /^(member|uniqueMember|memberUid)$/i.test(a.name)).flatMap((a) => a.values ?? []).length;
  const blocked = (below ?? 0) > 0;
  const loading = !lookup && (below === undefined || refs.isPending);

  let body: string;
  if (blocked) body = `${rdn} still has ${plural(below!, "entry", "entries")} below it.`;
  else if (isGroup) body = `The group and its ${plural(members, "member value")} are removed from ${host} when you apply. The people stay. After that this cannot be undone.`;
  else if (groups.length)
    body = `The entry and its ${plural(groups.length, "group membership")} are removed from ${host} when you apply. After that this cannot be undone.`;
  else body = `The entry is removed from ${host} when you apply. After that this cannot be undone.`;

  return (
    <ConfirmDialog
      tone="danger"
      title={
        <>
          Delete <code>{rdn}</code>?
        </>
      }
      confirmLabel="Delete entry"
      confirmDisabled={blocked || loading || !!lookup}
      onCancel={onClose}
      onConfirm={() => {
        if (blocked || loading || lookup) return;
        update(id, (set) => markDelete(set, entry, cleanup ? linksOf(groups) : []));
        onClose();
      }}
    >
      {lookup ? (
        <Banner tone="danger" title="Can't tell what is lost.">
          Kanopa couldn't count the entries below it or find the groups that list it, so it won't stage the delete. {lookup.message}
        </Banner>
      ) : loading ? (
        <Skeleton variant="text" rows={2} label="Counting what is lost" />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0">{body}</p>
          {!blocked && groups.length > 0 && (
            <Checkbox
              checked={cleanup}
              onChange={(e) => setCleanup(e.target.checked)}
              label={`Also remove ${rdn} from the member list of ${groups.map((g) => rdnOf(g.dn)).join(", ")}, so no group points at a missing entry.`}
            />
          )}
          {blocked && (
            <Banner tone="danger" title="Can't delete it yet.">
              LDAP deletes only leaf entries. Delete or move the entries below it first. Not allowed on non-leaf (66)
            </Banner>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

/* ---------- pickers ---------- */

interface PickerProps {
  id: string;
  kind: "people" | "groups";
  exclude: (dn: string, e: RelatedEntry) => boolean;
  /** Why a hit can't be added, shown beside it; the Add button is off. */
  disabled?: (e: RelatedEntry) => string | undefined;
  onPick: (e: RelatedEntry) => void;
  onDone?: () => void;
  label?: string;
}

/** Search the base DN for people or groups; the first 8 hits, with the total and the filter. */
function Picker({ id, kind, exclude, disabled, onPick, onDone, label }: PickerProps) {
  const backend = useBackend();
  const [q, setQ] = useState("");
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettled(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["find", id, kind, settled],
    queryFn: () => backend.find(id, kind, settled),
    enabled: [...settled].length >= 2,
    staleTime: 10_000,
  });
  const r = search.data;
  const hits = (r?.entries ?? []).filter((e) => !exclude(e.dn, e));
  const what = kind === "people" ? "people" : "groups";
  const placeholder = label ?? (kind === "people" ? "Search people by name, uid or mail" : "Search groups by name");
  return (
    <div className="kn-picker">
      <div className="flex items-center gap-2">
        <TextField icon="search" type="search" aria-label={placeholder} placeholder={placeholder} value={q} autoFocus mono fieldClassName="grow" onChange={(e) => setQ(e.target.value)} />
        {onDone && (
          <Button variant="ghost" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
      {[...settled].length < 2 ? (
        <div className="kn-picker__note">Type at least 2 characters to search {what} on the server.</div>
      ) : search.isPending ? (
        <Skeleton variant="text" rows={2} label="Searching" />
      ) : r?.failure ? (
        <Banner tone="danger" title={r.failure.title}>
          {r.failure.message}
        </Banner>
      ) : (
        <>
          <ul className="kn-picker__list" aria-label={`Matching ${what}`}>
            {hits.map((e) => {
              const why = disabled?.(e);
              return (
                <li key={e.dn} className="kn-picker__row">
                  <TypeTile type={e.type} size={22} />
                  <span className="font-semibold">{e.name}</span>
                  <code className="kn-picker__dn" title={e.dn}>
                    {e.dn}
                  </code>
                  {why && <span className="shrink-0 text-[12px] leading-4 text-warning-ink">{why}</span>}
                  <Button size="sm" onClick={() => onPick(e)} aria-label={`Add ${e.name}`} disabled={!!why || (kind === "groups" && !e.memberAttr)}>
                    Add
                  </Button>
                </li>
              );
            })}
            {hits.length === 0 && <li className="kn-picker__note">{kind === "people" ? "No one else matches" : "No other group matches"} “{settled}”.</li>}
          </ul>
          <div className="kn-picker__foot">
            <span>
              {r && r.total > (r.entries ?? []).length ? `First ${(r.entries ?? []).length} of ${r.more ? `${r.total.toLocaleString("en-US")}+` : r.total.toLocaleString("en-US")} matches` : `${plural(r?.total ?? 0, "match", "matches")}`}{" "}
              under <code>{r?.base}</code>
            </span>
            <code className="kn-picker__filter">{r?.filter}</code>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Members (group) and Member of (person) ---------- */

const nameOfDn = (dn: string) => rdnValue(dn);

interface RelRow {
  dn: string;
  name: string;
  type: string;
  state: "same" | "added" | "removed";
  canRemove: boolean;
}

/** One row of a members list is this tall, so a long list can draw only the rows in view. */
const REL_ROW = 40;

function RelList({ rows, onOpen, onRemove, onUndo, editable }: { rows: RelRow[]; onOpen: (dn: string) => void; onRemove: (dn: string) => void; onUndo: (r: RelRow) => void; editable: boolean }) {
  const { attach, start, end, before, after, windowed } = useWindow<HTMLUListElement>(rows.length, REL_ROW);
  return (
    <ul ref={attach} className="m-0 list-none overflow-hidden rounded-md border border-line bg-surface-raised p-0" style={windowed ? { paddingTop: before, paddingBottom: after } : undefined}>
      {rows.slice(start, end).map((g, k) => (
        <li key={g.dn} aria-posinset={start + k + 1} aria-setsize={rows.length} className={cx("box-border flex h-10 items-center gap-2.5 px-3", start + k > 0 && "border-t border-line", g.state === "added" && "bg-moss-soft")}>
          <TypeTile type={g.type} size={24} />
          <span className={cx("truncate font-semibold", g.state === "removed" && "kn-attrs__removed")}>{g.name}</span>
          {g.state !== "same" && <span className={cx("kn-attrs__mark", g.state === "removed" && "is-removed")}>{g.state === "added" ? "Added" : "Removed"}</span>}
          <button type="button" className="kn-attrs__link ml-auto min-w-0 max-w-[50%] shrink-0 font-mono text-[12px]" title={`Open ${g.dn}`} onClick={() => onOpen(g.dn)}>
            {g.dn}
          </button>
          {editable &&
            (g.state === "same" ? (
              g.canRemove && <Button variant="ghost" size="sm" icon="x" label={`Remove ${g.name}`} onClick={() => onRemove(g.dn)} />
            ) : (
              <Button variant="ghost" size="sm" onClick={() => onUndo(g)}>
                Undo
              </Button>
            ))}
        </li>
      ))}
    </ul>
  );
}

interface MembersProps {
  id: string;
  group: EntryView;
  editable: boolean;
  onOpen: (dn: string) => void;
  /** Bumped to open the picker (the tree's Add member). */
  picking?: number;
}

/**
 * A group's members, with pending adds and removals. A group lists them by DN (member, uniqueMember),
 * a posixGroup by uid (memberUid), and one that is both gets a section for each.
 */
export function MembersPanel(props: MembersProps) {
  const attrs = props.group.attributes ?? [];
  const classes = props.group.objectClasses ?? [];
  const isClass = (...names: string[]) => classes.some((c) => names.some((n) => n.toLowerCase() === c.toLowerCase()));
  const byUid = attrs.some((a) => isUidAttr(a.name)) || isClass("posixGroup");
  const byDn = attrs.some((a) => /^(member|uniqueMember)$/i.test(a.name)) || isClass("groupOfNames", "groupOfUniqueNames", "groupOfMembers") || !byUid;
  if (byDn && byUid)
    return (
      <div className="flex flex-col gap-6">
        <DnMembers {...props} heading="member" />
        <UidMembers {...props} picking={0} heading="memberUid" />
      </div>
    );
  return byUid ? <UidMembers {...props} /> : <DnMembers {...props} />;
}

/** The members a group lists by DN. */
function DnMembers({ id, group, editable, onOpen, picking = 0, heading }: MembersProps & { /** Names the attribute when the group has two member lists. */ heading?: string }) {
  const update = useChanges((s) => s.update);
  const set = useChanges((s) => s.byConnection[id]);
  const [adding, setAdding] = useState(picking > 0);
  const [seen, setSeen] = useState(picking);
  if (seen !== picking) {
    setSeen(picking);
    if (picking > 0) setAdding(true);
  }
  const attrs = group.attributes ?? [];
  const attr = attrs.find((a) => /^uniqueMember$/i.test(a.name)) && !attrs.find((a) => /^member$/i.test(a.name)) ? "uniqueMember" : "member";
  const values = attrs.find((a) => a.name.toLowerCase() === attr.toLowerCase())?.values ?? [];
  const pending = set?.[dnKey(group.dn)]?.attrs.find((a) => a.name.toLowerCase() === attr.toLowerCase());
  const rows = cellsToRows(values, pending);
  const now = valuesAfter(values, pending);
  const target = { dn: group.dn, title: group.title };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="type-heading m-0">
          {plural(now.length, "member")}
          {heading && <code className="ml-2 text-[12px] font-normal text-ink-muted">{heading}</code>}
        </h3>
        {editable && !adding && (
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </div>
      {adding && (
        <Picker
          id={id}
          kind="people"
          exclude={(dn) => now.some((v) => sameDn(v, dn))}
          onPick={(p) => update(id, (s) => membership(s, target, attr, { add: p.dn }))}
          onDone={() => setAdding(false)}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState icon="users" tone="group" title="No members">
          This group lists no member.
        </EmptyState>
      ) : (
        <RelList
          rows={rows}
          editable={editable}
          onOpen={onOpen}
          onRemove={(dn) => update(id, (s) => membership(s, target, attr, { remove: dn }))}
          onUndo={(r) => update(id, (s) => membership(s, target, attr, r.state === "added" ? { remove: r.dn } : { add: r.dn }, true))}
        />
      )}
      {attr === "member" && now.length === 1 && editable && (
        <span className="text-[12px] leading-4 text-ink-muted">groupOfNames needs at least one member: the server refuses to remove the last one.</span>
      )}
    </div>
  );
}


/** One member of a posixGroup: the uid it lists, and whether a pending change adds or removes it. */
interface UidRow {
  uid: string;
  state: "same" | "added" | "removed";
}

function uidRows(values: string[], pending: PendingAttr | undefined): UidRow[] {
  return cells(values, pending).map((c) => ({ uid: c.value, state: c.state === "added" ? "added" : c.state === "removed" ? "removed" : "same" }));
}

/** The members a posixGroup lists by uid (memberUid), each looked up as the person it stands for. */
function UidMembers({ id, group, editable, onOpen, picking = 0, heading }: MembersProps & { heading?: string }) {
  const update = useChanges((s) => s.update);
  const set = useChanges((s) => s.byConnection[id]);
  const [adding, setAdding] = useState(picking > 0);
  const [seen, setSeen] = useState(picking);
  if (seen !== picking) {
    setSeen(picking);
    if (picking > 0) setAdding(true);
  }
  const attr = (group.attributes ?? []).find((a) => isUidAttr(a.name));
  const values = attr?.values ?? [];
  const pending = set?.[dnKey(group.dn)]?.attrs.find((a) => isUidAttr(a.name));
  const rows = uidRows(values, pending);
  const now = rows.filter((r) => r.state !== "removed").map((r) => r.uid);
  const target = { dn: group.dn, title: group.title };
  const name = attr?.name ?? "memberUid";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="type-heading m-0">
          {plural(now.length, "member")}
          {heading && <code className="ml-2 text-[12px] font-normal text-ink-muted">{heading}</code>}
        </h3>
        {editable && !adding && (
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </div>
      {adding && (
        <Picker
          id={id}
          kind="people"
          exclude={(_, p) => !!p.uid && now.includes(p.uid)}
          disabled={(p) => (p.uid ? undefined : "has no uid")}
          onPick={(p) => update(id, (s) => membership(s, target, name, { add: p.uid }))}
          onDone={() => setAdding(false)}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState icon="users" tone="group" title="No members">
          This group lists no member.
        </EmptyState>
      ) : (
        <UidList
          id={id}
          rows={rows}
          editable={editable}
          onOpen={onOpen}
          onRemove={(uid) => update(id, (s) => membership(s, target, name, { remove: uid }))}
          onUndo={(r) => update(id, (s) => membership(s, target, name, r.state === "added" ? { remove: r.uid } : { add: r.uid }, true))}
        />
      )}
    </div>
  );
}

/** The uids of a posixGroup as rows. The people they stand for are looked up for the rows in view only. */
function UidList({ id, rows, onOpen, onRemove, onUndo, editable }: { id: string; rows: UidRow[]; onOpen: (dn: string) => void; onRemove: (uid: string) => void; onUndo: (r: UidRow) => void; editable: boolean }) {
  const backend = useBackend();
  const { attach, start, end, before, after, windowed } = useWindow<HTMLUListElement>(rows.length, REL_ROW);
  const shown = rows.slice(start, end);
  const asked = shown.map((r) => r.uid);
  const found = useQuery({
    queryKey: ["uids", id, asked],
    queryFn: () => backend.resolveUids(id, asked),
    enabled: asked.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const byUid = new Map((found.data?.matches ?? []).map((m) => [m.uid, m]));
  return (
    <ul ref={attach} className="m-0 list-none overflow-hidden rounded-md border border-line bg-surface-raised p-0" style={windowed ? { paddingTop: before, paddingBottom: after } : undefined}>
      {shown.map((r, k) => {
        const m = byUid.get(r.uid);
        const missing = !!m && m.matches === 0;
        return (
          <li key={r.uid} aria-posinset={start + k + 1} aria-setsize={rows.length} className={cx("box-border flex h-10 items-center gap-2.5 px-3", start + k > 0 && "border-t border-line", r.state === "added" && "bg-moss-soft")}>
            <TypeTile type={m && m.matches > 0 ? m.type : "entry"} size={24} />
            <span className={cx("truncate font-semibold", r.state === "removed" && "kn-attrs__removed")}>{m && m.matches > 0 ? m.name : r.uid}</span>
            {m && m.matches > 0 && <code className="shrink-0 text-[12px] text-ink-muted">{r.uid}</code>}
            {r.state !== "same" && <span className={cx("kn-attrs__mark", r.state === "removed" && "is-removed")}>{r.state === "added" ? "Added" : "Removed"}</span>}
            {m && m.matches > 1 && (
              <span className="kn-attrs__mark" title={`${plural(m.matches, "entry", "entries")} carry the uid ${r.uid}. The first is shown.`}>
                {`matches ${m.matches} entries`}
              </span>
            )}
            {missing ? (
              <span className="ml-auto shrink-0 text-[12px] leading-4 text-warning-ink">No entry has this uid</span>
            ) : (
              m && (
                <button type="button" className="kn-attrs__link ml-auto min-w-0 max-w-[50%] shrink-0 font-mono text-[12px]" title={`Open ${m.dn}`} onClick={() => onOpen(m.dn)}>
                  {m.dn}
                </button>
              )
            )}
            {editable &&
              (r.state === "same" ? (
                <Button variant="ghost" size="sm" icon="x" label={`Remove ${m && m.matches > 0 ? m.name : r.uid}`} onClick={() => onRemove(r.uid)} />
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onUndo(r)}>
                  Undo
                </Button>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

function cellsToRows(values: string[], pending: PendingAttr | undefined): RelRow[] {
  const kept = valuesAfter(values, pending);
  const rows: RelRow[] = [];
  // Sets of DN keys: a group can list thousands of members, and comparing each with each would be quadratic.
  const keptKeys = new Set(kept.map(dnKey));
  const valueKeys = new Set(values.map(dnKey));
  const addKeys = new Set((pending?.add ?? []).map(dnKey));
  const isAdded = (v: string) => addKeys.has(dnKey(v)) || (pending && !pending.add && !valueKeys.has(dnKey(v)));
  for (const v of kept) rows.push({ dn: v, name: nameOfDn(v), type: /^uid=/i.test(v) ? "person" : "entry", state: isAdded(v) ? "added" : "same", canRemove: true });
  for (const v of values) if (!keptKeys.has(dnKey(v))) rows.push({ dn: v, name: nameOfDn(v), type: /^uid=/i.test(v) ? "person" : "entry", state: "removed", canRemove: false });
  return rows;
}

/** The groups that list a person, with pending joins and leaves; Add to group searches groups. */
export function MemberOfPanel({ id, entry, editable, onOpen }: { id: string; entry: EntryView; editable: boolean; onOpen: (dn: string) => void }) {
  const backend = useBackend();
  const { failed, session } = useBrowser();
  const update = useChanges((s) => s.update);
  const set = useChanges((s) => s.byConnection[id]);
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: ["memberOf", id, dnKey(entry.dn)],
    queryFn: async () => {
      const r = await backend.memberOf(id, entry.dn);
      if (r.failure) failed(r.failure);
      return r;
    },
    staleTime: 30_000,
  });
  // A posixGroup lists the uid, not the DN, so a person with no uid cannot join one.
  const uid = (entry.attributes ?? []).find((a) => /^uid$/i.test(a.name))?.values?.[0] ?? "";
  const rows = useMemo(() => memberOfRows(q.data?.entries ?? [], set, entry.dn, uid), [q.data, set, entry.dn, uid]);
  if (q.isPending) return <Skeleton variant="table" rows={3} label="Finding groups" />;
  const r = q.data!;
  if (r.failure && !r.failure.lost)
    return (
      <Banner tone="danger" title={r.failure.title}>
        {r.failure.message}
      </Banner>
    );
  const now = rows.filter((g) => g.state !== "removed");
  const attrOf = (dn: string) => rows.find((g) => sameDn(g.dn, dn))?.attr ?? "member";
  /** What a group lists for this person: the DN, or the uid for a posixGroup. */
  const valueFor = (attr: string) => (isUidAttr(attr) ? uid : entry.dn);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="type-heading m-0">
          Member of {plural(now.length, "group")}
          {r.truncated && " (the first 1,000)"}
        </h3>
        {editable && !adding && (
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add to group
          </Button>
        )}
      </div>
      {adding && (
        <Picker
          id={id}
          kind="groups"
          exclude={(dn) => now.some((g) => sameDn(g.dn, dn))}
          disabled={(g) => (isUidAttr(g.memberAttr) && !uid ? "this entry has no uid" : undefined)}
          onPick={(g) => update(id, (s) => membership(s, { dn: g.dn, title: g.name }, g.memberAttr || "member", { add: valueFor(g.memberAttr || "member") }))}
          onDone={() => setAdding(false)}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState icon="users" tone="group" title="Not in any group">
          No group under <code>{session?.baseDn}</code> lists this entry in member, uniqueMember or memberUid.
        </EmptyState>
      ) : (
        <RelList
          rows={rows}
          editable={editable}
          onOpen={onOpen}
          onRemove={(dn) => update(id, (s) => membership(s, { dn, title: rows.find((g) => sameDn(g.dn, dn))?.name ?? rdnOf(dn) }, attrOf(dn), { remove: valueFor(attrOf(dn)) }))}
          onUndo={(g) => update(id, (s) => membership(s, { dn: g.dn, title: g.name }, attrOf(g.dn), g.state === "added" ? { remove: valueFor(attrOf(g.dn)) } : { add: valueFor(attrOf(g.dn)) }, true))}
        />
      )}
    </div>
  );
}

function memberOfRows(groups: RelatedEntry[], set: ChangeSet | undefined, dn: string, uid: string): Array<RelRow & { attr: string }> {
  const rows: Array<RelRow & { attr: string }> = [];
  const pendingFor = (g: string) => Object.values(set ?? {}).find((e) => sameDn(e.dn, g))?.attrs ?? [];
  // What an attribute lists for this entry: its DN, or its uid in memberUid.
  const holdsIn = (name: string, list: string[] | undefined) => (list ?? []).some((v) => (isUidAttr(name) ? !!uid && v === uid : sameDn(v, dn)));
  for (const g of groups) {
    const removed = pendingFor(g.dn).some((a) => holdsIn(a.name, a.remove) || (!a.add && holdsIn(a.name, a.before) && !holdsIn(a.name, a.after)));
    rows.push({ dn: g.dn, name: g.name, type: g.type, state: removed ? "removed" : "same", canRemove: !!g.memberAttr, attr: g.memberAttr || "member" });
  }
  for (const e of Object.values(set ?? {})) {
    if (groups.some((g) => sameDn(g.dn, e.dn))) continue;
    const a = e.attrs.find((x) => holdsIn(x.name, x.add) || (!isDelta(x) && (x.kind === "dn" || isUidAttr(x.name)) && holdsIn(x.name, x.after) && !holdsIn(x.name, x.before)));
    if (a) rows.push({ dn: e.dn, name: e.title || rdnValue(e.dn), type: "group", state: "added", canRemove: false, attr: a.name });
  }
  return rows;
}

/* ---------- New entry ---------- */

type EntryKind = "person" | "group" | "posix" | "other";
const KINDS: Array<{ id: EntryKind; label: string; oc: string; type: string }> = [
  { id: "person", label: "Person", oc: "inetOrgPerson", type: "person" },
  { id: "group", label: "Group", oc: "groupOfNames", type: "group" },
  { id: "posix", label: "POSIX group", oc: "posixGroup", type: "group" },
  { id: "other", label: "Other", oc: "from the schema", type: "entry" },
];

const slugUid = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]+/g, ".").replace(/^\.+|\.+$/g, "");

interface Field {
  name: string;
  kind: ValueKind;
  required: boolean;
  value: string;
  /** A password field's confirmation. */
  confirm?: string;
}

/** NewEntryForm: Person, Group or Other (object classes from the schema), under a parent. */
export function NewEntryDialog({ id, session, parent: initialParent, onClose, onCreated }: { id: string; session: SessionInfo; parent: string; onClose: () => void; onCreated: (dn: string) => void }) {
  const backend = useBackend();
  const update = useChanges((s) => s.update);
  const nodes = useBrowser((s) => s.nodes);
  const taken = useTaken(id);
  const [kind, setKind] = useState<EntryKind>("person");
  const [parent, setParent] = useState(initialParent);
  const [tried, setTried] = useState(false);
  // Person
  const [p, setP] = useState({ given: "", sn: "", uid: "", cn: "", mail: "", title: "", pw: "", pw2: "" });
  const [edited, setEdited] = useState({ uid: false, cn: false });
  // Group
  const [g, setG] = useState({ cn: "", description: "" });
  const [members, setMembers] = useState<RelatedEntry[]>([]);
  // POSIX group: members are listed by uid, and gidNumber is required. Empty gid follows the suggestion.
  const [px, setPx] = useState<{ cn: string; gid: string | null; description: string }>({ cn: "", gid: null, description: "" });
  const [uidMembers, setUidMembers] = useState<RelatedEntry[]>([]);
  const suggestion = useQuery({ queryKey: ["gid", id], queryFn: () => backend.gidCheck(id, 0), enabled: kind === "posix", staleTime: 0, gcTime: 0 });
  // null until the person edits it: then the number follows the suggestion, and an emptied field stays empty.
  const gid = px.gid !== null ? px.gid.trim() : suggestion.data && !suggestion.data.failure ? String(suggestion.data.next) : "";
  const gidValid = /^\d+$/.test(gid);
  const gidUse = useQuery({ queryKey: ["gidUse", id, gid], queryFn: () => backend.gidCheck(id, Number(gid)), enabled: kind === "posix" && gidValid, staleTime: 10_000 });
  const gidTakenBy = gidUse.data && !gidUse.data.failure ? gidUse.data.takenBy ?? [] : [];
  // Other
  const classes = useQuery({ queryKey: ["classes", id], queryFn: () => backend.objectClasses(id), enabled: kind === "other", staleTime: Infinity });
  const [chosen, setChosen] = useState<ClassInfo[]>([]);
  const [ocq, setOcq] = useState("");
  const [fields, setFields] = useState<Field[]>([]);
  const [rdnAttr, setRdnAttr] = useState("");

  const containers = Object.values(nodes)
    .map((n) => n.node)
    .filter((n) => (n.type === "root" || n.type === "ou") && !n.referral)
    .sort((a, b) => a.dn.localeCompare(b.dn));
  if (!containers.some((c) => sameDn(c.dn, initialParent))) containers.unshift({ dn: initialParent, rdn: rdnOf(initialParent), type: "ou", sub: "", hasChildren: true, count: -1, referral: false });

  const setPerson = (k: keyof typeof p, v: string) =>
    setP((cur) => {
      const next = { ...cur, [k]: v };
      if (k === "given" && !edited.uid) next.uid = slugUid(v);
      if ((k === "given" || k === "sn") && !edited.cn) next.cn = `${k === "given" ? v : cur.given} ${k === "sn" ? v : cur.sn}`.trim();
      return next;
    });

  // The entry as it would be added.
  const otherFields = fields;
  const rdn =
    kind === "person" ? `uid=${escapeRdnValue(p.uid.trim())}` : kind === "group" ? `cn=${escapeRdnValue(g.cn.trim())}` : kind === "posix" ? `cn=${escapeRdnValue(px.cn.trim())}` : `${rdnAttr}=${escapeRdnValue(otherFields.find((f) => f.name === rdnAttr)?.value.trim() ?? "")}`;
  const dn = `${rdn},${parent}`;
  const structural = chosen.find((c) => c.kind === "STRUCTURAL");
  const ocs =
    kind === "person" ? ["inetOrgPerson", "organizationalPerson", "person", "top"] : kind === "group" ? ["groupOfNames", "top"] : kind === "posix" ? ["posixGroup", "top"] : [...chosen.map((c) => c.name), "top"];

  const errors: string[] = [];
  if (kind === "person") {
    if (!p.sn.trim()) errors.push("Object class violation (65) — inetOrgPerson requires the attribute sn.");
    if (!p.uid.trim()) errors.push("Naming violation (64) — enter a uid: it names the entry.");
    if (!p.cn.trim()) errors.push("Object class violation (65) — inetOrgPerson requires the attribute cn.");
    errors.push(...passwordErrors(p.pw, p.pw2, false));
  } else if (kind === "group") {
    if (!g.cn.trim()) errors.push("Naming violation (64) — enter a group name: cn names the entry.");
    if (members.length === 0) errors.push("Object class violation (65) — groupOfNames requires the attribute member. Add a member.");
  } else if (kind === "posix") {
    if (!px.cn.trim()) errors.push("Naming violation (64) — enter a group name: cn names the entry.");
    if (!gid) errors.push("Object class violation (65) — posixGroup requires the attribute gidNumber.");
    else if (!gidValid) errors.push("Invalid syntax (21) — gidNumber must be a whole number.");
  } else {
    if (!structural) errors.push("Object class violation (65) — pick one structural object class.");
    for (const f of otherFields) if (f.required && !f.value.trim()) errors.push(`Object class violation (65) — ${structural?.name ?? "the entry"} requires the attribute ${f.name}.`);
    if (!rdnAttr) errors.push("Naming violation (64) — choose the naming attribute.");
    for (const f of otherFields) if (f.kind === "dn" && f.value.trim() && !isDnSyntax(f.value)) errors.push(`Invalid DN syntax (34) — ${f.name} needs a DN.`);
    for (const f of otherFields) if (f.kind === "password") errors.push(...passwordErrors(f.value, f.confirm ?? "", false));
  }
  if (rdn.endsWith("=") === false && taken(dn)) errors.push(`Entry already exists (68) — ${dn} is taken.`);

  function create() {
    setTried(true);
    if (errors.length) return;
    const attr = (name: string, values: string[], k: ValueKind = "text"): PendingAttr => ({ name, kind: k, before: [], after: values.map((v) => v.trim()).filter(Boolean) });
    let attrs: PendingAttr[];
    let title: string;
    if (kind === "person") {
      title = p.cn.trim();
      attrs = [attr("objectClass", ocs), attr("uid", [p.uid]), attr("cn", [p.cn]), attr("sn", [p.sn])];
      if (p.given.trim()) attrs.push(attr("givenName", [p.given]));
      if (p.mail.trim()) attrs.push(attr("mail", [p.mail]));
      if (p.title.trim()) attrs.push(attr("title", [p.title]));
      if (p.pw) attrs.push({ name: "userPassword", kind: "password", before: [], after: [], password: p.pw });
    } else if (kind === "group") {
      title = g.cn.trim();
      attrs = [attr("objectClass", ocs), attr("cn", [g.cn]), attr("member", members.map((m) => m.dn), "dn")];
      if (g.description.trim()) attrs.push(attr("description", [g.description]));
    } else if (kind === "posix") {
      title = px.cn.trim();
      attrs = [attr("objectClass", ocs), attr("cn", [px.cn]), attr("gidNumber", [gid])];
      if (uidMembers.length) attrs.push(attr("memberUid", uidMembers.map((m) => m.uid)));
      if (px.description.trim()) attrs.push(attr("description", [px.description]));
    } else {
      title = otherFields.find((f) => f.name === rdnAttr)?.value.trim() ?? rdnValue(dn);
      attrs = [attr("objectClass", ocs)];
      for (const f of otherFields) {
        if (!f.value.trim()) continue;
        attrs.push(f.kind === "password" ? { name: f.name, kind: "password", before: [], after: [], password: f.value } : attr(f.name, [f.value], f.kind));
      }
    }
    const type = kind === "other" ? typeFor(ocs) : KINDS.find((k) => k.id === kind)!.type;
    update(id, (s) => addEntry(s, { dn, title, type, attrs }));
    onCreated(dn);
    onClose();
  }

  function addClass(c: ClassInfo) {
    const next = [...chosen.filter((x) => !(c.kind === "STRUCTURAL" && x.kind === "STRUCTURAL")), c];
    setChosen(next);
    const must = new Map<string, Field>();
    for (const x of next) for (const a of (x.must ?? [])) if (!must.has(a.name)) must.set(a.name, { name: a.name, kind: (a.kind as ValueKind) || "text", required: true, value: "" });
    const keep = fields.filter((f) => !f.required && !must.has(f.name));
    const merged = [...must.values()].map((f) => ({ ...f, value: fields.find((x) => x.name === f.name)?.value ?? "" }));
    setFields([...merged, ...keep]);
    if (!rdnAttr || !must.has(rdnAttr)) setRdnAttr([...must.keys()][0] ?? "");
    setOcq("");
  }
  const mayOptions = [...new Map(chosen.flatMap((c) => (c.may ?? [])).map((a) => [a.name, a])).values()].filter((a) => !fields.some((f) => f.name === a.name) && a.kind !== "binary");
  const ocHits = (classes.data?.classes ?? [])
    .filter((c) => !chosen.some((x) => x.name === c.name) && (!ocq.trim() || c.name.toLowerCase().includes(ocq.trim().toLowerCase())))
    .slice(0, 8);

  const label = (text: string, attr: string, required = false) => (
    <>
      {text} <code>{attr}</code>
      {required && <span aria-hidden="true">*</span>}
    </>
  );

  return (
    <Dialog
      title="New entry"
      description={`The entry joins your pending changes. Nothing is written to ${hostOf(session.url)} until you apply.`}
      onClose={onClose}
      width={660}
      footerStart={<code className="kn-new__ocs">objectClass: {ocs.join(", ")}</code>}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Create entry", onClick: create }}
    >
      <div className="flex flex-col gap-1.5">
        <span className="type-label" id="ne-type">
          Entry type
        </span>
        <div role="group" aria-labelledby="ne-type" className="kn-new__types">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className="kn-new__type" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
              <TypeTile type={k.type} size={24} />
              <span className="flex flex-col items-start">
                <span className="font-semibold">{k.label}</span>
                <code>{k.oc}</code>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Create under" mono value={parent} onChange={(e) => setParent(e.target.value)} options={containers.map((c) => ({ value: c.dn, label: c.dn }))} />
        <DnPreview label="DN" rdn={rdn} parent={parent} />
      </div>

      {kind === "person" && (
        <div className="grid grid-cols-2 gap-3">
          <TextField label={label("First name", "givenName")} value={p.given} autoFocus onChange={(e) => setPerson("given", e.target.value)} />
          <TextField label={label("Last name", "sn", true)} value={p.sn} required onChange={(e) => setPerson("sn", e.target.value)} />
          <TextField
            label={label("User ID", "uid", true)}
            mono
            value={p.uid}
            hint="Names the entry. Follows the first name until you edit it."
            onChange={(e) => {
              setEdited((x) => ({ ...x, uid: true }));
              setPerson("uid", e.target.value);
            }}
          />
          <TextField
            label={label("Full name", "cn", true)}
            value={p.cn}
            onChange={(e) => {
              setEdited((x) => ({ ...x, cn: true }));
              setPerson("cn", e.target.value);
            }}
          />
          <TextField label={label("Mail", "mail")} type="email" mono value={p.mail} onChange={(e) => setPerson("mail", e.target.value)} />
          <TextField label={label("Title", "title")} value={p.title} onChange={(e) => setPerson("title", e.target.value)} />
          <PasswordPair
            className="col-span-2"
            label={label("Initial password", "userPassword")}
            value={p.pw}
            confirm={p.pw2}
            onChange={(v) => setPerson("pw", v)}
            onConfirm={(v) => setPerson("pw2", v)}
            invalid={tried && passwordErrors(p.pw, p.pw2, false).length > 0}
            hint={
              /^(LDAPS|StartTLS)$/.test(session.security)
                ? `Optional. ${passwordHint(session.security)}`
                : "Optional. This connection is not encrypted: the password crosses the network as plain text."
            }
          />
        </div>
      )}

      {kind === "group" && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <TextField label={label("Group name", "cn", true)} mono value={g.cn} autoFocus onChange={(e) => setG({ ...g, cn: e.target.value })} />
            <TextField label={label("Description", "description")} value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="type-label" id="ne-members">
                Members <code>member</code>
                <span aria-hidden="true">*</span>
              </span>
              <span className="text-[12px] text-ink-muted">{plural(members.length, "member")}</span>
            </div>
            {members.length > 0 && (
              <div role="list" aria-labelledby="ne-members" className="flex flex-wrap gap-1.5">
                {members.map((m) => (
                  <span role="listitem" key={m.dn} className="kn-chip">
                    <TypeTile type="person" size={18} />
                    {m.name}
                    <Button variant="ghost" size="sm" icon="x" label={`Remove ${m.name}`} onClick={() => setMembers(members.filter((x) => x.dn !== m.dn))} />
                  </span>
                ))}
              </div>
            )}
            <Picker id={id} kind="people" exclude={(d) => members.some((m) => sameDn(m.dn, d))} onPick={(m) => setMembers([...members, m])} />
            <span className="text-[12px] leading-4 text-ink-muted">groupOfNames needs at least one member. Add more later from the Members tab.</span>
          </div>
        </div>
      )}

      {kind === "posix" && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <TextField label={label("Group name", "cn", true)} mono value={px.cn} autoFocus onChange={(e) => setPx({ ...px, cn: e.target.value })} />
            <TextField
              label={label("Group ID", "gidNumber", true)}
              mono
              inputMode="numeric"
              value={gid}
              aria-invalid={tried && (!gid || !gidValid)}
              hint={
                gidTakenBy.length
                  ? `Already used by ${gidTakenBy.join(", ")}. Two groups can share a gidNumber, but file ownership will not tell them apart.`
                  : px.gid === null && gid
                    ? "The next free number on the server. Change it if you need another."
                    : undefined
              }
              onChange={(e) => setPx({ ...px, gid: e.target.value })}
            />
            <TextField label={label("Description", "description")} value={px.description} className="col-span-2" onChange={(e) => setPx({ ...px, description: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="type-label" id="ne-uids">
                Members <code>memberUid</code>
              </span>
              <span className="text-[12px] text-ink-muted">{plural(uidMembers.length, "member")}</span>
            </div>
            {uidMembers.length > 0 && (
              <div role="list" aria-labelledby="ne-uids" className="flex flex-wrap gap-1.5">
                {uidMembers.map((m) => (
                  <span role="listitem" key={m.uid} className="kn-chip">
                    <TypeTile type="person" size={18} />
                    {m.name}
                    <code className="text-[11px] text-ink-muted">{m.uid}</code>
                    <Button variant="ghost" size="sm" icon="x" label={`Remove ${m.name}`} onClick={() => setUidMembers(uidMembers.filter((x) => x.uid !== m.uid))} />
                  </span>
                ))}
              </div>
            )}
            <Picker
              id={id}
              kind="people"
              exclude={(_, m) => !!m.uid && uidMembers.some((x) => x.uid === m.uid)}
              disabled={(m) => (m.uid ? undefined : "has no uid")}
              onPick={(m) => setUidMembers([...uidMembers, m])}
            />
            <span className="text-[12px] leading-4 text-ink-muted">A posixGroup may have no member. It lists people by their uid; add more later from the Members tab.</span>
          </div>
        </div>
      )}

      {kind === "other" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="type-label" id="ne-ocs">
              Object classes <code>objectClass</code>
              <span aria-hidden="true">*</span>
            </span>
            {chosen.length > 0 && (
              <div role="list" aria-labelledby="ne-ocs" className="flex flex-wrap gap-1.5">
                {chosen.map((c) => (
                  <span role="listitem" key={c.name} className="kn-chip">
                    <code>{c.name}</code>
                    <span className="text-[11px] text-ink-muted">{c.kind.toLowerCase()}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="x"
                      label={`Remove ${c.name}`}
                      onClick={() => {
                        const next = chosen.filter((x) => x.name !== c.name);
                        setChosen(next);
                        const must = new Set(next.flatMap((x) => (x.must ?? []).map((a) => a.name)));
                        setFields(fields.filter((f) => !f.required || must.has(f.name)));
                        if (!must.has(rdnAttr)) setRdnAttr([...must][0] ?? "");
                      }}
                    />
                  </span>
                ))}
              </div>
            )}
            <TextField icon="search" type="search" mono aria-label="Find an object class in the server schema" placeholder="organizationalUnit or device" value={ocq} onChange={(e) => setOcq(e.target.value)} />
            {classes.isPending ? (
              <Skeleton variant="text" rows={2} label="Reading the schema" />
            ) : classes.data?.failure ? (
              <Banner tone="danger" title={classes.data.failure.title}>
                {classes.data.failure.message}
              </Banner>
            ) : (
              <ul className="kn-picker__list" aria-label="Object classes">
                {ocHits.map((c) => (
                  <li key={c.name} className="kn-picker__row">
                    <code className="font-semibold">{c.name}</code>
                    <span className="text-[12px] text-ink-muted">{c.kind.toLowerCase()}</span>
                    <span className="kn-picker__dn">{(c.must ?? []).length ? `requires ${(c.must ?? []).map((a) => a.name).join(", ")}` : c.desc}</span>
                    <Button size="sm" onClick={() => addClass(c)} aria-label={`Add ${c.name}`}>
                      Add
                    </Button>
                  </li>
                ))}
                {ocHits.length === 0 && <li className="kn-picker__note">No object class in the server schema matches “{ocq.trim()}”.</li>}
              </ul>
            )}
            <span className="text-[12px] leading-4 text-ink-muted">
              Pick one structural class, then any auxiliary classes. Kanopa adds <code>top</code> and asks for the attributes they require.
            </span>
          </div>
          {chosen.length > 0 && (
            <div className="flex flex-col gap-3">
              <Select label="Naming attribute (RDN)" mono value={rdnAttr} onChange={(e) => setRdnAttr(e.target.value)} options={fields.filter((f) => f.kind !== "password").map((f) => f.name)} />
              <div className="grid grid-cols-2 gap-3">
                {fields.map((f, i) =>
                  f.kind === "password" ? (
                    <PasswordPair
                      key={f.name}
                      className="col-span-2"
                      label={label("", f.name, f.required)}
                      value={f.value}
                      confirm={f.confirm ?? ""}
                      onChange={(v) => setFields(fields.map((x, j) => (j === i ? { ...x, value: v } : x)))}
                      onConfirm={(v) => setFields(fields.map((x, j) => (j === i ? { ...x, confirm: v } : x)))}
                      invalid={tried && passwordErrors(f.value, f.confirm ?? "", f.required).length > 0}
                      hint={passwordHint(session.security)}
                    />
                  ) : (
                  <TextField
                    key={f.name}
                    label={label("", f.name, f.required)}
                    mono
                    value={f.value}
                    placeholder={f.kind === "dn" ? `uid=…,${session.baseDn}` : undefined}
                    trailing={
                      !f.required ? <Button variant="ghost" size="sm" icon="x" label={`Remove ${f.name}`} onClick={() => setFields(fields.filter((_, j) => j !== i))} /> : undefined
                    }
                    onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  ),
                )}
              </div>
              {mayOptions.length > 0 && (
                <Select
                  label="Optional attributes"
                  mono
                  value=""
                  onChange={(e) => {
                    const a = mayOptions.find((x) => x.name === e.target.value);
                    if (a) setFields([...fields, { name: a.name, kind: (a.kind as ValueKind) || "text", required: false, value: "" }]);
                  }}
                  options={[{ value: "", label: "Add an attribute…" }, ...mayOptions.map((a) => ({ value: a.name, label: a.name }))]}
                />
              )}
            </div>
          )}
        </div>
      )}

      {tried && errors.length > 0 && (
        <Banner tone="danger" title="Not created yet.">
          {errors[0]} {errors.length > 1 && <span className="text-ink-muted">({plural(errors.length - 1, "more problem")})</span>}
        </Banner>
      )}
    </Dialog>
  );
}


function typeFor(ocs: string[]): string {
  const has = (...n: string[]) => ocs.some((o) => n.some((x) => x.toLowerCase() === o.toLowerCase()));
  if (has("organizationalUnit", "dcObject", "organization")) return "ou";
  if (has("groupOfNames", "groupOfUniqueNames", "posixGroup")) return "group";
  if (has("inetOrgPerson", "person", "organizationalPerson")) return "person";
  if (has("device", "ipHost")) return "server";
  return "entry";
}

/* ---------- pending states of the selected entry ---------- */

export function PendingState({ id, dn, onUndo }: { id: string; dn: string; onUndo: (what: "add" | "delete" | "rename") => void }) {
  const e = useChanges((s) => s.byConnection[id]?.[dnKey(dn)]);
  if (!e) return null;
  if (e.op === "add")
    return (
      <Banner tone="info" title="Not on the server yet." actions={<Button onClick={() => onUndo("add")}>Remove</Button>}>
        This entry is created when you apply pending changes. Remove takes it out of them.
      </Banner>
    );
  if (e.op === "delete")
    return (
      <Banner tone="danger" title="Marked for deletion." actions={<Button onClick={() => onUndo("delete")}>Undo delete</Button>}>
        The entry is removed when you apply{(e.links?.length ?? 0) > 0 ? `, along with its ${plural(e.links!.length, "group membership")}` : ""}.
      </Banner>
    );
  if (e.rename !== undefined)
    return (
      <Banner tone="warning" title="Pending rename." actions={<Button onClick={() => onUndo("rename")}>Undo rename</Button>}>
        <code>{rdnOf(dn)}</code> becomes <code>{rdnOf(renamedDn(dn, e.rename))}</code> when you apply.
      </Banner>
    );
  return null;
}
