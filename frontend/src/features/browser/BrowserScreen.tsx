import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorText, useBackend, type SavedConnection, type SessionInfo } from "@/api/backend";
import { PasswordDialog } from "@/features/connections/PasswordDialog";
import { hostOf } from "@/features/connections/url";
import { credentialStoreName, detectPlatform, isMod } from "@/lib/platform";
import { plural } from "@/lib/time";
import { useApp } from "@/stores/app";
import { Badge, Banner, Button, SplitPane, StatusBar, StatusIndicator, Tooltip, TypeTile } from "@/ui";
import { ApplyFailureBanner, ChangesBar, DropChangesDialog, useApplyChanges, useApplyShortcut } from "./ChangesBar";
import { useChanges } from "./changes";
import { EntryPane } from "./EntryPane";
import { useBrowser } from "./store";
import { DirectoryTree } from "./Tree";

const PING_EVERY_MS = 30_000;

/** The connected window from the design: tree on the left, the selected entry on the right. */
export function BrowserScreen({ session }: { session: SessionInfo }) {
  const backend = useBackend();
  const qc = useQueryClient();
  const platform = detectPlatform();
  const closeSession = useApp((s) => s.closeSession);
  const openSession = useApp((s) => s.openSession);
  const { start, reload, collapseAll, connection, lost, failed, setConnection, nodes, lastReadMs } = useBrowser();
  const [leaving, setLeaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [reconnectError, setReconnectError] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const changes = useApplyChanges(session);
  const dropChanges = useChanges((s) => s.discard);
  const setTab = useBrowser((s) => s.setTab);
  useApplyShortcut(() => void changes.apply());
  const id = session.connectionId;
  const host = hostOf(session.url);

  useEffect(() => {
    void start(backend, session);
    // A new session (after Reconnect) keeps the tree: reload() handles it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notice a server that went away while nobody was reading.
  useEffect(() => {
    if (connection !== "connected") return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const f = await backend.ping(id);
      if (f) failed(f);
    }, PING_EVERY_MS);
    return () => clearInterval(t);
  }, [backend, id, connection, failed]);

  async function refresh() {
    setRefreshing(true);
    try {
      await qc.invalidateQueries({ queryKey: ["entry", id] });
      await qc.invalidateQueries({ queryKey: ["memberOf", id] });
      await reload(backend);
    } finally {
      setRefreshing(false);
    }
  }

  // F5 / Ctrl+R / ⌘R reads the tree and the entry again.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F5" || (isMod(e, platform) && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        if (connection === "connected") void refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function reconnect(password = "", save = false) {
    setReconnectError("");
    setConnection("reconnecting");
    try {
      const r = await backend.connect(id, password, save);
      if (r.ok && r.session) {
        openSession(r.session);
        setConnection("connected", r.session);
        await qc.invalidateQueries({ queryKey: ["entry", id] });
        await qc.invalidateQueries({ queryKey: ["memberOf", id] });
        await reload(backend);
        return;
      }
      setConnection("lost");
      if (r.reason === "needsPassword") setAskPassword(true);
      else setReconnectError(`${r.title} ${r.message}`);
    } catch (e) {
      setConnection("lost");
      setReconnectError(errorText(e));
    }
  }

  async function disconnect(force = false) {
    if (!force && changes.summary.count > 0) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    dropChanges(id);
    setLeaving(true);
    try {
      await backend.disconnect(id);
    } finally {
      closeSession();
    }
  }

  const loaded = Object.keys(nodes).length;
  const statusLabel = connection === "connected" ? "Connected" : connection === "reconnecting" ? "Reconnecting…" : "Connection lost";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface-sunken pr-2.5 pl-3.5">
        <TypeTile type="server" size={22} />
        <h1 className="type-heading m-0 truncate">{session.name}</h1>
        {session.readOnly && (
          <Badge tone="neutral" icon={false} title="Kanopa sends no changes over this connection">
            Read-only
          </Badge>
        )}
        <span className="grow" />
        <Tooltip content="Read the tree and the entry again" shortcut={platform === "mac" ? ["mod", "r"] : ["F5"]} placement="bottom">
          <Button variant="ghost" size="sm" icon="refresh" label="Refresh" busy={refreshing} disabled={connection !== "connected"} onClick={() => void refresh()} />
        </Tooltip>
        <span className="mx-1.5 h-[18px] w-px bg-line" aria-hidden="true" />
        <Button variant="ghost" size="sm" icon="x" busy={leaving} onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </header>

      <SplitPane
        className="min-h-0 flex-1"
        startClassName="flex flex-col bg-surface-sunken"
        start={
          <nav aria-label="Directory" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between py-2 pr-2 pl-4">
              <h2 className="type-overline m-0 text-ink-muted">Directory</h2>
              <Button variant="ghost" size="sm" icon="minus" label="Collapse all" onClick={collapseAll} />
            </div>
            <div className="min-h-0 flex-1">
              <DirectoryTree />
            </div>
          </nav>
        }
        end={
          <main className="flex h-full min-h-0 flex-col bg-surface">
            {connection === "lost" && (
              <div className="px-4 pt-3">
                <Banner
                  tone="danger"
                  title={lost?.title ?? `Connection to ${host} lost.`}
                  actions={
                    <Button onClick={() => void reconnect()} icon="refresh">
                      Reconnect
                    </Button>
                  }
                >
                  {changes.summary.count > 0 && `Your ${changes.summary.count} pending ${changes.summary.count === 1 ? "change is" : "changes are"} kept. `}
                  {reconnectError || lost?.message || "The server stopped answering. Reconnect to keep working. Server is unavailable (52)"}
                </Banner>
              </div>
            )}
            {connection === "reconnecting" && (
              <div className="px-4 pt-3">
                <Banner tone="info" busy title={`Reconnecting to ${host}…`} />
              </div>
            )}
            {changes.failure && (
              <div className="px-4 pt-3">
                <ApplyFailureBanner f={changes.failure} pending={changes.summary.count} onDismiss={changes.dismissFailure} />
              </div>
            )}
            <EntryPane />
            {changes.summary.count > 0 && (
              <ChangesBar
                count={changes.summary.count}
                summary={changes.summary.text}
                connected={connection === "connected"}
                applying={changes.applying}
                onReview={() => setTab("ldif")}
                onDiscard={changes.discard}
                onApply={() => void changes.apply()}
              />
            )}
          </main>
        }
      />

      <StatusBar
        start={[
          <StatusIndicator key="s" status={connection === "connected" ? "connected" : connection === "reconnecting" ? "connecting" : "error"} label={statusLabel} />,
          <code key="u">{session.url}</code>,
          <span key="b">{session.boundAs ? <>Bound as <code>{session.boundAs}</code></> : "Anonymous bind"}</span>,
        ]}
        end={[
          <span key="n">{plural(loaded, "entry", "entries")} read</span>,
          ...(lastReadMs !== null ? [<span key="t">Last read {lastReadMs} ms</span>] : []),
        ]}
      />

      {confirmLeave && (
        <DropChangesDialog what="disconnect" count={changes.summary.count} host={changes.host} onCancel={() => setConfirmLeave(false)} onConfirm={() => void disconnect(true)} />
      )}
      {askPassword && (
        <PasswordDialog
          conn={{ name: session.name, bindDn: session.boundAs } as SavedConnection}
          store={credentialStoreName(platform)}
          platform={platform}
          onCancel={() => setAskPassword(false)}
          onConnect={(pw, save) => {
            setAskPassword(false);
            void reconnect(pw, save);
          }}
        />
      )}
    </div>
  );
}
