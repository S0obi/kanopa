import { useEffect, useId, useRef, useState } from "react";
import { errorText, useBackend, type ExportStatus, type Failure, type SessionInfo } from "@/api/backend";
import { lineage, rdnParts, sameDn, splitDn } from "@/lib/dn";
import { plural } from "@/lib/time";
import { Banner, Checkbox, Dialog, TypeTile, useToasts } from "@/ui";
import { useChanges, type ChangeSet } from "./changes";

const POLL_MS = 250;

/**
 * The name the Save dialog suggests: the entry's first RDN value, with what Windows forbids in a file name
 * replaced by "_" (people for ou=people,dc=example), or "export" when nothing usable is left.
 */
export function exportFileName(dn: string): string {
  const rdn = splitDn(dn)[0] ?? "";
  const value = rdnParts(rdn)[1].replace(/\\([^0-9A-Fa-f])/g, "$1").replace(/\\[0-9A-Fa-f]{2}/g, "_");
  let name = value
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100);
  if (!name || /^_+$/.test(name)) name = "export";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return `${name}.ldif`;
}

/** Whether a pending change touches the exported entry, or (with subtree) anything below it. */
function touched(set: ChangeSet | undefined, dn: string, subtree: boolean): boolean {
  return Object.values(set ?? {}).some((p) => (subtree ? lineage(p.dn).some((a) => sameDn(a, dn)) : sameDn(p.dn, dn)));
}

type Phase = "options" | "running" | "done";

/** One tile of the scope choice, in the style of the New entry types: a tile icon, a title and a line of explanation. */
function ScopeTile({ type, title, description, pressed, onClick }: { type: string; title: string; description: string; pressed: boolean; onClick: () => void }) {
  const descId = useId();
  return (
    <button type="button" className="kn-new__type" aria-pressed={pressed} aria-label={title} aria-describedby={descId} onClick={onClick}>
      <TypeTile type={type} size={24} />
      <span className="flex flex-col items-start">
        <span className="font-semibold">{title}</span>
        <span className="kn-new__desc" id={descId}>
          {description}
        </span>
      </span>
    </button>
  );
}

/**
 * Export LDIF: what to write (the entry, or the entry and everything below it), whether to include password
 * hashes and secrets (never by default), then the native Save dialog, a running count and a result. The
 * file is written by Go, a page at a time; Cancel removes what it had written.
 */
