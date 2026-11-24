import { useEffect, useState, type ReactNode } from "react";
import { errorText, useBackend } from "@/api/backend";
import { pendingEntries, useChanges } from "@/features/browser/changes";
import { useUpdates } from "@/stores/updates";
import { Banner, Button, Dialog, Icon, useToasts } from "@/ui";
import type { IconName } from "@/ui/icons";

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 700;

/**
 * Keeps the update status fresh (the Go side checks at start and every day, and a check by hand
 * finishes later), asks once whether to keep Kanopa up to date, and shows the banner.
 */
export function Updates() {
  const backend = useBackend();
  const status = useUpdates((s) => s.status);
  const refresh = useUpdates((s) => s.refresh);
  const busy = status?.state === "checking" || status?.state === "downloading";

  useEffect(() => {
    void refresh(backend);
    const t = setInterval(() => void refresh(backend), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(t);
  }, [backend, refresh, busy]);

  if (!status?.supported) return null;
  return status.asked ? <UpdateBanner /> : <UpdateQuestion selfUpdate={status.selfUpdate} />;
}

/** The one question, asked once: check for new versions by itself, or not. */
function UpdateQuestion({ selfUpdate }: { selfUpdate: boolean }) {
  const backend = useBackend();
  const set = useUpdates((s) => s.set);
  const toast = useToasts((s) => s.show);
  const [saving, setSaving] = useState(false);

  async function answer(on: boolean) {
    setSaving(true);
    try {
      set(await backend.setAutoUpdate(on));
    } catch (e) {
      toast(errorText(e), "danger");
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Keep Kanopa up to date?"
      description={selfUpdate ? "Kanopa can download new versions in the background and install them when you choose." : "Kanopa can tell you when a new version is out."}
      width={560}
      secondaryAction={{ label: "Not now", onClick: () => void answer(false), disabled: saving }}
      primaryAction={{ label: selfUpdate ? "Check automatically" : "Tell me about updates", onClick: () => void answer(true), busy: saving }}
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0 text-[13px]">
        <Point icon="clock">Checks when Kanopa starts, then once a day.</Point>
        <Point icon="refresh">{selfUpdate ? "Downloads quietly. Nothing installs until you press Restart to update." : "Shows a notice with a Download button."}</Point>
        <Point icon="shield">
          Sends only a plain request to <code>api.github.com</code>. Nothing about you or your directory.
        </Point>
      </ul>
      <p className="mt-3 mb-0 text-[12px] text-ink-muted">Downloads are checked against the release's checksum. Change this any time in the app menu.</p>
    </Dialog>
  );
}

/** One line of the question: a small moss icon and a short sentence. */
function Point({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0" style={{ color: "var(--moss-ink)" }} aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span>{children}</span>
    </li>
  );
}

/** One line above the screen, in the style of the other banners: what is happening and the one thing to do. */
function UpdateBanner() {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const status = useUpdates((s) => s.status);
  const byHand = useUpdates((s) => s.byHand);
  const dismissed = useUpdates((s) => s.dismissed);
  const dismiss = useUpdates((s) => s.dismiss);
  const pending = useChanges(pendingEntries);
  const [restarting, setRestarting] = useState(false);
  if (!status) return null;
  const { state, version, current } = status;
  if (dismissed === `${state}:${version}`) return null;

  async function restart() {
    setRestarting(true);
    try {
      await backend.restartToUpdate();
    } catch (e) {
      toast(errorText(e), "danger");
      setRestarting(false);
    }
  }
  const openPage = () => void backend.openReleasesPage().catch((e) => toast(errorText(e), "danger"));
  const wrap = "px-3 pt-3";

  switch (state) {
    case "checking":
      return byHand ? (
        <div className={wrap}>
          <Banner busy title="Checking for updates…" />
        </div>
      ) : null;
    case "uptodate":
      return byHand ? (
        <div className={wrap}>
          <Banner tone="success" title="Kanopa is up to date." onDismiss={dismiss}>
            You have {current}, the latest version.
          </Banner>
        </div>
      ) : null;
    case "downloading":
      return (
        <div className={wrap}>
          <Banner busy title={`Downloading Kanopa ${version}`}>
            <progress className="h-1.5 w-48 align-middle" aria-label="Download progress" value={status.percent} max={100} /> <span className="tabular-nums">{status.percent}%</span> You can keep working.
          </Banner>
        </div>
      );
    case "ready":
      return pending > 0 ? (
        <div className={wrap}>
          <Banner tone="warning" title={`Kanopa ${version} is ready.`} onDismiss={dismiss} actions={<Button variant="primary" disabled>Restart to update</Button>}>
            Apply or discard your {pending === 1 ? "pending change" : `${pending} pending changes`} first, then restart to update.
          </Banner>
        </div>
      ) : (
        <div className={wrap}>
          <Banner tone="success" title={`Kanopa ${version} is ready.`} onDismiss={dismiss} actions={<Button variant="primary" busy={restarting} onClick={() => void restart()}>Restart to update</Button>}>
            Restart to finish the update. Your saved connections are kept.
          </Banner>
        </div>
      );
    case "available":
      return (
        <div className={wrap}>
          <Banner title={`Kanopa ${version} is available.`} onDismiss={dismiss} actions={<Button variant="primary" onClick={openPage}>{`Download ${version}`}</Button>}>
            {status.selfUpdate ? "Download it from the Releases page." : "Kanopa can't update itself here. Download it and install it yourself."}
          </Banner>
        </div>
      );
    case "failed":
      // A check that failed on its own stays quiet (the Go side says idle then); a failed update, or a check by hand, is said.
      return (
        <div className={wrap}>
          <Banner tone="warning" title={status.failure.includes("didn't install") ? "The update didn't install." : "Couldn't check for updates."} onDismiss={dismiss} actions={<Button onClick={openPage}>Open the Releases page</Button>}>
            {status.failure}
          </Banner>
        </div>
      );
    default:
      return null;
  }
}
