// Screenshots of Kanopa for the README, taken in a browser against the fake directory.
//
//   npm run screenshots                      # starts the fake-backend dev server itself
//   OUT=some/dir npm run screenshots         # where the images go (default: ../docs/screenshots)
//
// Each screen is shot at a fixed size in both themes, and the README banner is drawn on top of the app's own styles.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { startFakeServer } from "./lib/devserver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.OUT ?? resolve(here, "../../docs/screenshots"));
const size = { width: 1280, height: 800 };
mkdirSync(out, { recursive: true });

const { base, stop } = await startFakeServer(9346);
const browser = await chromium.launch();

/** One page in a theme, at the fixed size, with a 2x pixel ratio so the images stay sharp. */
async function open(theme) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.getByRole("heading", { name: "Choose a connection" }).waitFor();
  return { ctx, page };
}

for (const theme of ["dark", "light"]) {
  const { ctx, page } = await open(theme);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(out, `welcome-${theme}.png`) });

  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await page.getByRole("treeitem", { name: /^ou=people/ }).click();
  await page.getByRole("treeitem", { name: /^ou=people/ }).press("ArrowRight");
  await page.getByRole("treeitem", { name: /^uid=ada /i }).click();
  await page.locator("main h1", { hasText: "Ada Lovelace" }).waitFor();
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(size.width - 10, size.height - 10);
  await page.screenshot({ path: resolve(out, `browse-${theme}.png`) });
  await ctx.close();
}

// The hero banner: the logo and name on Night forest, with a faint directory tree behind them.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 320 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.getByRole("heading", { name: "Choose a connection" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    // A branching tree, drawn as lines and nodes, the way the directory tree looks.
    const nodes = [];
    const lines = [];
    const grow = (x, y, depth) => {
      const kids = depth < 3 ? 2 : 0;
      for (let i = 0; i < kids; i++) {
        const nx = x + 130;
        const ny = y + (i === 0 ? -1 : 1) * (96 - depth * 30);
        lines.push(`M${x} ${y}H${x + 40}V${ny}H${nx}`);
        nodes.push([nx, ny, depth]);
        grow(nx, ny, depth + 1);
      }
    };
    grow(0, 0, 0);
    const tree = (ox, oy, flip) =>
      `<g transform="translate(${ox} ${oy}) scale(${flip ? -1 : 1} 1)"><path d="${lines.join("")}" fill="none" stroke="var(--fern)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${nodes
        .map(([x, y, d]) => `<circle cx="${x}" cy="${y}" r="${7 - d * 1.5}" fill="var(--fern)"/>`)
        .join("")}</g>`;
    document.body.innerHTML = `
      <div style="position:relative;width:1280px;height:320px;overflow:hidden;display:grid;place-items:center;
        background:radial-gradient(90% 140% at 50% 0%,#2b4231 0%,#182419 55%,#101812 100%)">
        <svg width="1280" height="320" viewBox="0 0 1280 320" style="position:absolute;inset:0;opacity:.3;-webkit-mask-image:radial-gradient(ellipse 38% 120% at 50% 50%,transparent 55%,#000 100%);mask-image:radial-gradient(ellipse 38% 120% at 50% 50%,transparent 55%,#000 100%)">${tree(-10, 160, false)}${tree(1290, 160, true)}</svg>
        <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:14px">
          <div style="display:flex;align-items:center;gap:22px">
            <svg width="92" height="92" viewBox="0 0 64 64" aria-hidden="true">
              <path class="kn-logo__stem" d="M19 10v44 M19 35L41 16 M27 28L41 49" fill="none" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
              <circle class="kn-logo__top" cx="43" cy="14" r="8"/><circle class="kn-logo__bottom" cx="43" cy="51" r="7.5"/>
            </svg>
            <span style="font:600 84px/1 var(--font-sans);letter-spacing:-0.035em;color:var(--ink)">Kanopa</span>
          </div>
          <span style="font:400 22px/1.4 var(--font-sans);color:var(--ink-muted);letter-spacing:.01em">A calm, exact LDAP client for Windows and macOS</span>
        </div>
      </div>`;
    document.body.style.margin = "0";
    document.body.style.background = "#101812";
  });
  await page.screenshot({ path: resolve(out, "banner.png") });
  await ctx.close();
}

await browser.close();
stop();
console.log(`Screenshots written to ${pathToFileURL(out)}`);
