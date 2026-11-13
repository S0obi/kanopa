// The README demo: open Kanopa, connect, browse the tree, change a title, save, disconnect.
// Recorded in a browser against the fake directory, then encoded as a GIF with ffmpeg.
//
//   npm run demo                      # writes ../docs/screenshots/demo.gif
//   OUT=some/dir npm run demo
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFakeServer } from "./lib/devserver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.OUT ?? resolve(here, "../../docs/screenshots"));
const size = { width: 1100, height: 690 };
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "kanopa-demo-"));

const { base, stop } = await startFakeServer(9347);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: size, colorScheme: "dark", recordVideo: { dir: work, size } });
const started = Date.now();
const page = await ctx.newPage();
await page.clock.setFixedTime(new Date("2026-11-12T14:30:30")); // so "Today, 14:30" reads the same in every frame

// A visible pointer: the page has none of its own in a recording.
await page.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;" +
      "background:rgba(184,222,170,.85);box-shadow:0 0 0 2px rgba(16,24,18,.7),0 2px 8px rgba(0,0,0,.5);transition:transform .08s,background .08s";
    dot.style.translate = "640px 110px";
    document.body.append(dot);
    addEventListener("mousemove", (e) => (dot.style.translate = `${e.clientX}px ${e.clientY}px`), true);
    addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
    addEventListener("mouseup", () => (dot.style.transform = ""), true);
  });
});

const pause = (ms) => page.waitForTimeout(ms);
const rest = { x: 640, y: 110 }; // an empty spot, where the pointer starts and ends
let at = { ...rest };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Move the pointer slowly, easing in and out, so the recording shows it travelling. */
async function travel(to) {
  const from = at;
  const steps = 34;
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await pause(12);
  }
  at = to;
}
/** Glide to the middle of an element and rest there for a beat. */
async function glide(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await travel({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await pause(250);
}
const click = async (locator) => {
  await glide(locator);
  await locator.click();
};

await page.goto(base);
await page.getByRole("heading", { name: "Choose a connection" }).waitFor();
await page.evaluate(() => document.fonts.ready);
await pause(150);
const lead = (Date.now() - started) / 1000; // the video starts before the page has painted
await pause(1100); // the app has started

await click(page.getByRole("button", { name: "Connect to Production directory" }));
const tree = page.getByRole("tree", { name: "Directory tree" });
await tree.getByRole("treeitem", { name: /^ou=people/ }).waitFor();
await pause(500);

await click(tree.getByRole("treeitem", { name: /^ou=people/ }));
await page.keyboard.press("ArrowRight");
await pause(600);
await click(tree.getByRole("treeitem", { name: /^uid=ada / }));
await page.locator("main h1", { hasText: "Ada Lovelace" }).waitFor();
await pause(1000);

// A simple change: Ada's title.
const row = page.getByRole("table", { name: "Attributes" }).getByRole("row", { name: /title/ });
await glide(row);
await click(page.getByRole("button", { name: "Edit title" }));
const input = page.getByRole("textbox", { name: "title value 1" });
await input.fill("");
await pause(300);
await input.pressSequentially("Chief engineer", { delay: 45 });
await pause(400);
await input.press("Enter");
await pause(900);

const bar = page.getByRole("region", { name: "Pending changes" });
await click(bar.getByRole("button", { name: /Apply/ }));
await page.getByText(/^Saved 1 change/).waitFor();
await pause(1300);

await click(page.getByRole("button", { name: "Disconnect" }));
await page.getByRole("heading", { name: "Choose a connection" }).waitFor();
// Back to the first frame exactly (no toast, pointer where it began), so the GIF loops without a jump.
await page.getByText(/^Saved 1 change/).waitFor({ state: "hidden" });
await travel(rest);
await pause(1100);

await ctx.close(); // the video is written when the page closes
await browser.close();
stop();

const webm = join(work, readdirSync(work).find((f) => f.endsWith(".webm")));
const gif = resolve(out, "demo.gif");
// One shared palette keeps the colors steady; 10 frames a second and 880 px keep the file small.
const filter = "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", lead.toFixed(2), "-i", webm, "-vf", filter, "-loop", "0", gif]);
rmSync(work, { recursive: true, force: true });
console.log(`Demo written to ${gif}`);
