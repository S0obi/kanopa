import { expect, test, type Page } from "@playwright/test";

// Night forest and Clearing, in a browser against the fake backend.

const html = (page: Page) => page.locator("html");
const pick = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name }).click();
};
const surface = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("System follows the OS, and a manual choice stays", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  expect(await surface(page)).toBe("rgb(19, 26, 21)");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  expect(await surface(page)).toBe("rgb(243, 246, 240)");

  await pick(page, "Night forest");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  // The window is told which theme it shows, so its frame can match.
  expect(await page.evaluate(() => (window as unknown as { kanopaFake: { theme: { choice: string; appearance: string } } }).kanopaFake.theme)).toEqual({ choice: "dark", appearance: "dark" });

  await pick(page, "System");
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("the theme switch is on the connected screen too, and no light surface is left in Night forest", async ({ page }) => {
  await page.goto("/");
  await pick(page, "Night forest");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(page.getByRole("treeitem", { name: /^ou=people/ })).toBeVisible();
  await page.getByRole("treeitem", { name: /^ou=people/ }).click();
  await expect(page.locator("main h1", { hasText: "people" })).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Night forest" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Every visible, painted surface is dark, except the moss accent (the primary button).
  const light = await page.evaluate(() => {
    const lum = (c: string) => {
      const m = c.match(/[\d.]+/g)!.map(Number);
      if (m.length > 3 && m[3] === 0) return null;
      const [r, g, b] = m.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out: string[] = [];
    // The moss accent (the primary button) is light in both themes, by design.
    const probe = document.createElement("i");
    probe.style.backgroundColor = "var(--moss)";
    document.body.append(probe);
    const moss = getComputedStyle(probe).backgroundColor;
    probe.remove();
    for (const el of document.querySelectorAll("body *")) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 24 || r.height < 12) continue;
      const bg = getComputedStyle(el).backgroundColor;
      const l = lum(bg);
      if (l !== null && l > 0.45 && bg !== moss) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().slice(0, 40)} ${bg}`);
    }
    return out;
  });
  expect(light).toEqual([]);
});
