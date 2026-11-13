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
const page = await ctx.newPage();

// A visible pointer: the page has none of its own in a recording.
await page.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;" +
      "background:rgba(184,222,170,.85);box-shadow:0 0 0 2px rgba(16,24,18,.7),0 2px 8px rgba(0,0,0,.5);transition:transform .08s,background .08s";
    document.body.append(dot);
    addEventListener("mousemove", (e) => (dot.style.translate = `${e.clientX}px ${e.clientY}px`), true);
    addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
    addEventListener("mouseup", () => (dot.style.transform = ""), true);
  });
});

const pause = (ms) => page.waitForTimeout(ms);
let at = { x: 40, y: 40 };
/** Move the pointer to the middle of an element in small steps, so the recording shows it travelling. */
async function glide(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(to.x, to.y, { steps: 14 });
  at = to;
  await pause(150);
}
const click = async (locator) => {
  await glide(locator);
  await locator.click();
};

await page.goto(base);
await page.getByRole("heading", { name: "Choose a connection" }).waitFor();
await page.mouse.move(at.x, at.y);
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
await pause(1400);

await ctx.close(); // the video is written when the page closes
await browser.close();
stop();

const webm = join(work, readdirSync(work).find((f) => f.endsWith(".webm")));
const gif = resolve(out, "demo.gif");
// One shared palette keeps the colors steady; 10 frames a second and 880 px keep the file small.
const filter = "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", filter, "-loop", "0", gif]);
rmSync(work, { recursive: true, force: true });
console.log(`Demo written to ${gif}`);
