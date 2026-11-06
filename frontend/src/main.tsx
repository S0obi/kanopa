import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import { BackendContext, type Backend } from "@/api/backend";
import { App } from "./App";

// `vite --mode fake` runs the UI in a plain browser against the fake backend.
async function loadBackend(): Promise<Backend> {
  if (import.meta.env.MODE === "fake") return (await import("@/api/fake")).fakeBackend;
  return (await import("@/api/wails")).wailsBackend;
}

const backend = await loadBackend();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackendContext.Provider value={backend}>
      <App />
    </BackendContext.Provider>
  </StrictMode>,
);
