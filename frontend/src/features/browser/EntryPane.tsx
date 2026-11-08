import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackend, type EntryAttribute, type EntryView, type RelatedEntry, type SessionInfo } from "@/api/backend";
import { rdnParts, splitDn } from "@/lib/dn";
import { plural } from "@/lib/time";
import { Badge, Banner, Button, DnBreadcrumb, EmptyState, LdifView, Skeleton, Tabs, Tooltip, TypeTile, cx, useToasts } from "@/ui";
import { cells, pendingOf, toEntryChanges, useChanges, type ChangeSet, type PendingAttr } from "./changes";
import { AddAttributeDialog, ValueEditor, targetOf, type EditTarget } from "./editors";
import { dnKey, useBrowser } from "./store";

/** The selected DN, settled for a moment, so arrowing through the tree does not read every entry. */
function useSettled<T>(value: T, ms = 120): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EntryPane() {
  const backend = useBackend();
  const { session, selected, select, reveal, failed, connection } = useBrowser();
  const dn = useSettled(selected);
  const id = session?.connectionId ?? "";

  const entry = useQuery({
    queryKey: ["entry", id, dn ? dnKey(dn) : ""],
    queryFn: async () => {
      const e = await backend.entry(id, dn!);
      if (e.failure) failed(e.failure);
      return e;
    },
    enabled: !!dn && !!session && connection === "connected",
    staleTime: 30_000,
  });

  const open = (target: string) => {
    select(target);
    void reveal(backend, target);
  };

  if (!dn)
    return (
      <EmptyState icon="entry" title="No entry selected">
        Pick an entry in the tree to see its attributes.
      </EmptyState>
    );
  if (entry.isPending || !entry.data)
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton variant="text" rows={2} label="Reading the entry" />
        <Skeleton variant="table" rows={8} label="Reading the attributes" />
      </div>
    );
  const e = entry.data;
  if (e.failure && !e.failure.lost)
    return (
      <div className="p-4">
        <Banner tone="danger" title={e.failure.title}>
          {e.failure.message}
        </Banner>
      </div>
    );
  if (e.failure) return null; // the lost-connection banner says it
  return <Entry key={e.dn} entry={e} session={session!} editable={!session!.readOnly && connection === "connected"} onOpen={open} />;
}

/** The entry's attributes with the attributes the person is adding, which the server does not have yet. */
function withAdded(e: EntryView, set: ChangeSet | undefined): EntryAttribute[] {
  const attrs = e.attributes ?? [];
  const added = (set?.[dnKey(e.dn)]?.attrs ?? []).filter((p) => !attrs.some((a) => a.name.toLowerCase() === p.name.toLowerCase()));
  return [
    ...attrs,
    ...added.map((p): EntryAttribute => {
      const allowed = e.allowed?.find((a) => a.name.toLowerCase() === p.name.toLowerCase());
      return { name: p.name, values: [], ids: [], kind: p.kind, operational: false, singleValue: !!allowed?.singleValue, required: !!allowed?.required };
    }),
  ];
}

