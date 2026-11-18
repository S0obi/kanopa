import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorText, useBackend, type Failure, type SessionInfo } from "@/api/backend";
import { hostOf } from "@/features/connections/url";
import { parentDn, sameDn, splitDn } from "@/lib/dn";
import { detectPlatform, isMod } from "@/lib/platform";
import { Banner, Button, ConfirmDialog, Icon, Kbd, MenuButton, useToasts } from "@/ui";
import { buildChanges, generatedPasswords, summarize, useChanges, type IssuedPassword } from "./changes";
import { clipboardNote, useSecretCopy } from "./secret";
import { useBrowser } from "./store";

const changesText = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/** A new password Kanopa generated, as the Applied notice lists it: the password is gone when the person was not changed. */
export interface IssuedPerson {
  dn: string;
  name: string;
  password: string | null;
  error?: string;
}

/** What the Applied notice shows: who got a generated password, and how many changes went through. */
export interface Issued {
  people: IssuedPerson[];
  applied: number;
  total: number;
}

/** How long Kanopa keeps applied passwords for the notice, if it is never closed. */
const FORGET_AFTER_MS = 5 * 60_000;

interface ApplyFailure {
  failure: Failure;
  dn: string; // the entry that was refused, "" for the connection
  applied: number; // changes written before the failure
  /** The refused entry carried a password Kanopa generated. */
  generated?: boolean;
}

/**
 * Apply, Discard and their state for one connection. Apply sends the whole set; entries the
 * server took leave the set, the refused one and those after it stay pending.
 */
export function useApplyChanges(session: SessionInfo) {
  const backend = useBackend();
  const qc = useQueryClient();
  const toast = useToasts((s) => s.show);
  const { connection, failed, patchNodes, refresh, select, forget } = useBrowser();
  const id = session.connectionId;
  const set = useChanges((s) => s.byConnection[id]);
  const { applied, discard: drop } = useChanges();
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<ApplyFailure | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const summary = summarize(set);
  const host = hostOf(session.url);

  // The notice keeps the passwords only for a while, whether or not it is closed.
  useEffect(() => {
    if (!issued) return;
    const t = setTimeout(() => setIssued(null), FORGET_AFTER_MS);
    return () => clearTimeout(t);
  }, [issued]);

  async function apply() {
    if (!set || summary.count === 0 || connection !== "connected" || applying) return;
    setApplying(true);
    setFailure(null);
    try {
      const { changes, parts } = buildChanges(set);
      const generated = generatedPasswords(set);
      const r = await backend.apply(id, changes);
      const ok = (r.results ?? []).filter((x) => x.ok);
      const done = ok.map((x) => parts[x.index]).filter(Boolean);
      const count = done.reduce((n, p) => n + (p.part === "modify" ? p.attrs.length : 1), 0);
      applied(id, done);
      if (done.length) {
        // Deleted entries, and renamed ones under their old DN, are gone from the tree.
        forget(ok.filter((x) => x.op === "delete" || x.op === "rename").map((x) => changes[x.index].dn));
        patchNodes(ok.flatMap((x) => (x.node ? [x.node] : [])));
        // An add, delete or rename changes its parent's list of children: read those again.
        const parents = [...new Set(ok.filter((x) => x.op !== "modify").map((x) => parentDn(x.dn)))];
        // oxlint-disable-next-line no-await-in-loop -- one paged search at a time on the connection
        for (const p of parents) await refresh(backend, p);
        // Follow a renamed entry; leave a deleted one for its parent.
        const selected = useBrowser.getState().selected;
        for (const x of ok) {
          const from = changes[x.index].dn;
          if (!selected || !sameDn(selected, from)) continue;
          if (x.op === "rename") select(x.dn);
          if (x.op === "delete") select(parentDn(from));
        }
        await qc.invalidateQueries({ queryKey: ["entry", id] });
        await qc.invalidateQueries({ queryKey: ["memberOf", id] });
        await qc.invalidateQueries({ queryKey: ["referrers", id] });
      }
      const refused = (r.results ?? []).find((x) => !x.ok);
      const f = r.failure ?? refused?.failure ?? null;
      // Who got a password Kanopa generated: the Applied notice lists them, once, with a Copy each.
      const results = r.results ?? [];
      const people = generated.flatMap((g): IssuedPerson[] => {
        const mine = results.filter((x) => sameDn(changes[x.index].dn, g.dn));
        if (mine.some((x) => x.ok) && !mine.some((x) => !x.ok)) return [{ dn: g.dn, name: g.name, password: g.password }];
        const bad = mine.find((x) => !x.ok);
        return bad ? [{ dn: g.dn, name: g.name, password: null, error: bad.failure?.message ?? "" }] : [];
      });
      const issuedNow = people.some((p) => p.password !== null);
      setIssued(issuedNow ? { people, applied: count, total: summary.count } : null);
      if (f) {
        if (f.lost) failed(f);
        setFailure({ failure: f, dn: refused?.dn ?? "", applied: count, generated: !!refused && generated.some((g) => sameDn(g.dn, refused.dn)) });
      } else {
        if (!issuedNow) toast(`Saved ${changesText(count)} to ${host}.`);
      }
    } catch (e) {
      setFailure({ failure: { title: "Apply failed.", message: errorText(e), code: 0, lost: false }, dn: "", applied: 0 });
    } finally {
      setApplying(false);
    }
  }

  function discard() {
    drop(id);
    setFailure(null);
    toast(`Discarded ${changesText(summary.count)}. Entries are as the server has them.`);
  }

  return { set, summary, applying, failure, dismissFailure: () => setFailure(null), issued, dismissIssued: () => setIssued(null), apply, discard, host };
}

