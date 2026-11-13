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
const bar = () => screen.getByRole("region", { name: "Pending changes" });
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

async function openPerson(user: Awaited<ReturnType<typeof open>>["user"], uid: string, name: string) {
  await user.click(await item(/^ou=people/));
  await user.keyboard("{ArrowRight}");
  await user.click(await item(new RegExp(`^uid=${uid} `)));
  await heading(name);
}

async function menu(user: Awaited<ReturnType<typeof open>>["user"], action: RegExp) {
  await user.click(screen.getByRole("button", { name: "More entry actions" }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.failReferrers = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("shaping the tree", () => {
  it("creates a person: uid is the first letter and the last name, cn follows the names, then Apply writes it", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=people/));
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.type(within(dialog).getByLabelText(/First name/), "Zoë");
    await user.type(within(dialog).getByLabelText(/Last name/), "Kanopa");
    expect(within(dialog).getByLabelText(/User ID/)).toHaveValue("zkanopa");
    expect(within(dialog).getByLabelText(/Full name/)).toHaveValue("Zoë Kanopa");
    expect(within(dialog).getByText(`,${people}`).closest("code")).toHaveTextContent(`uid=zkanopa,${people}`);
    await user.type(within(dialog).getByLabelText(/Initial password/), "zoe-Passw0rd");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    // The initial password is typed twice too.
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The passwords don't match.");
    await user.type(within(dialog).getByLabelText("Confirm password"), "zoe-Passw0rd");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));

    expect(await heading("Zoë Kanopa")).toBeInTheDocument();
    expect(screen.getByText("Not on the server yet.")).toBeInTheDocument();
    expect(await item(/^uid=zkanopa Zoë Kanopa new/)).toBeInTheDocument();
    expect(bar()).toHaveTextContent("Pending change: new entry uid=zkanopa");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("changetype: add");
    expect(ldif).not.toHaveTextContent("zoe-Passw0rd");

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByText("Saved 1 change to localhost.")).toBeInTheDocument();
    const e = await backend.entry("prod", `uid=zkanopa,${people}`);
    expect(e.failure).toBeNull();
    expect((e.attributes ?? []).find((a) => a.name === "userPassword")?.values?.[0]).toMatch(/^\{SSHA\}/);
  });

  it("creates a group with members found through the search", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=groups/));
    await heading("groups");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /^Group/ }));
    await user.type(within(dialog).getByLabelText(/Group name/), "kanopa-team");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    expect(within(dialog).getByText(/groupOfNames requires the attribute member/)).toBeInTheDocument();

    const search = within(dialog).getByRole("searchbox", { name: /Search people/ });
    await user.type(search, "lovelace");
    await user.click(await within(dialog).findByRole("button", { name: "Add Ada Lovelace" }));
    await user.clear(search);
    await user.type(search, "grace");
    await user.click(await within(dialog).findByRole("button", { name: "Add Grace Hopper" }));
    expect(within(dialog).getByText("2 members")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await heading("kanopa-team");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    const g = await backend.entry("prod", "cn=kanopa-team,ou=groups,dc=example,dc=org");
    expect((g.attributes ?? []).find((a) => a.name === "member")?.values).toEqual([`uid=ada,${people}`, `uid=grace,${people}`]);
  });

  it("renames Ada and keeps her groups in step", async () => {
    const { user, backend } = await open();
    await openPerson(user, "ada", "Ada Lovelace");
    await menu(user, /Rename/);
    const dialog = await screen.findByRole("dialog", { name: /Rename uid=ada/ });
    await waitFor(() => expect(within(dialog).getByText(/5 groups listing it are updated too/)).toBeInTheDocument());
    const input = within(dialog).getByRole("textbox", { name: /New name/ });
    await user.clear(input);
    await user.type(input, "ada.lovelace{Enter}");

    expect(screen.getByText("Pending rename.")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("6 pending changes on 6 entries");
    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("changetype: modrdnnewrdn: uid=ada.lovelacedeleteoldrdn: 1");
    expect(ldif).toHaveTextContent(`add: membermember: uid=ada.lovelace,${people}`);
    // The posixGroups that list her uid follow the new uid.
    expect(ldif).toHaveTextContent("add: memberUidmemberUid: ada.lovelace");

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 6 changes to localhost.");
    expect(await screen.findByRole("navigation", { name: "Distinguished name" })).toHaveTextContent("uid=ada.lovelace");
    const refs = await backend.referrers("prod", `uid=ada.lovelace,${people}`);
    expect((refs.entries ?? []).map((g) => g.name)).toEqual(["admins", "engineering", "research", "unix-devs", "unix-staff"]);
  });

  it("deletes Alan with cleanup, and Undo puts things back first", async () => {
    const { user, backend } = await open();
    await openPerson(user, "alan", "Alan Turing");
    await menu(user, /Delete entry/);
    const ask = await screen.findByRole("alertdialog", { name: /Delete uid=alan/ });
    await waitFor(() => expect(ask).toHaveTextContent("The entry and its 3 group memberships are removed from localhost when you apply."));
    expect(within(ask).getByRole("checkbox")).toBeChecked();
    await user.click(within(ask).getByRole("button", { name: "Delete entry" }));
    expect(screen.getByText("Marked for deletion.")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("4 pending changes on 4 entries");

    await user.click(screen.getByRole("button", { name: "Undo delete" }));
    expect(screen.queryByRole("region", { name: "Pending changes" })).not.toBeInTheDocument();

    await menu(user, /Delete entry/);
    const again = await screen.findByRole("alertdialog", { name: /Delete uid=alan/ });
    await waitFor(() => expect(within(again).getByRole("button", { name: "Delete entry" })).toBeEnabled());
    await user.click(within(again).getByRole("button", { name: "Delete entry" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 4 changes to localhost.");
    expect((await backend.entry("prod", `uid=alan,${people}`)).failure?.code).toBe(32);
    expect((await backend.referrers("prod", `uid=alan,${people}`)).entries).toEqual([]);
  });

  it("won't delete ou=hosts: it has 70 entries below it", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=hosts/));
    await heading("hosts");
    await menu(user, /Delete entry/);
    const ask = await screen.findByRole("alertdialog", { name: /Delete ou=hosts/ });
    await waitFor(() => expect(ask).toHaveTextContent("ou=hosts still has 70 entries below it."));
    expect(ask).toHaveTextContent("Not allowed on non-leaf (66)");
    expect(within(ask).getByRole("button", { name: "Delete entry" })).toBeDisabled();
  });

  it("creates a device with the Other type", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=hosts/));
    await heading("hosts");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /Other/ }));
    await user.type(await within(dialog).findByRole("searchbox", { name: /Find an object class/ }), "dev");
    await user.click(await within(dialog).findByRole("button", { name: "Add device" }));
    await user.type(within(dialog).getByLabelText(/^cn/), "printer01");
    expect(within(dialog).getByText("objectClass: device, top")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect((await backend.entry("prod", "cn=printer01,ou=hosts,dc=example,dc=org")).type).toBe("server");
  });

  it("manages members from the group", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=groups/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^cn=admins/));
    await heading("admins");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    await user.click(screen.getByRole("button", { name: "Remove grace" }));
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await user.type(screen.getByRole("searchbox", { name: /Search people/ }), "katherine");
    await user.click(await screen.findByRole("button", { name: "Add Katherine Johnson" }));
    expect(bar()).toHaveTextContent("Pending change: member on cn=admins");
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });

  it("keeps pending changes across a dropped connection", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.type(within(dialog).getByLabelText(/Last name/), "Lost");
    await user.type(within(dialog).getByLabelText(/User ID/), "lost");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    FAKE.lost = true;
    await user.click(await item(/^ou=hosts/));
    await user.keyboard("{ArrowRight}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your 1 pending change is kept.");
    FAKE.lost = false;
    await user.click(within(alert).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByText("Saved 1 change to localhost.")).toBeInTheDocument();
  });

  it("offers no shaping on a read-only connection", async () => {
    const { user } = await open({ readOnly: true });
    await user.click(await item(/^ou=people/));
    await heading("people");
    expect(screen.queryByRole("button", { name: "New entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More entry actions" })).not.toBeInTheDocument();
  });

  it("a deleted DN can be used again once applied", async () => {
    const { user } = await open();
    await openPerson(user, "alan", "Alan Turing");
    await menu(user, /Delete entry/);
    const ask = await screen.findByRole("alertdialog", { name: /Delete uid=alan/ });
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Delete entry" })).toBeEnabled());
    await user.click(within(ask).getByRole("button", { name: "Delete entry" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 4 changes to localhost.");
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.type(within(dialog).getByLabelText(/Last name/), "Turing");
    await user.type(within(dialog).getByLabelText(/User ID/), "alan");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    expect(screen.queryByText(/Entry already exists/)).not.toBeInTheDocument();
    expect(await heading("Turing")).toBeInTheDocument();
  });

  it("won't rename or delete when it can't find the groups to update", async () => {
    FAKE.failReferrers = true;
    const { user } = await open();
    await openPerson(user, "ada", "Ada Lovelace");
    await menu(user, /Rename/);
    const rename = await screen.findByRole("dialog", { name: /Rename uid=ada/ });
    expect(await within(rename).findByText(/couldn't find the groups that list this entry/)).toBeInTheDocument();
    await user.type(within(rename).getByRole("textbox", { name: /New name/ }), "x{Enter}");
    expect(screen.queryByText("Pending rename.")).not.toBeInTheDocument();
    await user.click(within(rename).getByRole("button", { name: "Cancel" }));

    await menu(user, /Delete entry/);
    const ask = await screen.findByRole("alertdialog", { name: /Delete uid=ada/ });
    expect(await within(ask).findByText(/Administrative limit exceeded \(11\)/)).toBeInTheDocument();
    expect(within(ask).getByRole("button", { name: "Delete entry" })).toBeDisabled();
  });

  it("Member of shows a join made in the group's attribute editor", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=groups/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^cn=admins/));
    await heading("admins");
    const table = screen.getByRole("table", { name: "Attributes" });
    await user.click(within(table).getByRole("button", { name: "Edit member" }));
    const editor = screen.getByRole("dialog", { name: /Edit member/ });
    await user.click(within(editor).getByRole("button", { name: "Add value" }));
    await user.type(within(editor).getByRole("textbox", { name: "member value 3" }), `uid=katherine,${people}{Enter}`);
    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^uid=katherine /));
    await heading("Katherine Johnson");
    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    // Katherine is in research and support; admins joins them.
    expect(await screen.findByText("Member of 3 groups")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });
});

