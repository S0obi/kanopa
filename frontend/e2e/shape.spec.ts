import { expect, test, type Page } from "@playwright/test";

// The S5 checklist, in a browser against the fake directory.

const tree = (page: Page) => page.getByRole("tree", { name: "Directory tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const bar = (page: Page) => page.getByRole("region", { name: "Pending changes" });
const title = (page: Page, name: string) => page.locator("main h1", { hasText: name });
const people = "ou=people,dc=example,dc=org";

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Production directory" }).click();
  await expect(row(page, /^ou=people/)).toBeVisible();
}

async function menu(page: Page, action: RegExp) {
  await page.getByRole("button", { name: "More entry actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test("create a person, add them to a group, rename them, apply", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=people/).click();
  await expect(title(page, "people")).toBeVisible();
  await page.getByRole("button", { name: "New entry" }).click();
  const dialog = page.getByRole("dialog", { name: "New entry" });
  await dialog.getByLabel(/First name/).fill("Zoë");
  await dialog.getByLabel(/Last name/).fill("Kanopa");
  await expect(dialog.getByLabel(/User ID/)).toHaveValue("zoe");
  await dialog.getByLabel(/Initial password/).fill("zoe-Passw0rd");
  await dialog.getByRole("button", { name: "Create entry" }).click();
  await expect(title(page, "Zoë Kanopa")).toBeVisible();
  await expect(page.getByText("Not on the server yet.")).toBeVisible();

  // Create first, then add her to a group from the group's Members tab.
  await page.keyboard.press("Control+s");
  await expect(page.getByText("Saved 1 change to localhost.")).toBeVisible();
  await expect(page.getByText("Not on the server yet.")).toHaveCount(0);

  await page.getByRole("tab", { name: /Member of/ }).click();
  await page.getByRole("button", { name: "Add to group" }).click();
  await page.getByRole("searchbox", { name: /Search groups/ }).fill("research");
  await page.getByRole("button", { name: "Add research" }).click();
  await expect(bar(page)).toContainText("Pending change: member on cn=research");

  await menu(page, /Rename/);
  const rename = page.getByRole("dialog", { name: /Rename uid=zoe/ });
  // The research membership is pending, not on the server yet: Apply sends it with the new DN.
  await rename.getByRole("textbox", { name: /New name/ }).fill("zoe.kanopa");
  await rename.getByRole("button", { name: "Rename entry" }).click();
  await expect(page.getByText("Pending rename.")).toBeVisible();

  await bar(page).getByRole("button", { name: "Review LDIF" }).click();
  const ldif = page.getByRole("region", { name: "Pending changes as LDIF" });
  await expect(ldif).toContainText("changetype: modrdn");
  await expect(ldif).toContainText(`member: uid=zoe.kanopa,${people}`);

  await bar(page).getByRole("button", { name: /Apply/ }).click();
  await expect(page.getByText("Saved 2 changes to localhost.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Distinguished name" })).toContainText("uid=zoe.kanopa");
  await page.getByRole("tab", { name: /Member of/ }).click();
  await expect(page.getByText("Member of 1 group")).toBeVisible();
});

test("delete with cleanup; a container with children is blocked", async ({ page }) => {
  await connect(page);
  await row(page, /^ou=people/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^uid=alan,/).click();
  await expect(title(page, "Alan Turing")).toBeVisible();
  await menu(page, /Delete entry/);
  const ask = page.getByRole("alertdialog", { name: /Delete uid=alan/ });
  await expect(ask).toContainText("The entry and its 2 group memberships are removed");
  await expect(ask.getByRole("checkbox")).toBeChecked();
  await ask.getByRole("button", { name: "Delete entry" }).click();
  await expect(page.getByText("Marked for deletion.")).toBeVisible();
  await expect(row(page, /^uid=alan, Alan Turing, pending delete/)).toBeVisible();
  await bar(page).getByRole("button", { name: /Apply/ }).click();
  await expect(page.getByText("Saved 3 changes to localhost.")).toBeVisible();
  await expect(row(page, /^uid=alan,/)).toHaveCount(0);

  await page.getByRole("button", { name: "Collapse all" }).click();
  await row(page, /^dc=example,dc=org/).click();
  await page.keyboard.press("ArrowRight");
  await row(page, /^ou=hosts/).click();
  await expect(title(page, "hosts")).toBeVisible();
  await menu(page, /Delete entry/);
  const blocked = page.getByRole("alertdialog", { name: /Delete ou=hosts/ });
  await expect(blocked).toContainText("ou=hosts still has 70 entries below it.");
  await expect(blocked.getByRole("button", { name: "Delete entry" })).toBeDisabled();
});