/** The danger banner after a refused Apply: the server's words, and that the changes are kept. */
export function ApplyFailureBanner({ f, pending, onDismiss }: { f: ApplyFailure; pending: number; onDismiss: () => void }) {
  const rdn = f.dn ? splitDn(f.dn)[0] : "";
  const parts = [f.failure.message];
  if (f.applied > 0) parts.push(`${changesText(f.applied)} before it ${f.applied === 1 ? "was" : "were"} saved.`);
  if (pending > 0) parts.push(`Your ${pending} pending ${pending === 1 ? "change is" : "changes are"} kept.`);
  if (f.generated) parts.push("Kanopa generated this password. The server's rules may need something else: type one, or generate another.");
  return (
    <Banner tone="danger" title={rdn ? `${f.failure.title} ${rdn} was not changed.` : f.failure.title} onDismiss={onDismiss}>
      {parts.join(" ")}
    </Banner>
  );
}

interface BarProps {
  count: number;
  summary: string;
  connected: boolean;
  applying: boolean;
  /** Passwords Kanopa generated that wait to be applied: the person can copy them until then. */
  passwords: IssuedPassword[];
  onReview: () => void;
  onDiscard: () => void;
  onApply: () => void;
}

/** ChangesBar: count, summary, Review LDIF, Discard, Apply (mod+S). */
export function ChangesBar({ count, summary, connected, applying, passwords, onReview, onDiscard, onApply }: BarProps) {
  const secret = useSecretCopy();
  const toast = useToasts((s) => s.show);
  const copyOf = async (p: IssuedPassword) => {
    if (await secret.copy(p.password)) toast(`Copied the password for ${p.name}. It clears from the clipboard in 60 s.`);
  };
  const platform = detectPlatform();
  return (
    <div role="region" aria-label="Pending changes" className="kn-changes kn-changes--docked">
      <span className="kn-changes__count" aria-hidden="true">
        {count}
      </span>
      <span className="kn-changes__text">
        <b>{summary}.</b> {connected ? "Nothing is sent until you apply." : "Reconnect to apply them."}
      </span>
      {passwords.length === 1 && (
        <Button variant="ghost" icon={secret.left > 0 ? "check" : "copy"} onClick={() => void copyOf(passwords[0]!)}>
          Copy password
        </Button>
      )}
      {passwords.length > 1 && (
        <MenuButton
          label="Copy a new password"
          icon="copy"
          items={passwords.map((p) => ({ id: p.dn, label: `Copy password for ${p.name}` }))}
          onSelect={(dn) => {
            const p = passwords.find((x) => x.dn === dn);
            if (p) void copyOf(p);
          }}
        />
      )}
      <Button variant="ghost" onClick={onReview}>
        Review LDIF
      </Button>
      <div className="kn-changes__actions">
        <Button onClick={onDiscard} disabled={applying}>
          Discard
        </Button>
        <Button variant="primary" busy={applying} disabled={!connected} onClick={onApply}>
          Apply
          <Kbd keys={["mod", "s"]} platform={platform} className="kn-kbd--on-moss" />
        </Button>
      </div>
    </div>
  );
}

