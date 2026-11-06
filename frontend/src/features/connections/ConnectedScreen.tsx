import { useState } from "react";
import { useBackend, type SessionInfo } from "@/api/backend";
import { useApp } from "@/stores/app";
import { Badge, Button, Icon, StatusIndicator } from "@/ui";

/** After a successful connect: who Kanopa is bound as, and what the server says about itself. */
export function ConnectedScreen({ session }: { session: SessionInfo }) {
  const s = { ...session, namingContexts: session.namingContexts ?? [], ldapVersions: session.ldapVersions ?? [] };
  const backend = useBackend();
  const closeSession = useApp((st) => st.closeSession);
  const [leaving, setLeaving] = useState(false);
  const plain = s.security === "an unencrypted link";

  async function disconnect() {
    setLeaving(true);
    try {
      await backend.disconnect(s.connectionId);
    } finally {
      closeSession();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="kn-tile--server grid size-6 place-items-center rounded-xs" aria-hidden="true">
          <Icon name="server" size={14} />
        </span>
        <h1 className="type-heading m-0 truncate">{s.name}</h1>
        <StatusIndicator status="connected" detail={s.url} />
        <span className="grow" />
        <Button size="sm" icon="x" onClick={() => void disconnect()} busy={leaving}>
          Disconnect
        </Button>
      </div>

      <main className="flex-1 overflow-auto px-6 py-8">
        <section aria-labelledby="server-title" className="mx-auto flex max-w-[760px] flex-col gap-6 rounded-lg border border-line bg-surface-raised p-6 shadow-sm">
          <div className="flex flex-col gap-1">
            <h2 id="server-title" className="type-title m-0">
              Connected to {s.name}
            </h2>
            <p className="m-0 text-ink-muted">
              {s.boundAs ? (
                <>
                  Bound as <code>{s.boundAs}</code>
                </>
              ) : (
                "Connected anonymously"
              )}{" "}
              in {s.elapsedMs} ms over {s.security}.
            </p>
          </div>

          <dl className="m-0 grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 gap-y-3">
            <Item label="URL">
              <code>{s.url}</code>
            </Item>
            <Item label="Security">
              <Badge tone={plain ? "warning" : "success"} icon={plain ? "unlock" : "lock"}>
                {plain ? "Unencrypted" : s.security}
              </Badge>
            </Item>
            <Item label="Bound as">{s.boundAs ? <code>{s.boundAs}</code> : <span className="text-ink-muted">Anonymous bind</span>}</Item>
            <Item label="Base DN">
              <code>{s.baseDn || "(none published)"}</code>
            </Item>
            <Item label={s.namingContexts.length === 1 ? "Naming context" : "Naming contexts"}>
              {s.namingContexts.length ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {s.namingContexts.map((nc) => (
                    <li key={nc}>
                      <code>{nc}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-muted">None published</span>
              )}
            </Item>
            <Item label="Server">{s.vendor || <span className="text-ink-muted">The server does not publish its name</span>}</Item>
            <Item label="LDAP versions">{s.ldapVersions.length ? s.ldapVersions.join(", ") : <span className="text-ink-muted">Not published</span>}</Item>
            <Item label="Supported">
              {s.controls.toLocaleString("en-US")} controls, {s.extensions.toLocaleString("en-US")} extended operations
            </Item>
            <Item label="Access">
              {s.readOnly ? "Read-only — Kanopa never sends changes over this connection" : "Read-write"}
            </Item>
          </dl>
        </section>
      </main>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="type-label pt-0.5 text-ink-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}