describe("creating below an entry that is not an OU", () => {
  const services = "ou=services,dc=example,dc=org";
  const role = `cn=Group factory,${services}`;

  /** An organizationalRole that holds groups, as some directories do. */
  async function addRole(backend: Awaited<ReturnType<typeof open>>["backend"]) {
    const text = (name: string, after: string[]) => ({ name, kind: "text", before: [], after });
    const r = await backend.apply("prod", [{ op: "add", dn: role, attributes: [text("objectClass", ["organizationalRole", "top"]), text("cn", ["Group factory"])] }] as never);
    expect(r.applied).toBe(1);
  }

  it("offers New entry on an organizationalRole, and creates a group in it", async () => {
    const { user, backend } = await open();
    await addRole(backend);
    await user.click(await item(/^ou=services/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^cn=Group factory/));
    await heading("Group factory");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    expect(within(dialog).getByRole("combobox", { name: "Create under" })).toHaveTextContent(role);

    await user.click(within(dialog).getByRole("button", { name: /^Group/ }));
    await user.type(within(dialog).getByLabelText(/Group name/), "made-here");
    await user.type(within(dialog).getByRole("searchbox", { name: /Search people/ }), "lovelace");
    await user.click(await within(dialog).findByRole("button", { name: "Add Ada Lovelace" }));
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await heading("made-here");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect((await backend.entry("prod", `cn=made-here,${role}`)).failure).toBeNull();
  });

  it("offers it in the tree's menu too, and lists the role under Create under", async () => {
    const { user, backend } = await open();
    await addRole(backend);
    await user.click(await item(/^ou=services/));
    await user.keyboard("{ArrowRight}");
    fireEvent.contextMenu(await item(/^cn=Group factory/), { clientX: 40, clientY: 80 });
    expect(await screen.findByRole("menuitem", { name: "New child entry…" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Another entry's New entry lists the role as a place to create.
    await user.click(await item(/^ou=services/));
    await heading("services");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    await user.click(within(screen.getByRole("dialog", { name: "New entry" })).getByRole("combobox", { name: "Create under" }));
    expect(screen.getByRole("option", { name: role })).toBeInTheDocument();
  });

  it("does not offer it on a person or a group without children", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^uid=ada /));
    await heading("Ada Lovelace");
    expect(screen.queryByRole("button", { name: "New entry" })).not.toBeInTheDocument();
  });
});
