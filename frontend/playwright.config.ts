import { defineConfig, devices } from "@playwright/test";

const port = 9345;

// User flows in a browser against the fake backend (vite --mode fake).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite --mode fake --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { WAILS_VITE_PORT: String(port) },
  },
});