export function ExportDialog({ connectionId, entry, session, onClose }: { connectionId: string; entry: { dn: string; title: string }; session: SessionInfo; onClose: () => void }) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const pending = useChanges((s) => s.byConnection[connectionId]);
  const [scope, setScope] = useState<"entry" | "subtree">("entry");
  const [secrets, setSecrets] = useState(false);
  const [phase, setPhase] = useState<Phase>("options");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<Failure | string | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const job = useRef("");

  // While the export runs, ask Go how far it is.
  useEffect(() => {
    if (phase !== "running") return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const s = await backend.exportProgress(job.current);
        if (stopped) return;
        setStatus(s);
        if (s.state === "canceled") {
          clearInterval(t);
          toast("Export canceled. No file was written.", "neutral");
          onClose();
        } else if (s.state !== "running") {
          clearInterval(t);
          setPhase("done");
        }
      } catch (e) {
        if (stopped) return;
        clearInterval(t);
        setStatus((s) => ({ ...(s as ExportStatus), state: "failed", failure: { title: "Export stopped.", message: errorText(e), code: 0, lost: false } }));
        setPhase("done");
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, backend]);

  async function start() {
    setProblem(null);
    setStarting(true);
    try {
      const path = await backend.chooseExportFile(exportFileName(entry.dn));
      if (!path) return; // the person changed their mind in the Save dialog
      const s = await backend.startExport(connectionId, entry.dn, path, { subtree: scope === "subtree", secrets });
      if (s.failure) {
        setProblem(s.failure);
        return;
      }
      job.current = s.job;
      setStatus(s);
      setPhase("running");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setStarting(false);
    }
  }

  function cancel() {
    if (phase === "running") void backend.cancelExport(job.current);
    else onClose();
  }

  async function reveal(path: string) {
    try {
      await backend.showInFolder(path);
    } catch (e) {
      toast(errorText(e), "danger");
    }
  }

  const description = (
    <>
      {entry.title} · <code className="kn-changes__dn">{entry.dn}</code>
    </>
  );

  if (phase === "running") {
    const n = status?.written ?? 0;
    return (
      <Dialog
        title="Exporting…"
        description={description}
        onClose={cancel}
        width={520}
        secondaryAction={{ label: "Cancel", onClick: cancel }}
      >
        <div className="flex flex-col gap-2" role="status">
          <progress className="h-1.5 w-full" aria-label="Writing the file" />
          <span className="text-[13px] text-ink-muted">{plural(n, "entry", "entries")} written</span>
        </div>
      </Dialog>
    );
  }

  if (phase === "done" && status) {
    const failed = status.state === "failed";
    const referrals = status.referrals ?? [];
    return (
      <Dialog
        title={failed ? "Export failed" : status.incomplete ? "Export incomplete" : "Export done"}
        description={description}
        onClose={onClose}
        width={560}
        secondaryAction={{ label: "Close", onClick: onClose }}
        primaryAction={failed ? undefined : { label: "Show in folder", onClick: () => void reveal(status.path) }}
      >
        <div className="flex flex-col gap-3">
          {failed ? (
            <Banner tone="danger" title={status.failure?.title ?? "Couldn't export."}>
              {status.failure?.message} No file was written.
            </Banner>
          ) : (
            <>
              <Banner tone={status.incomplete ? "warning" : "success"} title={status.incomplete ? "Incomplete" : `${plural(status.written, "entry", "entries")} exported.`}>
                {status.incomplete && (
                  <p className="m-0">
                    {`${status.reason.charAt(0).toUpperCase()}${status.reason.slice(1)}. The file keeps the ${plural(status.written, "entry", "entries")} it got, and ends with a comment that says so.`}
                  </p>
                )}
                <p className="m-0">
                  Saved to <code className="kn-changes__dn">{status.path}</code>
                </p>
              </Banner>
              {status.outOfOrder && (
                <Banner tone="warning" title="Order not guaranteed.">
                  Some entries come before their parent. Import tools that need parents first may need the entries sorted.
                </Banner>
              )}
              {referrals.length > 0 && (
                <Banner tone="info" title={`${plural(referrals.length, "referral")} not followed.`}>
                  <ul className="m-0 list-none p-0">
                    {referrals.map((r) => (
                      <li key={r}>
                        <code className="kn-changes__dn">{r}</code>
                      </li>
                    ))}
                  </ul>
                </Banner>
              )}
            </>
          )}
        </div>
      </Dialog>
    );
  }

  const subtree = scope === "subtree";
  return (
    <Dialog
      title="Export LDIF"
      description={description}
      onClose={onClose}
      width={560}
      footerStart={<span className="text-[12px] leading-4 text-ink-muted">Reads from the server. Nothing is changed.</span>}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Choose file…", onClick: () => void start(), busy: starting }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="type-label" id="export-scope">
            What to export
          </span>
          <div role="group" aria-labelledby="export-scope" className="kn-new__types kn-new__types--two">
            <ScopeTile type="entry" title="This entry" description="Just this one, with its attributes." pressed={scope === "entry"} onClick={() => setScope("entry")} />
            <ScopeTile type="ou" title="Entry and everything below" description="The whole branch, page by page." pressed={scope === "subtree"} onClick={() => setScope("subtree")} />
          </div>
        </div>
        <Checkbox
          checked={secrets}
          onChange={(e) => setSecrets(e.target.checked)}
          label={
            <span className="flex flex-col">
              <span>Include password hashes and secrets</span>
              <span className="text-[12px] leading-4 text-ink-muted">Left out unless you tick this. Anyone with the file can try to crack the hashes.</span>
            </span>
          }
        />
        {touched(pending, entry.dn, subtree) && (
          <Banner tone="info" title="Pending changes aren't included.">
            The file holds what the server has now, not your unapplied changes.
          </Banner>
        )}
        {session.paging === false && (
          <Banner tone="info" title="This server doesn't offer paged results.">
            A size limit on the server may cut a long export short. The file will say so if it does.
          </Banner>
        )}
        {problem && (
          <Banner tone="danger" title={typeof problem === "string" ? "Couldn't start the export." : problem.title}>
            {typeof problem === "string" ? problem : problem.message}
          </Banner>
        )}
      </form>
    </Dialog>
  );
}
