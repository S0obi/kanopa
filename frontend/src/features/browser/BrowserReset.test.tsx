import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";

// Reset password: from the tree's menu, the entry's menu and the userPassword row, with "must change at next login".

async function open(uid = "ada", title = "Ada Lovelace") {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await out.user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
  await out.user.keyboard("{ArrowRight}");
  await out.user.click(await screen.findByRole("treeitem", { name: new RegExp(`^uid=${uid} `) }));
  await screen.findByRole("heading", { level: 1, name: title });
  return { ...out, backend };
}
type Opened = Awaited<ReturnType<typeof open>>;

const table = () => screen.getByRole("table", { name: "Attributes" });
const bar = () => screen.getByRole("region", { name: "Pending changes" });
const dn = (uid: string) => `uid=${uid},ou=people,dc=example,dc=org`;
const valuesOf = async (backend: Opened["backend"], uid: string, attr: string) => (await backend.entry("prod", dn(uid))).attributes?.find((a) => a.name === attr)?.values ?? [];

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.passwordPolicy = true;
  FAKE.activeDirectory = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

async function fill(user: Opened["user"], dialog: HTMLElement, password = "Reset-Passw0rd1") {
  await user.type(within(dialog).getByLabelText("New password"), password);
  await user.type(within(dialog).getByLabelText("Confirm password"), password);
}

