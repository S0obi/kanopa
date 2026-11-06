import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // The fake backend (mode "fake") runs in a plain browser for Playwright and quick UI work.
  plugins: [react(), tailwindcss(), ...(mode === "fake" || process.env.VITEST ? [] : [wails("./bindings")])],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // `wails3 dev` starts Vite on this port and points the app window at it.
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
