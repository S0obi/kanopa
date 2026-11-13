import { expect, test, type Page } from "@playwright/test";

// Flows from the S1 and S2 human checklists, in a browser against the fake backend.
// The fake starts with the design's four sample connections; `?empty` starts with none.

const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });

/** The browser screen of a connection: its name in the header, and the tree. */
function connectedTo(page: Page, name: string) {
  return page.locator("header").getByRole("heading", { level: 1, name, exact: true }).and(page.locator("h1")).first();
}

async function fillNew(page: Page, name: string, url: string, bindDn?: string, password?: string) {
  await page.getByLabel("Connection name").fill(name);
  await page.getByLabel("LDAP URL").fill(url);
  if (bindDn !== undefined) await page.getByLabel("Bind DN").fill(bindDn);
  if (password !== undefined) await page.getByLabel("Password", { exact: true }).fill(password);
}

async function verificationOff(page: Page) {
  await page.getByRole("button", { name: /Advanced/ }).click();
  await page.getByLabel("Verify the server certificate against the system trust store").uncheck();
}

test("the window shows Kanopa and the saved connections", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Kanopa");
  await expect(page.getByRole("heading", { name: "Choose a connection" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(5);
  await expect(page.getByText("4 saved connections")).toBeVisible();
});

test("create a connection, test it, save and connect", async ({ page }) => {
  await page.goto("/?empty");
  await expect(page.getByText("No saved connections yet")).toBeVisible();
  await page.keyboard.press("Control+n");
  const d = dialog(page, "New connection");
  await fillNew(page, "Test directory", "ldaps://localhost:636", "cn=admin,dc=example,dc=org", "kanopa-admin");
  await verificationOff(page);
  await d.getByRole("button", { name: "Test connection" }).click();
  await expect(d.getByRole("status").filter({ hasText: "Connection works" })).toContainText(
    /Bound as cn=admin,dc=example,dc=org in \d+ ms over LDAPS\. The server offers 1 naming context: dc=example,dc=org\./,
  );
  await page.keyboard.press("Control+Enter");
  await expect(connectedTo(page, "Test directory")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Directory tree" })).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("1 saved connection")).toBeVisible();
  await expect(page.getByRole("row", { name: /Test directory/ })).toContainText(/Today, \d\d:\d\d/);
});

test("switching LDAPS to StartTLS rewrites the URL; Fetch from server fills the base DN", async ({ page }) => {
  await page.goto("/?empty");
  await page.getByRole("button", { name: "New connection" }).first().click();
  await fillNew(page, "T", "ldaps://localhost:636", "cn=admin,dc=example,dc=org", "kanopa-admin");
  await page.getByRole("button", { name: "StartTLS" }).click();
  await expect(page.getByLabel("LDAP URL")).toHaveValue("ldap://localhost:389");
  await verificationOff(page);
  await page.getByRole("button", { name: "Fetch from server" }).click();
  await expect(page.getByLabel("Base DN")).toHaveValue("dc=example,dc=org");
});

test("a refused password leads to Update password, which fixes it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Corporate Active Directory" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Invalid credentials (49)");
  await alert.getByRole("button", { name: "Update password" }).click();
  const d = dialog(page, "Edit connection");
  await expect(d).toContainText("The server refused the saved password");
  await expect(d.getByLabel("Password", { exact: true })).toBeFocused();
  // The fake knows this account under the fixture's reader DN.
  await d.getByLabel("Bind DN").fill("uid=svc-kanopa,ou=services,dc=example,dc=org");
  await d.getByLabel("Password", { exact: true }).fill("kanopa-reader");
  await d.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved changes to “Corporate Active Directory”.")).toBeVisible();
  await page.getByRole("button", { name: "Connect to Corporate Active Directory" }).click();
  await expect(connectedTo(page, "Corporate Active Directory")).toBeVisible();
});

test("an unencrypted connection asks once", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Local OpenLDAP" }).click();
  await page.getByRole("alertdialog", { name: "Connect without encryption?" }).getByRole("button", { name: "Connect anyway" }).click();
  await expect(connectedTo(page, "Local OpenLDAP")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Connect to Local OpenLDAP" }).click();
  await expect(connectedTo(page, "Local OpenLDAP")).toBeVisible();
});

test("edit, duplicate and delete from the row menu", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Actions for Staging" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(dialog(page, "Edit connection").getByLabel("Connection name")).toHaveValue("Staging (copy)");
  await page.keyboard.press("Escape");
  await expect(page.getByText("5 saved connections")).toBeVisible();

  await page.getByRole("button", { name: "Actions for Staging (copy)" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete connection" }).click();
  await expect(page.getByText("Deleted the connection “Staging (copy)”.")).toBeVisible();
  await expect(page.getByText("4 saved connections")).toBeVisible();
});

test("keyboard only: filter, pick, connect, disconnect", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("4 saved connections")).toBeVisible();
  await page.keyboard.press("Control+f");
  await page.keyboard.type("openldap");
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").getByRole("button", { name: "Connect anyway" }).press("Enter");
  await expect(connectedTo(page, "Local OpenLDAP")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Choose a connection" })).toBeVisible();
});

test("a server that is not running is Can't contact LDAP server (-1)", async ({ page }) => {
  await page.goto("/?empty");
  await page.getByRole("button", { name: "New connection" }).first().click();
  await fillNew(page, "Down", "ldap://localhost:10389");
  await page.getByRole("combobox", { name: "Bind method" }).click();
  await page.getByRole("option", { name: "Anonymous" }).click();
  await page.getByRole("button", { name: "None" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog(page, "New connection").getByRole("alert")).toContainText("Start the LDAP server on this computer, then try again. Can't contact LDAP server (-1)");
});