describe("Reset password", () => {
  it("opens from the tree's menu, and sets the password and pwdReset on Apply", async () => {
    const { user, backend } = await open();
    await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("treeitem", { name: /^uid=ada / }) });
    await user.click(await screen.findByRole("menuitem", { name: /Reset password/ }));
    const d = await screen.findByRole("dialog", { name: "Reset password" });
    expect(within(d).getByText(/^For Ada Lovelace/)).toBeInTheDocument();
    const box = within(d).getByRole("checkbox", { name: /User must change password at next login/ });
    expect(box).not.toBeChecked();
    expect(within(d).getByText("Nothing is sent until you apply pending changes.")).toBeInTheDocument();

    await fill(user, d);
    await user.click(box);
    await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    expect(bar()).toHaveTextContent("2 pending changes on 1 entry");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("pwdReset: TRUE");
    expect(ldif).not.toHaveTextContent("Reset-Passw0rd1");

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByText(/^Saved 2 changes to localhost\./)).toBeInTheDocument();
    expect(await valuesOf(backend, "ada", "pwdReset")).toEqual(["TRUE"]);
  });

  it("sends only the password when the box stays unchecked", async () => {
    const { user, backend } = await open();
    await user.click(within(table()).getByRole("button", { name: "Edit userPassword" }));
    const d = screen.getByRole("dialog", { name: "Reset password" });
    await fill(user, d);
    await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    expect(bar()).toHaveTextContent("Pending change: userPassword on uid=ada");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByText(/^Saved 1 change to localhost\./)).toBeInTheDocument();
    expect(await valuesOf(backend, "ada", "pwdReset")).toEqual([]);
  });

  it("opens from the entry's own menu too, and asks for a password", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "More entry actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Reset password/ }));
    const d = await screen.findByRole("dialog", { name: "Reset password" });
    await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    expect(within(d).getByText("Enter a password.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pending changes" })).not.toBeInTheDocument();
  });

  it("locks the box on when the person's own policy asks for a new password, and sends nothing for it", async () => {
    const { user, backend } = await open("edsger", "Edsger Dijkstra");
    await user.click(screen.getByRole("button", { name: "More entry actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Reset password/ }));
    const d = await screen.findByRole("dialog", { name: "Reset password" });
    const box = await within(d).findByRole("checkbox", { name: /User must change password at next login/ });
    await screen.findByText("Your server's password policy requires this.");
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    await fill(user, d);
    await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    expect(bar()).toHaveTextContent("Pending change: userPassword on uid=edsger");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText(/^Saved 1 change to localhost\./);
    expect(await valuesOf(backend, "edsger", "pwdReset")).toEqual([]);
  });

  it("drops the pwdReset change again when the box is unchecked on a second go", async () => {
    const { user } = await open();
    const reset = async (check: boolean) => {
      await user.click(within(table()).getByRole("button", { name: "Edit userPassword" }));
      const d = screen.getByRole("dialog", { name: "Reset password" });
      await fill(user, d);
      if (check) await user.click(within(d).getByRole("checkbox", { name: /must change/ }));
      await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    };
    await reset(true);
    expect(bar()).toHaveTextContent("2 pending changes on 1 entry");
    await reset(false);
    expect(bar()).toHaveTextContent("Pending change: userPassword on uid=ada");
  });

  it("has no checkbox on a server without a password policy", async () => {
    FAKE.passwordPolicy = false;
    const { user } = await open();
    await user.click(within(table()).getByRole("button", { name: "Edit userPassword" }));
    const d = screen.getByRole("dialog", { name: "Reset password" });
    expect(within(d).queryByRole("checkbox")).not.toBeInTheDocument();
    await fill(user, d);
    await user.click(within(d).getByRole("button", { name: "Add to changes" }));
    expect(bar()).toHaveTextContent("Pending change: userPassword on uid=ada");
  });

  it("is off on Active Directory, with the reason, and the row keeps the old editor", async () => {
    FAKE.activeDirectory = true;
    const { user } = await open();
    await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("treeitem", { name: /^uid=ada / }) });
    const item = await screen.findByRole("menuitem", { name: /Reset password/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Not supported on Active Directory yet");
    await user.keyboard("{Escape}");
    await user.click(within(table()).getByRole("button", { name: "Edit userPassword" }));
    expect(screen.getByRole("dialog", { name: /Edit userPassword/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Reset password" })).not.toBeInTheDocument();
  });

  it("is off on a read-only connection", async () => {
    const backend = createFakeBackend({ connections: sampleConnections().map((c) => (c.id === "prod" ? { ...c, readOnly: true } : c)) });
    const r = await backend.connect("prod", "", false);
    useApp.setState({ view: { name: "connected", session: r.session! } });
    const { user } = renderWith(<BrowserScreen session={r.session!} />, backend);
    await user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
    await user.keyboard("{ArrowRight}");
    await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("treeitem", { name: /^uid=ada / }) });
    const item = await screen.findByRole("menuitem", { name: /Reset password/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Read-only");
  });
});

describe("a new person's password", () => {
  async function newPerson(user: Opened["user"], mustChange: boolean) {
    await user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
    await screen.findByRole("heading", { level: 1, name: "people" });
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const d = screen.getByRole("dialog", { name: "New entry" });
    await user.type(within(d).getByLabelText(/First name/), "Mary");
    await user.type(within(d).getByLabelText(/Last name/), "Jackson");
    // The box appears with the password, checked: a new account chooses its own at the first sign-in.
    expect(within(d).queryByRole("checkbox", { name: /must change/ })).not.toBeInTheDocument();
    await user.type(within(d).getByLabelText(/Initial password/), "First-Passw0rd9");
    await user.type(within(d).getByLabelText("Confirm password"), "First-Passw0rd9");
    const box = within(d).getByRole("checkbox", { name: /User must change password at next login/ });
    expect(box).toBeChecked();
    if (!mustChange) await user.click(box);
    await user.click(within(d).getByRole("button", { name: "Create entry" }));
  }

  it("is created asking for a new password at the first sign-in", async () => {
    const { user, backend } = await open();
    await newPerson(user, true);
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText(/^Saved 1 change to localhost\./);
    expect(await valuesOf(backend, "mjackson", "pwdReset")).toEqual(["TRUE"]);
  });

  it("can be created without it", async () => {
    const { user, backend } = await open();
    await newPerson(user, false);
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText(/^Saved 1 change to localhost\./);
    expect(await valuesOf(backend, "mjackson", "pwdReset")).toEqual([]);
  });
});
