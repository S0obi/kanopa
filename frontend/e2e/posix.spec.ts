import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// posixGroups list their members by uid (memberUid). In a browser against the fake directory.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const bar = (page: Page) => page.getByRole("region", { name: "Pending changes" });

async function scan(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const report = violations.map((v) => `${where}: ${v.id} (${v.impact}) ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
  expect(report, `${where} has accessibility violations`).toEqual([]);
}

async function openGroup(page: Page, cn: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await row(page, /^ou=groups/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, new RegExp(`^cn=${cn} `)).click();
  await expect(page.locator("main h1", { hasText: cn })).toBeVisible();
  await page.getByRole("tab", { name: /Members/ }).click();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`in ${scheme === "light" ? "Clearing" : "Night forest"}`, () => {
    test.use({ colorScheme: scheme });

    test("a posixGroup's members, the picker and the new group form pass axe", async ({ page }) => {
      await openGroup(page, "unix-devs");
      await expect(page.getByText("No entry has this uid")).toBeVisible();
      // The tree has scrolled to unix-devs; axe misreads the rows scrolled out of its view, so scan from the top.
      await tree(page).evaluate((el) => (el.scrollTop = 0));
      await scan(page, "posix members");

      await page.getByRole("button", { name: "Add member" }).click();
      await page.getByRole("searchbox", { name: /Search people/ }).fill("edsger");
      await expect(page.getByRole("button", { name: "Add Edsger Dijkstra" })).toBeVisible();
      await scan(page, "posix member picker");

      await row(page, /^ou=groups/).click();
      await page.getByRole("button", { name: "New entry" }).click();
      const dialog = page.getByRole("dialog", { name: "New entry" });
      await dialog.getByRole("button", { name: /^POSIX group/ }).click();
      await expect(dialog.getByLabel(/Group ID/)).toHaveValue("2004");
      await scan(page, "new posix group dialog");
    });
  });
}

test("add a person to a posixGroup by uid, and save it", async ({ page }) => {
  await openGroup(page, "unix-devs");
  await expect(page.getByText("4 members")).toBeVisible();
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByRole("searchbox", { name: /Search people/ }).fill("edsger");
  await page.getByRole("button", { name: "Add Edsger Dijkstra" }).click();
  await expect(page.getByText("5 members")).toBeVisible();
  await expect(bar(page)).toContainText("Pending change: memberUid on cn=unix-devs");

  await bar(page).getByRole("button", { name: "Review LDIF" }).click();
  await expect(page.getByRole("region", { name: "Pending changes as LDIF" })).toContainText("memberUid: edsger");
  await page.keyboard.press("Control+s");
  await expect(page.getByText("Saved 1 change to localhost.")).toBeVisible();
  await page.getByRole("tab", { name: /Members/ }).click();
  await expect(page.locator("main li").filter({ hasText: "Edsger Dijkstra" })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
});

test("a person's Member of lists the posixGroups by uid, and leaving one is a pending change", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await row(page, /^ou=people/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^uid=alan /).click();
  await page.getByRole("tab", { name: /Member of/ }).click();
  await expect(page.locator("main").getByText("unix-staff", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove unix-staff" }).click();
  await expect(bar(page)).toContainText("Pending change: memberUid on cn=unix-staff");
});
