import { expect, test, type Page } from "@playwright/test";

// Search, in a browser against the fake directory.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const filter = (page: Page) => page.getByRole("combobox", { name: "Filter" });
const title = (page: Page, name: string) => page.locator("main h1", { hasText: name });

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

test("find people by filter, open one in the tree, come back to the results", async ({ page }) => {
  await connect(page);
  await page.keyboard.press("Control+f");
  await expect(title(page, "Search")).toBeVisible();
  await filter(page).fill("(&(objectClass=inetOrgPerson)(mail=ada*))");
  await expect(page.getByLabel("The filter is valid")).toBeVisible();
  await filter(page).press("Enter");

  const table = page.getByRole("table", { name: "Search results" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Ada Lovelace");
  await table.getByRole("button", { name: /^Open uid=ada,/ }).click();

  await expect(title(page, "Ada Lovelace")).toBeVisible();
  await expect(row(page, /^uid=ada,/)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Back to results (1)" }).click();
  await expect(table).toBeVisible();
  await expect(filter(page)).toHaveValue("(&(objectClass=inetOrgPerson)(mail=ada*))");
});

test("a filter with a missing parenthesis is explained and nothing is sent; a bare filter is fixed in one click", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Search the directory" }).click();
  await filter(page).fill("(&(uid=ada)");
  // Unfinished text is not flagged while it is being typed; Enter says what is missing.
  await expect(page.getByText("Missing ) to close the ( at position 1.")).toHaveCount(0);
  await filter(page).press("Enter");
  await expect(page.getByText("Missing ) to close the ( at position 1.")).toBeVisible();
  await expect(page.getByText(/▲ character 12/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Search results" })).toHaveCount(0);

  await filter(page).fill("uid=ada");
  await page.getByRole("button", { name: "Use (uid=ada)" }).click();
  await expect(filter(page)).toHaveValue("(uid=ada)");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("table", { name: "Search results" })).toContainText("Ada Lovelace");
});

test("the first 500 of 1,182, 100 at a time", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Search the directory" }).click();
  await filter(page).fill("(objectClass=inetOrgPerson)");
  await filter(page).press("Enter");
  const table = page.getByRole("table", { name: "Search results" });
  await expect(table.getByRole("row")).toHaveCount(101);
  await expect(page.getByText("These are the first 500 entries.")).toBeVisible();
  await page.getByRole("button", { name: "Show 100 more" }).click();
  await expect(table.getByRole("row")).toHaveCount(201);
});

test("Search below here starts at the row; Night forest search reads in dark", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=groups/).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Search below here/ }).click();
  await expect(page.getByLabel("Start at")).toHaveValue("ou=groups,dc=example,dc=org");

  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Night forest" }).click();
  await filter(page).fill("(cn=a*)");
  await filter(page).press("Enter");
  await expect(page.getByRole("table", { name: "Search results" })).toContainText("admins");
  const dark = await page.evaluate(() => {
    const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
    return { input: bg(".kn-input"), table: bg(".kn-attrs"), page: getComputedStyle(document.body).backgroundColor };
  });
  expect(dark).toEqual({ input: "rgb(26, 35, 29)", table: "rgb(26, 35, 29)", page: "rgb(19, 26, 21)" });
});
