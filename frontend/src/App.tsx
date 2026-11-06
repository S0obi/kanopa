import { ConnectedScreen } from "@/features/connections/ConnectedScreen";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { useApp } from "@/stores/app";
import { ToastRegion } from "@/ui";

export function App() {
  const view = useApp((s) => s.view);
  return (
    <div className="flex h-screen flex-col bg-surface text-ink">
      {view.name === "connected" ? <ConnectedScreen session={view.session} /> : <WelcomeScreen />}
      <ToastRegion />
    </div>
  );
}
