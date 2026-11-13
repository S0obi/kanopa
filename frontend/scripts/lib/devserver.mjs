// Starts the fake-backend dev server for the screenshot and demo scripts, and stops it again.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function startFakeServer(port) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "--mode", "fake", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, WAILS_VITE_PORT: String(port) },
  });
  const stop = () => child.kill();
  process.on("exit", stop);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error("the dev server did not start");
}
