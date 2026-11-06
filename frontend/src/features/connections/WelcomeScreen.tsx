import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText, useBackend, type ConnectReason, type SavedConnection } from "@/api/backend";
import { credentialStoreName, detectPlatform, isMod, type Platform } from "@/lib/platform";
import { formatLastUsed, plural } from "@/lib/time";
import { useApp } from "@/stores/app";
import { Badge, Banner, Button, ConfirmDialog, EmptyState, Icon, Kbd, Logo, MenuButton, Spinner, TextField, cx, useToasts } from "@/ui";
import { ConnectionDialog } from "./ConnectionDialog";
import { PasswordDialog } from "./PasswordDialog";
import { hostOf, hostPortOf } from "./url";

type RowStatus = { state: "connecting" } | { state: "error"; title: string; message: string; reason: ConnectReason };

type DialogState =
  | null
  | { kind: "new" }
  | { kind: "edit"; id: string; reason: "badPassword" | "" }
  | { kind: "delete"; id: string }
  | { kind: "consent"; id: string }
  | { kind: "password"; id: string };

export const CONNECTIONS_KEY = ["connections"];

/** The welcome screen from the design: saved connections, filter, connect. */
export function WelcomeScreen({ platform = detectPlatform() }: { platform?: Platform }) {
  const backend = useBackend();
  const qc = useQueryClient();
  const openSession = useApp((s) => s.openSession);
  const toast = useToasts((s) => s.show);
  const store = credentialStoreName(platform);

  // The notice about a damaged file comes once; keep it until dismissed.
  const [notice, setNotice] = useState("");
  const list = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: async () => {
      const r = await backend.listConnections();
      if (r.notice) setNotice(r.notice);
      return r;
    },
  });

  const conns = useMemo(() => list.data?.connections ?? [], [list.data]);
  const [filter, setFilter] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyDialog, setBusyDialog] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLElement>(null);
  const aborts = useRef<Record<string, AbortController>>({});

  const q = filter.trim().toLowerCase();
  const rows = q ? conns.filter((c) => [c.name, c.url, c.baseDn].join(" ").toLowerCase().includes(q)) : conns;
  const active = rows.find((c) => c.id === activeId) ?? rows[0];
  const byId = (id: string) => conns.find((c) => c.id === id);

  const refresh = () => qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
  const setRow = (id: string, s: RowStatus | null) =>
    setStatus((all) => {
      const next = { ...all };
      if (s) next[id] = s;
      else delete next[id];
      return next;
    });

  async function connect(id: string, password = "", save = false) {
    aborts.current[id]?.abort();
    const ctrl = new AbortController();
    aborts.current[id] = ctrl;
    setActiveId(id);
    setRow(id, { state: "connecting" });
    try {
      const r = await backend.connect(id, password, save, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (r.ok && r.session) {
        setRow(id, null);
        await refresh();
        openSession(r.session);
        return;
      }
      const reason = (r.reason || "other") as ConnectReason;
      if (reason === "needsConsent" || reason === "needsPassword") {
        setRow(id, null);
        setDialog({ kind: reason === "needsConsent" ? "consent" : "password", id });
        return;
      }
      setRow(id, { state: "error", title: r.title, message: r.message, reason });
    } catch (e) {
      if (!ctrl.signal.aborted) setRow(id, { state: "error", title: "Connection failed.", message: errorText(e), reason: "other" });
    }
    void refresh();
  }

  async function duplicate(c: SavedConnection) {
    try {
      const copy = await backend.duplicateConnection(c.id);
      await refresh();
      setActiveId(copy.id);
      setDialog({ kind: "edit", id: copy.id, reason: "" });
    } catch (e) {
      toast(errorText(e), "danger");
    }
  }

  async function confirmDelete(id: string) {
    const c = byId(id);
    setBusyDialog(true);
    try {
      await backend.deleteConnection(id);
      setRow(id, null);
      await refresh();
      toast(`Deleted the connection “${c?.name ?? ""}”.`);
      setDialog(null);
    } catch (e) {
      toast(errorText(e), "danger");
    } finally {
      setBusyDialog(false);
    }
  }

  async function confirmConsent(id: string) {
    setDialog(null);
    try {
      await backend.allowUnencrypted(id);
      await connect(id);
    } catch (e) {
      setRow(id, { state: "error", title: "Connection failed.", message: errorText(e), reason: "other" });
    }
  }

  // ⌘F / Ctrl+F filters, ⌘N / Ctrl+N creates a connection.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (dialog || !isMod(e, platform) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      } else if (k === "n") {
        e.preventDefault();
        setDialog({ kind: "new" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, platform]);

  // Arrows move the highlight; Enter connects the highlighted connection. Only from the filter field
  // or the table itself: keys pressed in a dialog or a row menu (React bubbles portal events) are theirs.
  function onListKey(e: KeyboardEvent) {
    const t = e.target as Node;
    if (t !== filterRef.current && !tableRef.current?.contains(t)) return;
    if (!rows.length) return;
    const i = Math.max(0, rows.findIndex((c) => c.id === active?.id));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[(i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
      setActiveId(next.id);
    } else if (e.key === "Enter" && active && (e.target === filterRef.current || (e.target as HTMLElement).dataset.row === "true")) {
      e.preventDefault();
      void connect(active.id);
    }
  }

  const dlgConn = dialog && "id" in dialog ? byId(dialog.id) : undefined;

  return (
    <main className="flex-1 overflow-auto px-6 py-12" onKeyDown={onListKey}>
      <div className="mx-auto flex max-w-[1040px] flex-col gap-6">
        <div className="flex flex-col gap-4">
          <Logo size={40} wordmark />
          <div className="flex flex-col gap-1.5">
            <h1 className="type-display m-0">Choose a connection</h1>
            <p className="m-0 max-w-[560px] text-ink-muted">
              Pick a saved directory to open it, or create a new connection. Connections are stored on this computer; passwords stay in the {store}.
            </p>
          </div>
        </div>

        {notice && (
          <Banner tone="warning" title="Saved connections" onDismiss={() => setNotice("")}>
            {notice}
          </Banner>
        )}
        {list.isError && <Banner tone="danger" title="Kanopa could not read your saved connections.">{errorText(list.error)}</Banner>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <TextField
            ref={filterRef}
            fieldClassName="max-w-[360px] flex-[1_1_280px]"
            aria-label="Filter connections"
            type="search"
            icon="search"
            placeholder="Filter by name, host or base DN"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            trailing={<Kbd keys={["mod", "f"]} platform={platform} />}
          />
          <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "new" })}>
            New connection
          </Button>
        </div>

        {list.isSuccess && conns.length === 0 ? (
          <section className="rounded-md border border-line bg-surface-raised shadow-sm">
            <EmptyState
              icon="server"
              tone="server"
              title="No saved connections yet"
              actions={
                <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "new" })}>
                  New connection
                </Button>
              }
            >
              Create one to get started. Kanopa keeps it on this computer.
            </EmptyState>
          </section>
        ) : (
          <section ref={tableRef} aria-label="Saved connections" className="overflow-x-auto rounded-md border border-line bg-surface-raised shadow-sm">
            <div role="table" aria-label="Saved connections" className="min-w-[900px]">
              <div role="row" className="conn-grid type-label h-8 border-b border-line px-4 text-ink-muted">
                <span role="columnheader">Connection</span>
                <span role="columnheader">Base DN</span>
                <span role="columnheader">Bind as</span>
                <span role="columnheader">Security</span>
                <span role="columnheader">Last used</span>
                <span role="columnheader">
                  <span className="kn-sr">Actions</span>
                </span>
              </div>
              {rows.map((c, i) => (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  last={i === rows.length - 1}
                  active={c.id === active?.id}
                  status={status[c.id]}
                  platform={platform}
                  onActivate={() => setActiveId(c.id)}
                  onConnect={() => void connect(c.id)}
                  onEdit={(reason) => {
                    setRow(c.id, null);
                    setDialog({ kind: "edit", id: c.id, reason });
                  }}
                  onDuplicate={() => void duplicate(c)}
                  onDelete={() => setDialog({ kind: "delete", id: c.id })}
                />
              ))}
              {rows.length === 0 && list.isSuccess && <div className="px-4 py-6 text-center text-ink-muted">No saved connection matches “{filter}”.</div>}
              {list.isPending && <div className="flex items-center justify-center gap-2 px-4 py-6 text-ink-muted"><Spinner /> Reading your saved connections…</div>}
            </div>
          </section>
        )}

        <div className="flex flex-wrap justify-between gap-3 text-ink-muted">
          <span>{plural(conns.length, "saved connection")}</span>
          <span className="inline-flex items-center gap-1.5">
            Press <Kbd keys={["mod", "n"]} platform={platform} /> for a new connection, <Kbd keys={["enter"]} platform={platform} /> to connect to the highlighted one
          </span>
        </div>
      </div>

      {dialog?.kind === "new" && (
        <ConnectionDialog
          mode="new"
          platform={platform}
          onClose={() => setDialog(null)}
          onSaved={(saved, connectNow, password) => {
            setDialog(null);
            setFilter("");
            setActiveId(saved.id);
            void refresh();
            if (connectNow) void connect(saved.id, password);
            else toast(`Saved “${saved.name}”.`);
          }}
        />
      )}
      {dialog?.kind === "edit" && dlgConn && (
        <ConnectionDialog
          mode="edit"
          connection={dlgConn}
          reason={dialog.reason}
          platform={platform}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setRow(saved.id, null);
            void refresh();
            toast(`Saved changes to “${saved.name}”.`);
          }}
        />
      )}
      {dialog?.kind === "delete" && dlgConn && (
        <ConfirmDialog
          tone="danger"
          platform={platform}
          title={`Delete the connection “${dlgConn.name}”?`}
          confirmLabel="Delete connection"
          busy={busyDialog}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmDelete(dlgConn.id)}
        >
          Kanopa removes its settings and the saved password from the {store}. Nothing changes on <code>{hostOf(dlgConn.url)}</code>. This cannot be undone.
        </ConfirmDialog>
      )}
      {dialog?.kind === "consent" && dlgConn && (
        <ConfirmDialog
          tone="warning"
          platform={platform}
          title="Connect without encryption?"
          confirmLabel="Connect anyway"
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmConsent(dlgConn.id)}
        >
          <code>{hostPortOf(dlgConn.url)}</code> uses neither LDAPS nor StartTLS, so the bind and every value you read cross the network in clear text. That is fine for a server on this computer.
        </ConfirmDialog>
      )}
      {dialog?.kind === "password" && dlgConn && (
        <PasswordDialog
          conn={dlgConn}
          store={store}
          platform={platform}
          onCancel={() => setDialog(null)}
          onConnect={(pw, save) => {
            setDialog(null);
            void connect(dlgConn.id, pw, save);
          }}
        />
      )}
    </main>
  );
}

