import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorText, useBackend, type Failure, type SessionInfo } from "@/api/backend";
import { splitDn } from "@/lib/dn";
import { detectPlatform, isMod } from "@/lib/platform";
import { Banner, Button, ConfirmDialog, Kbd, useToasts } from "@/ui";
import { summarize, toEntryChanges, useChanges } from "./changes";
import { useBrowser } from "./store";

const changesText = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;
export const hostOf = (url: string) => url.replace(/^ldaps?:\/\//i, "").replace(/:\d+$/, "");

export interface ApplyFailure {
  failure: Failure;
  dn: string; // the entry that was refused, "" for the connection
  applied: number; // changes written before the failure
}

/**
 * Apply, Discard and their state for one connection. Apply sends the whole set; entries the
 * server took leave the set, the refused one and those after it stay pending.
 */
export function useApplyChanges(session: SessionInfo) {
  const backend = useBackend();
  const qc = useQueryClient();
  const toast = useToasts((s) => s.show);
  const { connection, failed, reload } = useBrowser();
  const id = session.connectionId;
  const set = useChanges((s) => s.byConnection[id]);
  const { applied, discard: drop } = useChanges();
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<ApplyFailure | null>(null);
  const summary = summarize(set);
  const host = hostOf(session.url);

  async function apply() {
    if (!set || summary.count === 0 || connection !== "connected" || applying) return;
    setApplying(true);
    setFailure(null);
    try {
      const r = await backend.apply(id, toEntryChanges(set));
      const done = (r.results ?? []).filter((x) => x.ok).map((x) => x.dn);
      const count = done.reduce((n, dn) => n + (Object.values(set).find((e) => e.dn === dn)?.attrs.length ?? 0), 0);
      applied(id, done);
      if (done.length) {
        await qc.invalidateQueries({ queryKey: ["entry", id] });
        void reload(backend);
      }
      const refused = (r.results ?? []).find((x) => !x.ok);
      const f = r.failure ?? refused?.failure ?? null;
      if (f) {
        if (f.lost) failed(f);
        setFailure({ failure: f, dn: refused?.dn ?? "", applied: count });
      } else {
        toast(`Saved ${changesText(count)} to ${host}.`);
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

  return { set, summary, applying, failure, dismissFailure: () => setFailure(null), apply, discard, host };
}

/** The danger banner after a refused Apply: the server's words, and that the changes are kept. */
export function ApplyFailureBanner({ f, pending, onDismiss }: { f: ApplyFailure; pending: number; onDismiss: () => void }) {
  const rdn = f.dn ? splitDn(f.dn)[0] : "";
  const parts = [f.failure.message];
  if (f.applied > 0) parts.push(`${changesText(f.applied)} before it ${f.applied === 1 ? "was" : "were"} saved.`);
  if (pending > 0) parts.push(`Your ${pending} pending ${pending === 1 ? "change is" : "changes are"} kept.`);
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
  onReview: () => void;
  onDiscard: () => void;
  onApply: () => void;
}

/** ChangesBar: count, summary, Review LDIF, Discard, Apply (mod+S). */
export function ChangesBar({ count, summary, connected, applying, onReview, onDiscard, onApply }: BarProps) {
  const platform = detectPlatform();
  return (
    <div role="region" aria-label="Pending changes" className="kn-changes kn-changes--docked">
      <span className="kn-changes__count" aria-hidden="true">
        {count}
      </span>
      <span className="kn-changes__text">
        <b>{summary}.</b> {connected ? "Nothing is sent until you apply." : "Reconnect to apply them."}
      </span>
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
