import { BrowserScreen } from "@/features/browser/BrowserScreen";
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
    </div>
  );
}