/** mod+S applies, unless a dialog is open. */
export function useApplyShortcut(onApply: () => void) {
  const platform = detectPlatform();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isMod(e, platform) || e.key.toLowerCase() !== "s" || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (document.querySelector('[aria-modal="true"]')) return;
      onApply();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

/** Asks before something would drop pending changes: Disconnect, or closing the window. */
export function DropChangesDialog({ what, count, host, onConfirm, onCancel }: { what: "disconnect" | "close"; count: number; host: string; onConfirm: () => void; onCancel: () => void }) {
  const title = what === "disconnect" ? "Disconnect with pending changes?" : "Close Kanopa with pending changes?";
  return (
    <ConfirmDialog tone="warning" title={title} confirmLabel={what === "disconnect" ? "Discard and disconnect" : "Discard and close"} onConfirm={onConfirm} onCancel={onCancel}>
      {count === 1 ? "1 change was" : `${count} changes were`} not applied{host ? ` to ${host}` : ""}. {what === "disconnect" ? "Disconnecting" : "Closing"} drops{" "}
      {count === 1 ? "it" : "them"}.
    </ConfirmDialog>
  );
}

/**
 * The notice after an Apply that set passwords Kanopa generated: the last chance to copy them, one
 * Copy per person. It stays until it is closed (Kanopa forgets the passwords after five minutes
 * either way), and a person the server refused is listed as not changed, with no Copy.
 */
export function AppliedNotice({ issued, host, onClose }: { issued: Issued; host: string; onClose: () => void }) {
  const secret = useSecretCopy();
  const [who, setWho] = useState("");
  const partly = issued.applied < issued.total;
  const copy = async (p: IssuedPerson) => {
    if (await secret.copy(p.password!)) setWho(p.dn);
  };
  return (
    <div role="status" className="kn-applied">
      <div className="kn-applied__head">
        <Icon name={partly ? "warning" : "success"} size={16} className={partly ? "text-warning-ink" : "text-success-ink"} />
        <div className="kn-applied__title">
          <b>{partly ? `Applied ${issued.applied} of ${issued.total} changes to ${host}` : `Applied ${changesText(issued.applied)} to ${host}`}</b>
          <span>
            {partly
              ? "Kanopa forgets the passwords when this notice closes."
              : issued.people.length === 1
                ? `${issued.people[0]!.name} has a new password. Kanopa forgets it when this notice closes.`
                : "Kanopa forgets these passwords when this notice closes."}
          </span>
        </div>
        <Button variant="ghost" size="sm" icon="x" label="Close notice" onClick={onClose} />
      </div>
      <ul className="kn-applied__list">
        {issued.people.map((p) => (
          <li key={p.dn}>
            <span className="kn-applied__who">
              {p.name}
              {p.password === null && <span className="kn-applied__error">Not changed. {p.error}</span>}
            </span>
            {p.password !== null && (
              <Button size="sm" icon={secret.left > 0 && who === p.dn ? "check" : "copy"} aria-label={`${secret.left > 0 && who === p.dn ? "Copied" : "Copy"} password for ${p.name}`} onClick={() => void copy(p)}>
                {secret.left > 0 && who === p.dn ? "Copied" : "Copy password"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <span className="kn-applied__note">{secret.left > 0 ? clipboardNote(secret.left) : "Copy a password now: this is the last time Kanopa has it."}</span>
    </div>
  );
}
