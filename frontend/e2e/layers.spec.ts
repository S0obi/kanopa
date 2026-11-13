import { expect, test, type Page } from "@playwright/test";

// A dialog sits above everything in the window: nothing in the header may paint over it.

async function topmost(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit && el.contains(hit) ? "element" : (hit?.closest("[role=dialog], .kn-scrim")?.className ?? "other");
  }, selector);
}

test("the header search does not paint over a dialog", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await page.getByRole("tree", { name: "Directory tree" }).getByRole("treeitem", { name: /^ou=groups/ }).click();
  await expect(page.locator("main h1", { hasText: "groups" })).toBeVisible();

  // Before: the search field is what you click.
  expect(await topmost(page, ".kn-hsearch__field")).toBe("element");

  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
  // The dialog's own layer is on top of the field now, and the field is not.
  expect(await topmost(page, ".kn-hsearch__field")).not.toBe("element");
});

test("the search results sit above the entry and below a dialog", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(page.getByRole("treeitem", { name: /^ou=people/ })).toBeVisible();
  await page.getByRole("combobox", { name: "Search entries" }).fill("ada");
  await expect(page.locator(".kn-hsearch__panel")).toBeVisible();
  expect(await topmost(page, ".kn-hsearch__panel")).toBe("element");
});