interface RowProps {
  conn: SavedConnection;
  last: boolean;
  active: boolean;
  status?: RowStatus;
  platform: Platform;
  onActivate: () => void;
  onConnect: () => void;
  onEdit: (reason: "badPassword" | "") => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function ConnectionRow({ conn: c, last, active, status, platform, onActivate, onConnect, onEdit, onDuplicate, onDelete }: RowProps) {
  const connecting = status?.state === "connecting";
  const error = status?.state === "error" ? status : undefined;
  const plain = c.security === "none";
  return (
    <div className={cx(!last && "border-b border-line")}>
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard picks rows from the table (arrows, Enter) */}
      <div
        role="row"
        data-row="true"
        data-active={active}
        aria-selected={active}
        tabIndex={-1}
        className="kn-conn-row conn-grid px-4 py-3"
        onClick={onActivate}
        onDoubleClick={() => !connecting && onConnect()}
      >
        <div role="cell" className="flex min-w-0 items-center gap-3">
          <span className="kn-tile--server grid size-8 shrink-0 place-items-center rounded-xs" aria-hidden="true">
            <Icon name="server" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">{c.name}</span>
            <code className="truncate text-ink-muted">{c.url}</code>
          </div>
        </div>
        <code role="cell" className="truncate">
          {c.baseDn || "(server default)"}
        </code>
        <span role="cell" className="min-w-0 truncate">
          {c.bind === "anonymous" ? <span className="text-ink-muted">Anonymous bind</span> : <code className="text-ink-muted">{c.bindDn}</code>}
        </span>
        <span role="cell">
          <Badge tone={plain ? "warning" : "success"} icon={plain ? "unlock" : "lock"}>
            {c.security === "ldaps" ? "LDAPS" : c.security === "starttls" ? "StartTLS" : "Unencrypted"}
          </Badge>
        </span>
        <div role="cell" className="flex min-w-0 flex-col">
          <span>{formatLastUsed(c.lastUsed)}</span>
          {c.lastError && !error && (
            <span className="inline-flex min-w-0 items-center gap-1 text-[12px] leading-4 text-danger-ink" title={c.lastError}>
              <Icon name="error" size={12} />
              <span className="truncate">Last attempt failed</span>
            </span>
          )}
        </div>
        <div role="cell" className="flex items-center justify-end gap-1">
          {/* One button in both states, so focus stays on it while connecting. */}
          <Button variant={active && !connecting ? "primary" : "secondary"} busy={connecting} onClick={onConnect} aria-label={connecting ? `Connecting to ${c.name}` : `Connect to ${c.name}`}>
            {connecting ? "Connecting…" : "Connect"}
          </Button>
          <MenuButton
            label={`Actions for ${c.name}`}
            platform={platform}
            items={[
              { id: "edit", label: "Edit…", icon: "pencil" },
              { id: "duplicate", label: "Duplicate", icon: "copy" },
              { separator: true },
              { id: "delete", label: "Delete…", icon: "trash", danger: true },
            ]}
            onSelect={(id) => (id === "edit" ? onEdit("") : id === "duplicate" ? onDuplicate() : onDelete())}
          />
        </div>
      </div>
      {error && (
        <div role="alert" className="mx-4 mb-3 ml-[60px] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-danger-soft px-3 py-2.5">
          <Icon name="error" className="shrink-0 text-danger-ink" />
          <span className="min-w-0 flex-[1_1_360px] break-words">
            <strong className="font-semibold text-danger-ink">{error.title}</strong> {error.message}
          </span>
          <div className="flex gap-2">
            <Button onClick={() => onEdit(error.reason === "badPassword" ? "badPassword" : "")}>{error.reason === "badPassword" ? "Update password" : "Edit connection"}</Button>
            <Button variant="ghost" onClick={onConnect}>
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

