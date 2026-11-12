import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";

const people = "ou=people,dc=example,dc=org";

async function open(patch: Record<string, unknown> = {}) {
  const backend = createFakeBackend({ connections: sampleConnections().map((c) => (c.id === "prod" ? { ...c, ...patch } : c)) });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  return { ...out, backend };
}

const tree = () => screen.getByRole("tree", { name: "Directory tree" });
const item = (name: RegExp) => within(tree()).findByRole("treeitem", { name });
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const menuOf = (rdn: string) => screen.findByRole("menu", { name: `Actions for ${rdn}` });
const names = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((i) => i.textContent);

async function rightClick(name: RegExp) {
  fireEvent.contextMenu(await item(name), { clientX: 40, clientY: 80 });
}

async function openGroups(user: Awaited<ReturnType<typeof open>>["user"]) {
  await user.click(await item(/^ou=groups/));
  await user.keyboard("{ArrowRight}");
  await item(/^cn=admins/);
}

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.failReferrers = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("the tree's right-click menu", () => {
  it("selects the row and lists the actions that fit it", async () => {
    await open();
    await rightClick(/^ou=people/);
    const menu = await menuOf("ou=people");
    expect(await item(/^ou=people/)).toHaveAttribute("aria-selected", "true");
    expect(await heading("people")).toBeInTheDocument();
    expect(names(menu)).toEqual(["Copy DNCtrl+C", "New child entry…", "Rename…Has children", "Delete…Del"]);
    expect(within(menu).getByRole("menuitem", { name: /Rename/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("copies the DN, and Esc gives focus back to the tree", async () => {
    const { user, backend } = await open();
    await rightClick(/^ou=people/);
    await user.click(within(await menuOf("ou=people")).getByRole("menuitem", { name: /Copy DN/ }));
    expect(backend.clipboard.text).toBe(people);
    expect(await screen.findByText("Copied the DN.")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(tree()).toHaveFocus();

    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await menuOf("ou=people")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(tree()).toHaveFocus();
  });

  it("adds a member to a group: Members tab, picker open", async () => {
    const { user } = await open();
    await openGroups(user);
    await rightClick(/^cn=admins/);
    await user.click(within(await menuOf("cn=admins")).getByRole("menuitem", { name: "Add member…" }));
    await heading("admins");
    const search = await screen.findByRole("searchbox", { name: /Search people/ });
    expect(screen.getByRole("tab", { name: /Members/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, "katherine");
    await user.click(await screen.findByRole("button", { name: "Add Katherine Johnson" }));
    expect(screen.getByRole("region", { name: "Pending changes" })).toHaveTextContent("Pending change: member on cn=admins");
  });

  it("opens New entry, Rename and Delete in the entry view", async () => {
    const { user } = await open();
    await rightClick(/^ou=people/);
    await user.click(within(await menuOf("ou=people")).getByRole("menuitem", { name: "New child entry…" }));
    const dialog = await screen.findByRole("dialog", { name: "New entry" });
    expect(dialog).toHaveTextContent(`,${people}`);
    await user.keyboard("{Escape}");

    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await rightClick(/^uid=ada /);
    await user.click(within(await menuOf("uid=ada")).getByRole("menuitem", { name: /Rename/ }));
    expect(await screen.findByRole("dialog", { name: /Rename uid=ada/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await rightClick(/^uid=alan /);
    await user.click(within(await menuOf("uid=alan")).getByRole("menuitem", { name: /Delete/ }));
    expect(await screen.findByRole("alertdialog", { name: /Delete uid=alan/ })).toBeInTheDocument();
  });

  it("runs the shortcuts on the active row: Ctrl+C, F2, Del", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^uid=ada /));
    await heading("Ada Lovelace");
    await user.keyboard("{Control>}c{/Control}");
    expect(backend.clipboard.text).toBe(`uid=ada,${people}`);
    await user.keyboard("{F2}");
    expect(await screen.findByRole("dialog", { name: /Rename uid=ada/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    tree().focus();
    await user.keyboard("{Delete}");
    expect(await screen.findByRole("alertdialog", { name: /Delete uid=ada/ })).toBeInTheDocument();
  });

  it("leaves only Copy DN on an entry marked for deletion, and on a read-only connection", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await rightClick(/^uid=alan /);
    await user.click(within(await menuOf("uid=alan")).getByRole("menuitem", { name: /Delete/ }));
    const ask = await screen.findByRole("alertdialog", { name: /Delete uid=alan/ });
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Delete entry" })).toBeEnabled());
    await user.click(within(ask).getByRole("button", { name: "Delete entry" }));
    await rightClick(/^uid=alan .*delete/);
    const menu = await menuOf("uid=alan");
    expect(names(menu)).toEqual(["Copy DNCtrl+C", "Rename…Marked for deletion", "Delete…Marked for deletion"]);
    // A shortcut on it does nothing either.
    await user.keyboard("{Escape}{F2}");
    expect(screen.queryByRole("dialog", { name: /Rename/ })).not.toBeInTheDocument();
  });

  it("disables the shaping actions on a read-only connection", async () => {
    await open({ readOnly: true });
    await rightClick(/^ou=people/);
    expect(names(await menuOf("ou=people"))).toEqual(["Copy DNCtrl+C", "New child entry…Read-only", "Rename…Read-only", "Delete…Read-only"]);
  });
});
