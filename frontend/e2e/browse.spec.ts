import { expect, test, type Page } from "@playwright/test";

// The S3 checklist, in a browser against the fake directory (the test server's data).

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const entryTitle = (page: Page, name: string) => page.locator("main h1", { hasText: name });

async function openProduction(page: Page) {
  await page.goto("/");
  await expect(page.getByText("4 saved connections")).toBeVisible();
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

test("the tree opens on the base DN", async ({ page }) => {
  await openProduction(page);
  await expect(row(page, /^dc=example,dc=org/)).toHaveAttribute("aria-expanded", "true");
  for (const ou of ["people", "groups", "services", "hosts"]) await expect(row(page, new RegExp(`^ou=${ou}`))).toBeVisible();
  await expect(row(page, /^ou=partners/)).toContainText("referral");
  await expect(page.getByText("Bound as cn=admin,dc=example,dc=org")).toBeVisible();
});

test("1,182 people page by page, smoothly", async ({ page }) => {
  await openProduction(page);
  await row(page, /^ou=people/).click();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, /^ou=people/)).toContainText("1,182");
  // Scroll to the end of the first page.
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("button", { name: "Show 682 more" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Show 182 more" })).toBeVisible();
  await page.getByRole("button", { name: "Show 182 more" }).click();
  await expect(page.getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);
  // Only the rows in view are in the page.
  expect(await tree(page).getByRole("treeitem").count()).toBeLessThan(120);
});

test("Ada: attributes, LDIF, member of, DN links, breadcrumb", async ({ page }) => {
  await openProduction(page);
  await row(page, /^ou=people/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^uid=ada,/).click();
  await expect(entryTitle(page, "Ada Lovelace")).toBeVisible();
  const table = page.getByRole("table", { name: "Attributes" });
  await expect(table).toContainText("JPEG image · 14,236 bytes");
  await expect(table).toContainText("{SSHA} hashed value");

  await page.getByRole("tab", { name: "LDIF" }).click();
  await expect(page.getByRole("region", { name: /^LDIF of uid=ada/ })).toContainText("dn: uid=ada,ou=people,dc=example,dc=org");

  await page.getByRole("tab", { name: /Member of/ }).click();
  await expect(page.getByText("Member of 3 groups")).toBeVisible();
  await expect(page.locator("main li")).toHaveText([/admins/, /engineering/, /research/]);

  await page.getByRole("tab", { name: /Attributes/ }).click();
  await page.getByRole("button", { name: "uid=grace,ou=people,dc=example,dc=org" }).click();
  await expect(entryTitle(page, "Grace Hopper")).toBeVisible();
  await expect(row(page, /^uid=grace,/)).toHaveAttribute("aria-selected", "true");

  await page.getByRole("navigation", { name: "Distinguished name" }).getByRole("button", { name: "ou=people" }).click();
  await expect(entryTitle(page, "people")).toBeVisible();
});

test("the keyboard walks the tree", async ({ page }) => {
  await openProduction(page);
  await tree(page).focus();
  await page.keyboard.press("ArrowDown"); // ou=people
  await page.keyboard.press("ArrowRight"); // open it
  await expect(row(page, /^uid=ada,/)).toBeVisible();
  await page.keyboard.press("ArrowRight"); // first child
  await expect(entryTitle(page, "Ada Lovelace")).toBeVisible();
  await page.keyboard.press("ArrowLeft"); // back to ou=people
  await page.keyboard.press("ArrowLeft"); // close it
  await expect(row(page, /^ou=people/)).toHaveAttribute("aria-expanded", "false");
});

test("a lost connection, then Reconnect, lands on the same entry", async ({ page }) => {
  await openProduction(page);
  await row(page, /^ou=services/).click();
  await expect(entryTitle(page, "services")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { kanopaFake: { lost: boolean } }).kanopaFake.lost = true));
  await row(page, /^ou=hosts/).click();
  await page.keyboard.press("ArrowRight");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Connection to localhost lost.");
  await expect(alert).toContainText("Server is unavailable (52)");
  await page.evaluate(() => ((window as unknown as { kanopaFake: { lost: boolean } }).kanopaFake.lost = false));
  await alert.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(entryTitle(page, "hosts")).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
