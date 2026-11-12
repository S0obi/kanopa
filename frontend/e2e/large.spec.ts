import { expect, test, type Page } from "@playwright/test";

// The large profile in the fake directory (?large): ou=archive with 10,000 people and cn=everyone with
// 5,000 members. Each step has a generous time limit: many times what a laptop measures, so a real
// regression fails it and a slow CI runner does not.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const title = (page: Page, name: string) => page.locator("main h1", { hasText: name });

async function timed(label: string, budgetMs: number, f: () => Promise<void>) {
  const start = Date.now();
  await f();
  const took = Date.now() - start;
  test.info().annotations.push({ type: "timing", description: `${label}: ${took} ms (limit ${budgetMs})` });
  expect(took, `${label} took ${took} ms`).toBeLessThan(budgetMs);
}

async function connect(page: Page) {
  await page.goto("/?large");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

test("an OU of 10,000 children opens, scrolls to its end, and stays responsive", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=archive/).click();
  await timed("open the 10,000 children of ou=archive", 3000, async () => {
    await page.keyboard.press("ArrowRight");
    await expect(row(page, /^uid=arch00001 /)).toBeVisible();
  });
  // Only the rows in view are in the page.
  expect(await tree(page).getByRole("treeitem").count()).toBeLessThan(120);
  await timed("jump to the last row of the tree", 2000, async () => {
    await page.keyboard.press("End");
    // The last row of the tree is "Show 9,500 more": the 10,000 are listed 500 at a time.
    await expect(page.getByRole("button", { name: /^Show [\d,]+ more$/ })).toBeVisible();
  });
});

test("a group of 5,000 members opens in every view without drawing them all", async ({ page }) => {
  await connect(page);
  await timed("search for the group and open it", 3000, async () => {
    await page.getByRole("combobox", { name: "Search entries" }).fill("everyone");
    await page.getByRole("option", { name: /everyone/ }).first().click();
    await expect(title(page, "everyone")).toBeVisible();
  });
  await timed("the Members tab", 3000, async () => {
    await page.getByRole("tab", { name: /Members/ }).click();
    await expect(page.getByRole("heading", { name: "5,000 members" })).toBeVisible();
  });
  expect(await page.locator("[role=tabpanel] ul > li").count()).toBeLessThan(120);

  await timed("the LDIF tab", 3000, async () => {
    await page.getByRole("tab", { name: "LDIF" }).click();
    await expect(page.getByRole("region", { name: /LDIF of cn=everyone/ })).toBeVisible();
  });
  expect(await page.locator(".kn-ldif__line").count()).toBeLessThan(400);

  await page.getByRole("tab", { name: /^Attributes/ }).click();
  await timed("Show all 5,000 member values", 3000, async () => {
    await page.getByRole("button", { name: "Show all 5,000 member values" }).click();
    await expect(page.getByTitle(/^Open uid=arch/).nth(30)).toBeVisible();
  });
  expect(await page.getByTitle(/^Open uid=arch/).count()).toBeLessThan(150);

  await timed("the value editor with 5,000 values", 5000, async () => {
    await page.locator("table[aria-label=Attributes] tr", { hasText: "member" }).first().hover();
    await page.getByRole("button", { name: "Edit member" }).click();
    await expect(page.getByRole("dialog", { name: /Edit member/ })).toBeVisible();
  });
  expect(await page.getByRole("textbox", { name: /^member value \d+$/ }).count()).toBeLessThan(120);
});

test("the header search answers over 11,000 people", async ({ page }) => {
  await connect(page);
  await timed("search for a word", 2000, async () => {
    await page.getByRole("combobox", { name: "Search entries" }).fill("archive");
    await expect(page.getByRole("option")).toHaveCount(10);
    await expect(page.getByRole("listbox")).toContainText("10 of 200+");
  });
});
