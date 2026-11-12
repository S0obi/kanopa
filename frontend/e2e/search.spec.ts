import { expect, test, type Page } from "@playwright/test";

// The header search, in a browser against the fake directory.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const field = (page: Page) => page.getByRole("combobox", { name: "Search entries" });
const title = (page: Page, name: string) => page.locator("main h1", { hasText: name });

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

test("type a name, click the result: the entry is selected in the tree and opens", async ({ page }) => {
  await connect(page);
  await page.keyboard.press("Control+f");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("ada");
  const list = page.getByRole("listbox", { name: "Matching entries" });
  await expect(list.getByRole("option").first()).toContainText("Ada Lovelace");
  await expect(list).toContainText("Names and mail");
  await list.getByRole("option").first().click();

  await expect(title(page, "Ada Lovelace")).toBeVisible();
  await expect(row(page, /^uid=ada,/)).toHaveAttribute("aria-selected", "true");
  await expect(list).toHaveCount(0);
  await expect(field(page)).toHaveValue("ada");
});

test("words, an LDAP filter, and a filter that is broken", async ({ page }) => {
  await connect(page);
  await field(page).fill("ada lov");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("Ada Lovelace");

  await field(page).fill("(&(objectClass=inetOrgPerson)(mail=grace*))");
  await expect(page.getByRole("listbox")).toContainText("LDAP filter");
  await expect(page.getByRole("option")).toContainText("Grace Hopper");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(title(page, "Grace Hopper")).toBeVisible();

  await field(page).fill("(&(uid=ada)");
  await expect(page.getByText("Missing ) to close the ( at position 1.")).toBeVisible();
  await expect(page.getByText(/▲ character 12/)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
});

test("ten of the matches, and the field in Night forest", async ({ page }) => {
  await connect(page);
  await field(page).fill("an");
  await expect(page.getByRole("option")).toHaveCount(10);
  await expect(page.getByRole("listbox")).toContainText("10 of 200+");

  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Night forest" }).click();
  await field(page).fill("ada");
  await expect(page.getByRole("option").first()).toContainText("Ada Lovelace");
  const dark = await page.evaluate(() => {
    const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
    return { field: bg(".kn-hsearch__field"), panel: bg(".kn-hsearch__panel"), page: getComputedStyle(document.body).backgroundColor };
  });
  expect(dark).toEqual({ field: "rgb(26, 35, 29)", panel: "rgb(26, 35, 29)", page: "rgb(19, 26, 21)" });
});
