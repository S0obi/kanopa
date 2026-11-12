import { expect, test, type Page } from "@playwright/test";

// The S4 checklist, in a browser against the fake directory.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const table = (page: Page) => page.getByRole("table", { name: "Attributes" });
const bar = (page: Page) => page.getByRole("region", { name: "Pending changes" });

async function openAda(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await row(page, /^ou=people/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^uid=ada /).click();
  await expect(page.locator("main h1", { hasText: "Ada Lovelace" })).toBeVisible();
}

async function editTitle(page: Page, value: string) {
  await table(page).getByRole("row", { name: /title/ }).hover();
  await table(page).getByRole("button", { name: "Edit title" }).click();
  const input = page.getByRole("textbox", { name: "title value 1" });
  await input.fill(value);
  await input.press("Enter");
}

test("edit Ada's title and add a phone number, review the LDIF, apply", async ({ page }) => {
  await openAda(page);
  await editTitle(page, "Chief engineer");
  await expect(table(page).getByText("was Principal engineer")).toBeVisible();

  await page.getByRole("button", { name: "Add attribute" }).click();
  await page.getByRole("searchbox", { name: "Find an attribute" }).fill("tele");
  await page.getByRole("option", { name: /telephoneNumber/ }).click();
  await page.getByLabel(/Value for/).fill("+41 44 555 01 10");
  await page.getByLabel(/Value for/).press("Enter");
  await expect(bar(page)).toContainText("2 pending changes on 1 entry");

  await bar(page).getByRole("button", { name: "Review LDIF" }).click();
  const ldif = page.getByRole("region", { name: "Pending changes as LDIF" });
  await expect(ldif).toContainText("replace: title");
  await expect(ldif).toContainText("title: Chief engineer");
  await expect(ldif).toContainText("add: telephoneNumber");
  await expect(ldif).toContainText("telephoneNumber: +41 44 555 01 10");

  await page.keyboard.press("Control+s");
  await expect(page.getByText("Saved 2 changes to localhost.")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^LDIF of uid=ada/ })).toContainText("telephoneNumber: +41 44 555 01 10");
});

test("Discard puts the entry back", async ({ page }) => {
  await openAda(page);
  await editTitle(page, "Analyst");
  await bar(page).getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Discarded 1 change. Entries are as the server has them.")).toBeVisible();
  await expect(table(page).getByText("Principal engineer")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
});

test("a refused Apply keeps the changes and shows the code", async ({ page }) => {
  await openAda(page);
  await table(page).getByRole("row", { name: /^sn/ }).hover();
  await table(page).getByRole("button", { name: "Edit sn" }).click();
  await page.getByRole("textbox", { name: "sn value 1" }).fill("");
  await page.getByRole("button", { name: "Add to changes" }).click();
  await bar(page).getByRole("button", { name: /Apply/ }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Object class violation (65) — inetOrgPerson requires the attribute sn.");
  await expect(alert).toContainText("Your 1 pending change is kept.");
  await expect(bar(page)).toContainText("Pending change: sn on uid=ada");
});

test("closing the window with pending changes asks first", async ({ page }) => {
  await openAda(page);
  await editTitle(page, "Analyst");
  const fake = () => page.evaluate(() => (window as unknown as { kanopaFake: { window: { pending: number; closed: boolean } } }).kanopaFake.window);
  await expect.poll(async () => (await fake()).pending).toBe(1);
  await page.evaluate(() => (window as unknown as { kanopaFake: { requestClose(): void } }).kanopaFake.requestClose());
  const ask = page.getByRole("alertdialog", { name: "Close Kanopa with pending changes?" });
  await expect(ask).toContainText("1 change was not applied. Closing drops it.");
  await ask.getByRole("button", { name: "Discard and close" }).click();
  expect((await fake()).closed).toBe(true);
});
