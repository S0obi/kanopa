import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackend, type EntryAttribute, type EntryView, type SessionInfo } from "@/api/backend";
import { hostOf } from "@/features/connections/url";
import { parentDn, rdnParts, sameDn, splitDn } from "@/lib/dn";
import { plural } from "@/lib/time";
import { Badge, Banner, Button, DnBreadcrumb, EmptyState, LdifView, MenuButton, Skeleton, Tabs, Tooltip, TypeTile, cx, useToasts } from "@/ui";
import { cells, dropEntry, pendingOf, pendingView, toEntryChanges, undoDelete, undoRename, useChanges, valuesAfter, type ChangeSet, type PendingAttr } from "./changes";
import { DeleteDialog, MemberOfPanel, MembersPanel, NewEntryDialog, PendingState, RenameDialog } from "./shape";
import { AddAttributeDialog, ValueEditor, targetOf, type EditTarget } from "./editors";
import { useSettled } from "@/lib/settled";
import { useWindow } from "@/lib/useWindow";
import { dnKey, useBrowser } from "./store";

export function EntryPane() {
  const backend = useBackend();
  const { session, selected, select, reveal, failed, connection } = useBrowser();
  // Settled for a moment, so arrowing through the tree does not read every entry.
  const dn = useSettled(selected, 120);
  const id = session?.connectionId ?? "";
  // A new entry is not on the server yet: the view comes from the pending change.
  const created = useChanges((s) => (dn ? s.byConnection[id]?.[dnKey(dn)] : undefined));
  const isNew = created?.op === "add";

  const entry = useQuery({
    queryKey: ["entry", id, dn ? dnKey(dn) : ""],
    queryFn: async () => {
      const e = await backend.entry(id, dn!);
      if (e.failure) failed(e.failure);
      return e;
    },
    enabled: !!dn && !!session && connection === "connected" && !isNew,
    staleTime: 30_000,
  });

  const open = (target: string) => {
    select(target);
    void reveal(backend, target);
  };

  if (dn && isNew && session)
    return <Entry key={`new:${dn}`} entry={pendingView(created!)} session={session} editable={false} isNew onOpen={open} />;
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

interface EntryProps {
  entry: EntryView;
  session: SessionInfo;
  editable: boolean;
  /** A new entry, not on the server yet. */
  isNew?: boolean;
  onOpen: (dn: string) => void;
}

function Entry({ entry: e, session, editable: canWrite, isNew, onOpen }: EntryProps) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const id = session.connectionId;
  const pendingSet = useChanges((s) => s.byConnection[id]);
  const update = useChanges((s) => s.update);
  const select = useBrowser((s) => s.select);
  const expand = useBrowser((s) => s.expand);
  const node = useBrowser((s) => s.nodes[dnKey(e.dn)]?.node);
  const pendingEntry = pendingSet?.[dnKey(e.dn)];
  const deleted = pendingEntry?.op === "delete";
  // Attributes can't change on an entry marked for deletion.
  const editable = canWrite && !deleted;
  const isGroup = e.type === "group";
  // A new entry's view already holds its pending values.
  const attrs = isNew ? (e.attributes ?? []) : withAdded(e, pendingSet);
  // A group lists its members in member or uniqueMember (DNs), and a posixGroup in memberUid (uids).
  const members = attrs
    .filter((a) => /^(member|uniqueMember|memberUid)$/i.test(a.name))
    .flatMap((a) => valuesAfter(a.values ?? [], pendingOf(pendingSet, e.dn, a.name))).length;
  const [dialog, setDialog] = useState<"new" | "rename" | "delete" | null>(null);
  const root = sameDn(e.dn, session.baseDn) || (session.namingContexts ?? []).some((nc) => sameDn(nc, e.dn));
  const container = e.type === "root" || e.type === "ou";
  const multiRdn = (splitDn(e.dn)[0] ?? "").replace(/\\./g, "").includes("+");
  const hasChildren = !!node?.hasChildren;
  const renameOff = !canWrite || isNew || deleted || root || multiRdn || hasChildren || e.type === "server" && !node;
  const deleteOff = !canWrite || isNew || deleted || root;
  const relTab = isGroup ? "members" : "memberOf";
  const storedTab = useBrowser((s) => s.tab);
  const setTab = useBrowser((s) => s.setTab);
  const tab = storedTab === "attributes" || storedTab === "ldif" || storedTab === relTab ? storedTab : "attributes";
  const [editing, setEditing] = useState<EditTarget | null>(null);
  // The tree's menu asks for a dialog, or the member picker, on this entry.
  const request = useBrowser((s) => s.request);
  const took = useBrowser((s) => s.took);
  const [picking, setPicking] = useState(0);
  useEffect(() => {
    if (!request || !sameDn(request.dn, e.dn)) return;
    took();
    // A one-shot request from the store (the tree's menu), taken once: not derivable in render.
    if (request.action === "addMember") {
      setTab("members");
      // oxlint-disable-next-line react/set-state-in-effect -- see above
      setPicking((n) => n + 1);
      // oxlint-disable-next-line react/set-state-in-effect -- see above
    } else setDialog(request.action);
  }, [request, e.dn, took, setTab]);
  const [adding, setAdding] = useState(false);
  const rdnAttr = rdnParts(splitDn(e.dn)[0] ?? "")[0].replace(/=$/, "").toLowerCase();
  const canEdit = (a: EntryAttribute) =>
    editable && !e.referral && e.type !== "server" && !a.operational && !/^objectclass$/i.test(a.name) && a.name.toLowerCase() !== rdnAttr;

  const copy = async (text: string, what: string) => {
    try {
      await backend.copyText(text);
      toast(`Copied ${what}.`);
    } catch {
      toast(`Kanopa couldn't copy ${what}.`, "danger");
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
          <div className="flex items-center gap-2">
            {canWrite && container && !isNew && !deleted && (
              <Button variant="primary" icon="plus" onClick={() => setDialog("new")}>
                New entry
              </Button>
            )}
            <Button icon="copy" onClick={() => void copy(e.dn, "the DN")}>
              Copy DN
            </Button>
            {canWrite && !isNew && (
              <MenuButton
                label="More entry actions"
                items={[
                  { id: "rename", label: hasChildren ? "Rename… (entries below it)" : "Rename…", icon: "pencil", disabled: renameOff },
                  { separator: true },
                  { id: "delete", label: "Delete entry…", icon: "trash", danger: true, disabled: deleteOff },
                ]}
                // The menu gives focus back to its button as it closes: open the dialog after that.
                onSelect={(item) => setTimeout(() => setDialog(item === "rename" ? "rename" : "delete"), 0)}
              />
            )}
          </div>
        </div>
        <DnBreadcrumb dn={e.dn} onNavigate={onOpen} className="self-start rounded-sm border border-line bg-surface-raised p-[3px]" />
        <PendingState
          id={id}
          dn={e.dn}
          onUndo={(what) =>
            update(id, (s) => (what === "add" ? dropEntry(s, e.dn) : what === "delete" ? undoDelete(s, e.dn) : undoRename(s, e.dn)))
          }
        />
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
            ...(isNew ? [] : [isGroup ? { id: "members", label: "Members", count: members } : { id: "memberOf", label: "Member of" }]),
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "attributes" && (
          <Attributes
            attrs={attrs}
            pending={(name) => (isNew ? undefined : pendingOf(pendingSet, e.dn, name))}
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
        {tab === relTab && !isNew &&
          (isGroup ? <MembersPanel id={id} group={e} editable={editable} onOpen={onOpen} picking={picking} /> : <MemberOfPanel id={id} entry={e} editable={editable} onOpen={onOpen} />)}
      </div>
      {editing && <ValueEditor connectionId={id} entry={e} target={editing} session={session} onClose={() => setEditing(null)} />}
      {adding && <AddAttributeDialog connectionId={id} entry={e} session={session} onClose={() => setAdding(false)} />}
      {dialog === "new" && (
        <NewEntryDialog
          id={id}
          session={session}
          parent={e.dn}
          onClose={() => setDialog(null)}
          onCreated={(dn) => {
            void expand(backend, parentDn(dn));
            select(dn);
          }}
        />
      )}
      {dialog === "rename" && <RenameDialog id={id} entry={e} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog id={id} entry={e} host={hostOf(session.url)} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** The pending changes of the connection, as the LDIF Apply sends. */
function PendingLdif({ connectionId, set, host }: { connectionId: string; set: ChangeSet; host: string }) {
  const backend = useBackend();
  const changes = toEntryChanges(set, { preview: true });
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

/** Values shown before an attribute with many collapses behind "Show all". */
const COLLAPSED = 25;
/** The most changed values the attribute table lists for one attribute; the LDIF tab has every one. */
const CHANGED_SHOWN = 200;

/**
 * Of a changed attribute's values, those that changed. A long attribute (a group's 5,000 members)
 * does not list the thousands that did not change, or draw more than CHANGED_SHOWN that did.
 */
function changedCells<T extends { state: string }>(all: T[]): { shown: T[]; hidden: number } {
  const list = all.length > COLLAPSED ? all.filter((c) => c.state !== "same") : all;
  const shown = list.slice(0, CHANGED_SHOWN);
  return { shown, hidden: all.length > COLLAPSED ? all.length - shown.length : 0 };
}

/** An attribute's values, one line each; past 25 only the first show until "Show all", and then only the lines in view are drawn. */
function ValueLines({ name, values, kind, onOpen }: { name: string; values: string[]; kind: string; onOpen: (dn: string) => void }) {
  const [all, setAll] = useState(false);
  const big = values.length > COLLAPSED;
  const shown = big && !all ? values.slice(0, COLLAPSED) : values;
  const { attach, start, end, before, after, windowed } = useWindow<HTMLDivElement>(shown.length, 20, { threshold: 100 });
  return (
    <>
      <div ref={attach} style={windowed ? { paddingTop: before, paddingBottom: after } : undefined}>
        {shown.slice(start, end).map((v, k) =>
          kind === "dn" ? (
            <button key={start + k} type="button" className="kn-attrs__link" title={`Open ${v}`} onClick={() => onOpen(v)}>
              {v}
            </button>
          ) : kind === "binary" || kind === "password" ? (
            <div key={start + k} className="kn-attrs__binary">
              {v}
            </div>
          ) : (
            <div key={start + k} className="kn-attrs__value" title={v}>
              {v}
            </div>
          ),
        )}
      </div>
      {big && (
        <button type="button" className="kn-disclosure !text-[12px] !text-moss-ink" aria-expanded={all} aria-label={all ? `Show fewer ${name} values` : `Show all ${values.length.toLocaleString("en-US")} ${name} values`} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${values.length.toLocaleString("en-US")}`}
        </button>
      )}
    </>
  );
}

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
      const changed = changedCells(cells(values, p));
      return (
        <tr key={a.name} className="is-changed">
          <th scope="row" className="kn-attrs__name">
            <span>{a.name}</span>
            {a.required && <span className="kn-attrs__flag">required</span>}
          </th>
          <td className="kn-attrs__values">
            {changed.shown.map((c, i) => (
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
            {changed.hidden > 0 && <div className="kn-attrs__more-note">{changed.hidden.toLocaleString("en-US")} more values not shown here; the LDIF tab has them all.</div>}
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
          {isOc ? (
            values.map((v, i) => (
              <Badge key={i} tone="heather" mono icon={false}>
                {v}
              </Badge>
            ))
          ) : (
            <ValueLines name={a.name} values={values} kind={a.kind} onOpen={onOpen} />
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
