import { expect, test, type Page } from "@playwright/test";

// The tree's right-click menu, in a browser against the fake directory.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const title = (page: Page, name: string) => page.locator("main h1", { hasText: name });

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

test("right-click a group, add a member from the picker", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=groups/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^cn=admins/).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for cn=admins" });
  await expect(menu).toBeVisible();
  await expect(row(page, /^cn=admins/)).toHaveAttribute("aria-selected", "false");
  await menu.getByRole("menuitem", { name: "Add member…" }).click();
  await expect(menu).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: /Search people/ });
  await expect(search).toBeFocused();
  await search.fill("katherine");
  await page.getByRole("button", { name: "Add Katherine Johnson" }).click();
  await expect(page.getByRole("region", { name: "Pending changes" })).toContainText("Pending change: member on cn=admins");
});

test("Shift+F10 opens the menu on the active row; disabled items say why", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=people/).click();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions for ou=people" });
  await expect(menu.getByRole("menuitem", { name: /Rename/ })).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByRole("menuitem", { name: /Rename/ })).toContainText("Has children");
  // The menu stays inside the window.
  const box = await menu.boundingBox();
  const size = page.viewportSize()!;
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tree(page)).toBeFocused();
});

test("the browser's own menu is blocked outside text fields", async ({ page }) => {
  await connect(page);
  const blocked = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
  await row(page, /^ou=people/).click();
  await expect(title(page, "people")).toBeVisible();
  expect(await blocked("main h1")).toBe(true);
  expect(await blocked("footer, [role=contentinfo]")).toBe(true);
});