function Entry({ entry: e, session, editable, onOpen }: { entry: EntryView; session: SessionInfo; editable: boolean; onOpen: (dn: string) => void }) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const id = session.connectionId;
  const pendingSet = useChanges((s) => s.byConnection[id]);
  const isGroup = e.type === "group";
  const attrs = withAdded(e, pendingSet);
  const members = attrs.filter((a) => /^(member|uniqueMember)$/i.test(a.name)).flatMap((a) => a.values ?? []);
  const relTab = isGroup ? "members" : "memberOf";
  const storedTab = useBrowser((s) => s.tab);
  const setTab = useBrowser((s) => s.setTab);
  const tab = storedTab === "attributes" || storedTab === "ldif" || storedTab === relTab ? storedTab : "attributes";
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const rdnAttr = rdnParts(splitDn(e.dn)[0] ?? "")[0].replace(/=$/, "").toLowerCase();
  const canEdit = (a: EntryAttribute) =>
    editable && !e.referral && e.type !== "server" && !a.operational && !/^objectclass$/i.test(a.name) && a.name.toLowerCase() !== rdnAttr;

  const copy = async (text: string, what: string) => {
    try {
      await backend.copyText(text);
      toast(`Copied ${what}.`);
    } catch {
      toast(`Kanopa could not copy ${what}.`, "danger");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2.5 px-4 pt-4">
        <div className="flex flex-wrap items-start gap-3">
          <TypeTile type={e.type} size={36} />
          <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="type-title m-0 break-words">{e.title}</h1>
              <div className="flex flex-wrap gap-1">
                {(e.objectClasses ?? []).filter((oc) => oc.toLowerCase() !== "top").map((oc) => (
                  <Badge key={oc} tone="heather" mono icon={false}>
                    {oc}
                  </Badge>
                ))}
              </div>
            </div>
            {e.subtitle && <span className="text-ink-muted">{e.subtitle}</span>}
          </div>
          <Button icon="copy" onClick={() => void copy(e.dn, "the DN")}>
            Copy DN
          </Button>
        </div>
        <DnBreadcrumb dn={e.dn} onNavigate={onOpen} className="self-start rounded-sm border border-line bg-surface-raised p-[3px]" />
        {e.referral && (
          <Banner tone="info" title="Referral.">
            This entry points to <code>{e.subtitle}</code>. Kanopa shows the referral itself and does not follow it.
          </Banner>
        )}
        <Tabs
          label="Entry views"
          className="!px-0"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "attributes", label: "Attributes", count: attrs.filter((a) => !a.operational).length },
            { id: "ldif", label: "LDIF" },
            isGroup ? { id: "members", label: "Members", count: members.length } : { id: "memberOf", label: "Member of" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "attributes" && (
          <Attributes
            attrs={attrs}
            pending={(name) => pendingOf(pendingSet, e.dn, name)}
            canEdit={canEdit}
            onEdit={(a) => setEditing(targetOf(a))}
            onAdd={editable && (e.allowed ?? []).length > 0 && !e.referral ? () => setAdding(true) : undefined}
            onOpen={onOpen}
            onCopy={(a) => void copy((a.values ?? []).join("\n"), a.name)}
          />
        )}
        {tab === "ldif" && pendingSet && Object.keys(pendingSet).length > 0 && <PendingLdif connectionId={id} set={pendingSet} host={hostOf(session.url)} />}
        {tab === "ldif" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="type-heading m-0">LDIF</h3>
              <Button size="sm" icon="copy" onClick={() => void copy(e.ldif, "the LDIF")}>
                Copy LDIF
              </Button>
            </div>
            <LdifView value={e.ldif} label={`LDIF of ${e.dn}`} />
            <p className="m-0 text-[12px] leading-4 text-ink-muted">User attributes only, as the server holds them. Binary values are base64.</p>
          </div>
        )}
        {tab === relTab && (isGroup ? <Members dns={members} onOpen={onOpen} /> : <MemberOf dn={e.dn} onOpen={onOpen} />)}
      </div>
      {editing && <ValueEditor connectionId={id} entry={e} target={editing} session={session} onClose={() => setEditing(null)} />}
      {adding && <AddAttributeDialog connectionId={id} entry={e} session={session} onClose={() => setAdding(false)} />}
    </div>
  );
}

