import { expect, test, type Page } from "@playwright/test";

// Flows from the S1 human checklist, in a browser against the fake backend.

async function fill(page: Page, url: string, bindDn?: string, password?: string) {
  await page.getByLabel("LDAP URL").fill(url);
  if (bindDn !== undefined) await page.getByLabel("Bind DN").fill(bindDn);
  if (password !== undefined) await page.getByLabel("Password", { exact: true }).fill(password);
}

async function verificationOff(page: Page) {
  await page.getByRole("button", { name: /Advanced/ }).click();
  await page.getByLabel("Verify the server certificate against the system trust store").uncheck();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("the window shows Kanopa and the connection form", async ({ page }) => {
  await expect(page).toHaveTitle("Kanopa");
  await expect(page.getByRole("img", { name: "Kanopa" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Test a connection" })).toBeVisible();
});

test("admin over LDAPS with verification off works", async ({ page }) => {
  await fill(page, "ldaps://localhost:636", "cn=admin,dc=example,dc=org", "kanopa-admin");
  await verificationOff(page);
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connection works" })).toContainText(
    /Bound as cn=admin,dc=example,dc=org in \d+ ms over LDAPS\. The server offers 1 naming context: dc=example,dc=org\./,
  );
});

test("a wrong password is Invalid credentials (49)", async ({ page }) => {
  await fill(page, "ldaps://localhost:636", "cn=admin,dc=example,dc=org", "nope");
  await verificationOff(page);
  await page.getByLabel("Password", { exact: true }).press("Control+Enter");
  await expect(page.getByRole("alert")).toContainText("Invalid credentials (49)");
});

test("switching LDAPS to StartTLS rewrites the URL", async ({ page }) => {
  await fill(page, "ldaps://localhost:636");
  await page.getByRole("button", { name: "StartTLS" }).click();
  await expect(page.getByLabel("LDAP URL")).toHaveValue("ldap://localhost:389");
});

test("Fetch from server fills the base DN", async ({ page }) => {
  await fill(page, "ldaps://localhost:636", "cn=admin,dc=example,dc=org", "kanopa-admin");
  await verificationOff(page);
  await page.getByRole("button", { name: "Fetch from server" }).click();
  await expect(page.getByLabel("Base DN")).toHaveValue("dc=example,dc=org");
});

test("a server that is not running is Can't contact LDAP server (-1)", async ({ page }) => {
  await fill(page, "ldap://localhost:10389");
  await page.getByLabel("Bind method").selectOption("anonymous");
  await page.getByRole("button", { name: "None" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("alert")).toContainText("Start the LDAP server on this computer, then try again. Can't contact LDAP server (-1)");
});

test("the whole form is reachable by keyboard", async ({ page }) => {
  const names: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    names.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? document.activeElement?.id ?? ""));
  }
  expect(names).toEqual(expect.arrayContaining(["LDAPS", "Fetch from server", "Show password", "Test connection"]));
});
