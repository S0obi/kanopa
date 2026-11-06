import { ConnectionForm } from "@/features/connections/ConnectionForm";
import { Logo } from "@/ui";

export function App() {
  return (
    <div className="flex h-screen flex-col bg-surface text-ink">
      <header className="flex h-10 shrink-0 items-center border-b border-line bg-surface-sunken px-4">
        <Logo size={18} wordmark />
      </header>
      <main className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-8">
        <ConnectionForm />
      </main>
    </div>
  );
}
