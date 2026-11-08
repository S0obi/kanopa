import { useEffect, useState } from "react";
import { useBackend } from "@/api/backend";
import { BrowserScreen } from "@/features/browser/BrowserScreen";
import { DropChangesDialog } from "@/features/browser/ChangesBar";
import { pendingEntries, summarize, useChanges } from "@/features/browser/changes";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { useApp } from "@/stores/app";
import { ToastRegion } from "@/ui";

export function App() {
  const view = useApp((s) => s.view);
  return (
    <div className="flex h-screen flex-col bg-surface text-ink">
      {/* One browser per connection: a new connection starts with a fresh tree. */}
      {view.name === "connected" ? <BrowserScreen key={view.session.connectionId} session={view.session} /> : <WelcomeScreen />}
      <ToastRegion />
      <CloseGuard />
    </div>
  );
}

/** Tells the window about pending changes, and asks before a close would drop them. */
function CloseGuard() {
  const backend = useBackend();
  const entries = useChanges(pendingEntries);
  const count = useChanges((s) => Object.values(s.byConnection).reduce((n, cs) => n + summarize(cs).count, 0));
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void backend.setPendingChanges(entries).catch(() => {});
  }, [backend, entries]);
  useEffect(() => backend.onCloseRequested(() => setAsking(true)), [backend]);

  if (!asking || count === 0) return null;
  return <DropChangesDialog what="close" count={count} host="" onCancel={() => setAsking(false)} onConfirm={() => void backend.closeAnyway()} />;
}
