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

const backend = await loadBackend();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BackendContext.Provider value={backend}>
        <App />
      </BackendContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
