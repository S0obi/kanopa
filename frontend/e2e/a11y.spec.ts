import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// WCAG 2.2 AA, checked by axe on every screen and dialog, in Clearing and in Night forest.
// (axe finds what a machine can find; the keyboard-only and screen-reader passes cover the rest.)

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const report = violations.map((v) => `${where}: ${v.id} (${v.impact}) ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
  expect(report, `${where} has accessibility violations`).toEqual([]);
}

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });

async function connect(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a connection" })).toBeVisible();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`in ${scheme === "light" ? "Clearing" : "Night forest"}`, () => {
    test.use({ colorScheme: scheme });

    test("the welcome screen, its menus and dialogs", async ({ page }) => {
      await connect(page);
      await scan(page, "welcome");

      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await scan(page, "app menu");
      await page.getByRole("menuitem", { name: "About Kanopa…" }).click();
      await expect(page.getByRole("dialog", { name: "About Kanopa" })).toBeVisible();
      await scan(page, "about dialog");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "New connection" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await scan(page, "connection dialog");
      await page.getByRole("button", { name: /Advanced/ }).click();
      await scan(page, "connection dialog, advanced");
    });

    test("the browser: tree, entry views, search, menus", async ({ page }) => {
      await connect(page);
      await page.getByRole("button", { name: "Connect to Production directory" }).click();
      await expect(row(page, /^ou=people/)).toBeVisible();
      await scan(page, "browser");

      await row(page, /^ou=people/).click();
      await page.keyboard.press("ArrowRight");
      await row(page, /^uid=ada /).click();
      await expect(page.locator("main h1", { hasText: "Ada Lovelace" })).toBeVisible();
      await scan(page, "entry, attributes");
      await page.getByRole("tab", { name: "LDIF" }).click();
      await scan(page, "entry, LDIF");
      await page.getByRole("tab", { name: "Member of" }).click();
      await expect(page.getByRole("list").first()).toBeVisible();
      await scan(page, "entry, member of");

      await row(page, /^uid=ada /).click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await scan(page, "tree menu");
      await page.keyboard.press("Escape");

      const search = page.getByRole("combobox", { name: "Search entries" });
      await search.click();
      await expect(page.getByText("Try", { exact: true })).toBeVisible();
      await scan(page, "search tips");
      await search.fill("ada");
      await expect(page.getByRole("option").first()).toBeVisible();
      await scan(page, "search results");
      await search.fill("(&(uid=ada)");
      await expect(page.getByText(/Missing \)/)).toBeVisible();
      await scan(page, "search, broken filter");
      await page.keyboard.press("Escape");
    });

    test("editing: value editor, new entry, rename, delete, pending changes", async ({ page }) => {
      await connect(page);
      await page.getByRole("button", { name: "Connect to Production directory" }).click();
      await row(page, /^ou=people/).click();
      await page.keyboard.press("ArrowRight");
      await row(page, /^uid=ada /).click();
      await expect(page.locator("main h1", { hasText: "Ada Lovelace" })).toBeVisible();

      await page.locator("table[aria-label=Attributes] tr", { hasText: "title" }).first().hover();
      await page.getByRole("button", { name: "Edit title" }).click();
      await expect(page.getByRole("dialog", { name: /Edit title/ })).toBeVisible();
      await scan(page, "value editor");
      const input = page.getByRole("textbox", { name: "title value 1" });
      await input.fill("Chief engineer");
      await input.press("Enter");
      await expect(page.getByRole("region", { name: "Pending changes" })).toBeVisible();
      await scan(page, "pending changes bar");
      await page.getByRole("button", { name: "Review LDIF" }).click();
      await expect(page.getByRole("region", { name: "Pending changes as LDIF" })).toBeVisible();
      await scan(page, "reviewing the LDIF");

      await page.getByRole("button", { name: "More entry actions" }).click();
      await page.getByRole("menuitem", { name: /Rename/ }).click();
      await expect(page.getByRole("dialog", { name: /Rename/ })).toBeVisible();
      await scan(page, "rename dialog");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "More entry actions" }).click();
      await page.getByRole("menuitem", { name: /Delete/ }).click();
      await expect(page.getByRole("alertdialog", { name: /Delete/ })).toBeVisible();
      await scan(page, "delete dialog");
      await page.keyboard.press("Escape");

      await row(page, /^ou=people/).click();
      await page.getByRole("button", { name: "New entry" }).click();
      await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
      await scan(page, "new entry dialog");
      // The dropdown is drawn by the app, so axe reads it too: open, with an option highlighted.
      await page.getByRole("combobox", { name: "Create under" }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("listbox", { name: "Create under" })).toBeVisible();
      await scan(page, "dropdown open");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
    });
  });
}