const hostOf = (url: string) => url.replace(/^ldaps?:\/\//i, "").replace(/:\d+$/, "");

/** The pending changes of the connection, as the LDIF Apply sends. */
function PendingLdif({ connectionId, set, host }: { connectionId: string; set: ChangeSet; host: string }) {
  const backend = useBackend();
  const changes = toEntryChanges(set);
  const q = useQuery({
    queryKey: ["preview", connectionId, JSON.stringify(changes)],
    queryFn: () => backend.preview(connectionId, changes),
  });
  const ldif = q.data && !q.data.failure ? `# Not sent yet. Apply writes this to ${host}.\n${q.data.ldif}` : "";
  return (
    <div className="mb-5 flex flex-col gap-2">
      <h3 className="type-heading m-0">Pending changes</h3>
      {q.isPending && <Skeleton variant="text" rows={4} label="Writing the LDIF" />}
      {q.data?.failure && (
        <Banner tone="danger" title={q.data.failure.title}>
          {q.data.failure.message}
        </Banner>
      )}
      {ldif && <LdifView value={ldif} label="Pending changes as LDIF" />}
      <p className="m-0 text-[12px] leading-4 text-ink-muted">Passwords and binary values are never shown.</p>
    </div>
  );
}

interface AttributesProps {
  attrs: EntryAttribute[];
  pending: (name: string) => PendingAttr | undefined;
  canEdit: (a: EntryAttribute) => boolean;
  onEdit: (a: EntryAttribute) => void;
  onAdd?: () => void;
  onOpen: (dn: string) => void;
  onCopy: (a: EntryAttribute) => void;
}

const MARK: Record<string, string> = { edited: "Edited", added: "Added", removed: "Removed" };

function Attributes({ attrs, pending, canEdit, onEdit, onAdd, onOpen, onCopy }: AttributesProps) {
  const [showOps, setShowOps] = useState(false);
  const user = attrs.filter((a) => !a.operational);
  const ops = attrs.filter((a) => a.operational);
  const row = (a: EntryAttribute) => {
    const values = a.values ?? [];
    const isOc = /^objectclass$/i.test(a.name);
    const p = pending(a.name);
    const actions = (
      <div>
        {canEdit(a) && (
          <Tooltip content={`Edit ${a.name}`}>
            <Button variant="ghost" size="sm" icon="pencil" label={`Edit ${a.name}`} onClick={() => onEdit(a)} />
          </Tooltip>
        )}
        {a.kind !== "password" && a.kind !== "binary" && values.length > 0 && (
          <Tooltip content={`Copy ${a.name}`}>
            <Button variant="ghost" size="sm" icon="copy" label={`Copy ${a.name}`} onClick={() => onCopy(a)} />
          </Tooltip>
        )}
      </div>
    );
    if (p) {
      const removedAll = p.after.length === 0 && !p.password;
      return (
        <tr key={a.name} className="is-changed">
          <th scope="row" className="kn-attrs__name">
            <span>{a.name}</span>
            {a.required && <span className="kn-attrs__flag">required</span>}
          </th>
          <td className="kn-attrs__values">
            {cells(values, p).map((c, i) => (
              <div key={i} className="kn-attrs__cell">
                <div className="min-w-0">
                  <div
                    className={cx("kn-attrs__value", c.state === "removed" && "kn-attrs__removed", (a.kind === "binary" || a.kind === "password") && "kn-attrs__binary")}
                    title={c.value}
                  >
                    {c.value}
                  </div>
                  {c.was && (
                    <span className="kn-attrs__was">
                      was <code>{c.was}</code>
                    </span>
                  )}
                </div>
                {c.state !== "same" && (
                  <span className={cx("kn-attrs__mark", c.state === "removed" && "is-removed")}>{c.state === "removed" && removedAll ? "Deleted" : MARK[c.state]}</span>
                )}
              </div>
            ))}
          </td>
          <td className="kn-attrs__actions">{actions}</td>
        </tr>
      );
    }
    return (
      <tr key={a.name} className={cx(a.operational && "is-operational")}>
        <th scope="row" className="kn-attrs__name">
          <span>{a.name}</span>
          {a.required && <span className="kn-attrs__flag">required</span>}
        </th>
        <td className={cx("kn-attrs__values", isOc && "is-tags")}>
          {values.map((v, i) =>
            isOc ? (
              <Badge key={i} tone="heather" mono icon={false}>
                {v}
              </Badge>
            ) : a.kind === "dn" ? (
              <button key={i} type="button" className="kn-attrs__link" title={`Open ${v}`} onClick={() => onOpen(v)}>
                {v}
              </button>
            ) : a.kind === "binary" || a.kind === "password" ? (
              <div key={i} className="kn-attrs__binary">
                {v}
              </div>
            ) : (
              <div key={i} className="kn-attrs__value" title={v}>
                {v}
              </div>
            ),
          )}
        </td>
        <td className="kn-attrs__actions">{actions}</td>
      </tr>
    );
  };
  return (
    <div className="flex flex-col">
      <table className="kn-attrs" aria-label="Attributes">
        <thead>
          <tr>
            <th scope="col">Attribute</th>
            <th scope="col">Value</th>
            <th scope="col">
              <span className="kn-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{user.map(row)}</tbody>
        {showOps && ops.length > 0 && (
          <tbody>
            <tr>
              <th colSpan={3} className="kn-attrs__group">
                Operational
              </th>
            </tr>
            {ops.map(row)}
          </tbody>
        )}
      </table>
      <div className="flex min-h-8 items-center justify-between gap-2 px-1">
        {ops.length > 0 ? (
          <button type="button" className="kn-disclosure !text-[12px] !text-moss-ink" aria-expanded={showOps} onClick={() => setShowOps((v) => !v)}>
            {showOps ? "Hide operational attributes" : `Show ${plural(ops.length, "operational attribute")}`}
          </button>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-3">
          {onAdd && (
            <Button variant="ghost" size="sm" icon="plus" onClick={onAdd}>
              Add attribute
            </Button>
          )}
          <span className="type-label text-ink-muted">{plural(user.length, "attribute")}</span>
        </span>
      </div>
    </div>
  );
}

function RelatedList({ entries, onOpen }: { entries: RelatedEntry[]; onOpen: (dn: string) => void }) {
  return (
    <ul className="m-0 list-none overflow-hidden rounded-md border border-line bg-surface-raised p-0">
      {entries.map((g, i) => (
        <li key={g.dn} className={cx("flex min-h-10 items-center gap-2.5 px-3 py-1", i > 0 && "border-t border-line")}>
          <TypeTile type={g.type} size={24} />
          <span className="font-semibold">{g.name}</span>
          {g.description && <span className="truncate text-ink-muted">{g.description}</span>}
          <button type="button" className="kn-attrs__link ml-auto max-w-[50%] font-mono text-[12px]" title={`Open ${g.dn}`} onClick={() => onOpen(g.dn)}>
            {g.dn}
          </button>
        </li>
      ))}
    </ul>
  );
}

function MemberOf({ dn, onOpen }: { dn: string; onOpen: (dn: string) => void }) {
  const backend = useBackend();
  const { session, failed } = useBrowser();
  const id = session?.connectionId ?? "";
  const q = useQuery({
    queryKey: ["memberOf", id, dnKey(dn)],
    queryFn: async () => {
      const r = await backend.memberOf(id, dn);
      if (r.failure) failed(r.failure);
      return r;
    },
    staleTime: 30_000,
  });
  if (q.isPending) return <Skeleton variant="table" rows={3} label="Finding groups" />;
  const r = q.data!;
  if (r.failure && !r.failure.lost)
    return (
      <Banner tone="danger" title={r.failure.title}>
        {r.failure.message}
      </Banner>
    );
  const entries = r.entries ?? [];
  if (entries.length === 0)
    return (
      <EmptyState icon="users" tone="group" title="Not in any group">
        No group under <code>{session?.baseDn}</code> lists this entry in member, uniqueMember or memberUid.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <h3 className="type-heading m-0">
        Member of {plural(entries.length, "group")}
        {r.truncated && " (the first 1,000)"}
      </h3>
      <RelatedList entries={entries} onOpen={onOpen} />
    </div>
  );
}

function Members({ dns, onOpen }: { dns: string[]; onOpen: (dn: string) => void }) {
  if (dns.length === 0)
    return (
      <EmptyState icon="users" tone="group" title="No members">
        This group lists no member.
      </EmptyState>
    );
  const entries: RelatedEntry[] = dns.map((dn) => {
    const [, value] = rdnParts(splitDn(dn)[0] ?? dn);
    return { dn, name: value, type: /^uid=/i.test(dn) ? "person" : "entry", description: "" };
  });
  return (
    <div className="flex flex-col gap-3">
      <h3 className="type-heading m-0">{plural(entries.length, "member")}</h3>
      <RelatedList entries={entries} onOpen={onOpen} />
    </div>
  );
}
