import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackendContext, type Backend } from "@/api/backend";
import { App } from "./App";
import { blockBrowserMenu } from "@/lib/contextmenu";
import { CrashBoundary } from "@/features/app/CrashBoundary";
import { useLayout } from "@/stores/layout";
import { useTheme } from "@/theme/theme";

// `vite --mode fake` runs the UI in a plain browser against the fake backend.
async function loadBackend(): Promise<Backend> {
  if (import.meta.env.MODE === "fake") {
    const fake = await import("@/api/fake");
    // Playwright switches the fake's behaviour (a lost connection, delays) through this handle.
    (window as unknown as { kanopaFake: typeof fake.FAKE }).kanopaFake = fake.FAKE;
    return fake.fakeBackend;
  }
  return (await import("@/api/wails")).wailsBackend;
}

blockBrowserMenu();
const backend = await loadBackend();
// Before the first render: the saved theme is on the page when it first paints.
await useTheme.getState().start(backend);
await useLayout.getState().load(backend);

// Errors outside rendering (a failed promise, a stray exception) don't blank the window; they go to the log.
const quiet = (e: unknown) => e instanceof Error && (e.name === "AbortError" || e.name === "CancelError" || e.name === "CancelledError");
window.addEventListener("error", (e) => void backend.logClientError(e.message, e.error?.stack ?? "").catch(() => {}));
window.addEventListener("unhandledrejection", (e) => {
  if (quiet(e.reason)) return;
  const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  void backend.logClientError(`Unhandled: ${err.message}`, err.stack ?? "").catch(() => {});
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BackendContext.Provider value={backend}>
        <CrashBoundary>
          <App />
        </CrashBoundary>
      </BackendContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
