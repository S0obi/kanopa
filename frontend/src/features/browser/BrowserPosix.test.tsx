import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";

// posixGroups list their members by uid (memberUid), not by DN.

const base = "dc=example,dc=org";
const groups = `ou=groups,${base}`;
const services = `ou=services,${base}`;

async function open() {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  return { ...out, backend };
}
type Opened = Awaited<ReturnType<typeof open>>;

const tree = () => screen.getByRole("tree", { name: "Directory tree" });
const item = (name: RegExp) => within(tree()).findByRole("treeitem", { name });
const bar = () => screen.getByRole("region", { name: "Pending changes" });
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

async function openIn(user: Opened["user"], parent: RegExp, child: RegExp, title: string) {
  await user.click(await item(parent));
  await user.keyboard("{ArrowRight}");
  await user.click(await item(child));
  await heading(title);
}
const openGroup = (user: Opened["user"], cn: string) => openIn(user, /^ou=groups/, new RegExp(`^cn=${cn} `), cn);
const openPerson = (user: Opened["user"], uid: string, name: string) => openIn(user, /^ou=people/, new RegExp(`^uid=${uid} `), name);

/** A person with no uid: an inetOrgPerson does not need one. */
async function addPersonWithoutUid(backend: Opened["backend"]) {
  const text = (name: string, after: string[]) => ({ name, kind: "text", before: [], after });
  const r = await backend.apply("prod", [
    { op: "add", dn: `cn=Pat Nouid,${services}`, attributes: [text("objectClass", ["inetOrgPerson", "organizationalPerson", "person", "top"]), text("cn", ["Pat Nouid"]), text("sn", ["Nouid"])] },
  ] as never);
  expect(r.applied).toBe(1);
}

const valuesOf = async (backend: Opened["backend"], dn: string, attr: string) => (await backend.entry("prod", dn)).attributes?.find((a) => a.name === attr)?.values ?? [];

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.failReferrers = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("posixGroup members (memberUid)", () => {
  it("lists the people the uids stand for, and flags a uid nobody carries", async () => {
    const { user } = await open();
    await openGroup(user, "unix-devs");
    expect(screen.getByRole("tab", { name: /Members/ })).toHaveTextContent("4");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(await screen.findByText("4 members")).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Margaret Hamilton")).toBeInTheDocument();
    expect(await screen.findByText("No entry has this uid")).toBeInTheDocument();
    expect(screen.getByText("ghost.user")).toBeInTheDocument();
    // A service account carries the uid too: it is the entry that stands for it.
    expect(screen.getByText(`uid=svc-mail,${services}`)).toBeInTheDocument();
  });

  it("adds a person by uid, shows the LDIF, and writes memberUid", async () => {
    const { user, backend } = await open();
    await openGroup(user, "unix-devs");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    await user.click(await screen.findByRole("button", { name: "Add member" }));
    await user.type(screen.getByRole("searchbox", { name: /Search people/ }), "edsger");
    await user.click(await screen.findByRole("button", { name: "Add Edsger Dijkstra" }));
    expect(await screen.findByText("5 members")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("Pending change: memberUid on cn=unix-devs");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("add: memberUidmemberUid: edsger");

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect(await valuesOf(backend, `cn=unix-devs,${groups}`, "memberUid")).toContain("edsger");
  });

  it("removes a member, and Undo takes the removal back", async () => {
    const { user, backend } = await open();
    await openGroup(user, "unix-staff");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    await user.click(await screen.findByRole("button", { name: "Remove Alan Turing" }));
    expect(await screen.findByText("Removed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("region", { name: "Pending changes" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Alan Turing" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect(await valuesOf(backend, `cn=unix-staff,${groups}`, "memberUid")).toEqual(["ada", "grace"]);
  });

  it("lets a posixGroup with no member stay empty, then fills it", async () => {
    const { user, backend } = await open();
    await openGroup(user, "unix-empty");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(await screen.findByText("No members")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await user.type(screen.getByRole("searchbox", { name: /Search people/ }), "grace");
    await user.click(await screen.findByRole("button", { name: "Add Grace Hopper" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect(await valuesOf(backend, `cn=unix-empty,${groups}`, "memberUid")).toEqual(["grace"]);
  });

  it("shows someone with no uid as unavailable", async () => {
    const { user, backend } = await open();
    await addPersonWithoutUid(backend);
    await openGroup(user, "unix-empty");
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    await user.click(await screen.findByRole("button", { name: "Add member" }));
    await user.type(screen.getByRole("searchbox", { name: /Search people/ }), "nouid");
    expect(await screen.findByText("has no uid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Pat Nouid" })).toBeDisabled();
  });
});

describe("posixGroups on a person (Member of)", () => {
  it("lists a posixGroup, and joins one by uid", async () => {
    const { user, backend } = await open();
    await openPerson(user, "grace", "Grace Hopper");
    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    expect(await screen.findByText("unix-staff")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to group" }));
    await user.type(screen.getByRole("searchbox", { name: /Search groups/ }), "unix-empty");
    await user.click(await screen.findByRole("button", { name: "Add unix-empty" }));
    expect(bar()).toHaveTextContent("Pending change: memberUid on cn=unix-empty");
    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    expect(await screen.findByRole("region", { name: "Pending changes as LDIF" })).toHaveTextContent("add: memberUidmemberUid: grace");

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect(await valuesOf(backend, `cn=unix-empty,${groups}`, "memberUid")).toEqual(["grace"]);
  });

  it("leaves a posixGroup, removing the uid", async () => {
    const { user, backend } = await open();
    await openPerson(user, "alan", "Alan Turing");
    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    await user.click(await screen.findByRole("button", { name: "Remove unix-staff" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    expect(await valuesOf(backend, `cn=unix-staff,${groups}`, "memberUid")).toEqual(["ada", "grace"]);
  });

  it("cannot join a posixGroup without a uid", async () => {
    const { user, backend } = await open();
    await addPersonWithoutUid(backend);
    await user.click(await item(/^ou=services/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^cn=Pat Nouid/));
    await heading("Pat Nouid");
    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    await user.click(await screen.findByRole("button", { name: "Add to group" }));
    await user.type(screen.getByRole("searchbox", { name: /Search groups/ }), "unix-empty");
    expect(await screen.findByText("this entry has no uid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add unix-empty" })).toBeDisabled();
  });
});

describe("the Member of tab on a person", () => {
  it("shows how many groups list the person, with posixGroups counted", async () => {
    const { user } = await open();
    await openPerson(user, "ada", "Ada Lovelace");
    // admins, engineering and research list her DN; unix-devs and unix-staff list her uid.
    const tab = screen.getByRole("tab", { name: /Member of/ });
    await waitFor(() => expect(tab).toHaveTextContent("5"));
  });

  it("counts a pending leave and a pending join", async () => {
    const { user } = await open();
    await openPerson(user, "alan", "Alan Turing");
    const tab = screen.getByRole("tab", { name: /Member of/ });
    await waitFor(() => expect(tab).toHaveTextContent("3"));
    await user.click(tab);
    await user.click(await screen.findByRole("button", { name: "Remove unix-staff" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Member of/ })).toHaveTextContent("2"));
    await user.click(screen.getByRole("button", { name: "Add to group" }));
    await user.type(screen.getByRole("searchbox", { name: /Search groups/ }), "unix-empty");
    await user.click(await screen.findByRole("button", { name: "Add unix-empty" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Member of/ })).toHaveTextContent("3"));
  });

  it("lists the posixGroups of a person who is not named by uid", async () => {
    const { user, backend } = await open();
    const text = (name: string, after: string[]) => ({ name, kind: "text", before: [], after });
    // A posixAccount is often named by cn: its uid is an attribute, and the group lists that.
    const r = await backend.apply("prod", [
      { op: "add", dn: `cn=Casey Unix,${services}`, attributes: [text("objectClass", ["inetOrgPerson", "organizationalPerson", "person", "top"]), text("uid", ["casey"]), text("cn", ["Casey Unix"]), text("sn", ["Unix"])] },
      { op: "modify", dn: `cn=unix-devs,${groups}`, attributes: [{ name: "memberUid", kind: "text", add: ["casey"] }] },
    ] as never);
    expect(r.applied).toBe(2);
    await user.click(await item(/^ou=services/));
    await user.keyboard("{ArrowRight}");
    await user.click(await item(/^cn=Casey Unix/));
    await heading("Casey Unix");
    await waitFor(() => expect(screen.getByRole("tab", { name: /Member of/ })).toHaveTextContent("1"));
    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    expect(await screen.findByText("unix-devs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove unix-devs" })).toBeInTheDocument();
  });

  it("shows no badge for a group, whose tab is Members", async () => {
    const { user } = await open();
    await openGroup(user, "unix-empty");
    expect(screen.queryByRole("tab", { name: /Member of/ })).not.toBeInTheDocument();
  });
});

describe("creating a posixGroup", () => {
  it("suggests the next free gidNumber, warns about a used one, and writes the group", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=groups/));
    await heading("groups");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /^POSIX group/ }));
    const gid = within(dialog).getByLabelText(/Group ID/);
    await waitFor(() => expect(gid).toHaveValue("2004"));
    expect(within(dialog).getByText(/next free number/)).toBeInTheDocument();

    await user.clear(gid);
    await user.type(gid, "2001");
    await waitFor(() => expect(dialog.textContent).toContain("Already used by unix-staff"));
    await user.clear(gid);
    await user.type(gid, "2004");

    // No member is needed: a posixGroup may be empty.
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("enter a group name");
    await user.type(within(dialog).getByLabelText(/Group name/), "unix-ops");
    await user.type(within(dialog).getByRole("searchbox", { name: /Search people/ }), "ada");
    await user.click(await within(dialog).findByRole("button", { name: "Add Ada Lovelace" }));
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await heading("unix-ops");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("objectClass: posixGroup");
    expect(ldif).toHaveTextContent("gidNumber: 2004");
    expect(ldif).toHaveTextContent("memberUid: ada");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    const e = await backend.entry("prod", `cn=unix-ops,${groups}`);
    expect(e.objectClasses).toContain("posixGroup");
    expect(e.attributes?.find((a) => a.name === "memberUid")?.values).toEqual(["ada"]);
  });

  it("refuses a gidNumber that is not a number", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=groups/));
    await heading("groups");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /^POSIX group/ }));
    await user.type(within(dialog).getByLabelText(/Group name/), "unix-ops");
    const gid = within(dialog).getByLabelText(/Group ID/);
    await user.clear(gid);
    await user.type(gid, "twelve");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Invalid syntax (21) — gidNumber must be a whole number.");
  });
});

describe("keeping memberUid in step", () => {
  it("removes a deleted person's uid from the posixGroups that list it", async () => {
    const { user, backend } = await open();
    await openPerson(user, "alan", "Alan Turing");
    await user.click(screen.getByRole("button", { name: "More entry actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete entry/ }));
    const ask = await screen.findByRole("alertdialog", { name: /Delete uid=alan/ });
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Delete entry" })).toBeEnabled());
    await user.click(within(ask).getByRole("button", { name: "Delete entry" }));
    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    expect(await screen.findByRole("region", { name: "Pending changes as LDIF" })).toHaveTextContent("delete: memberUidmemberUid: alan");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 4 changes to localhost.");
    expect(await valuesOf(backend, `cn=unix-staff,${groups}`, "memberUid")).toEqual(["ada", "grace"]);
  });

  it("follows a renamed uid, and does not touch memberUid when the name is not the uid", async () => {
    const { backend } = await open();
    const ada = `uid=ada,ou=people,${base}`;
    // Ada is listed by uid in two posixGroups; her DN is listed in three groups.
    const refs = (await backend.referrers("prod", ada)).entries ?? [];
    expect(refs.filter((r) => r.memberAttr === "memberUid").map((r) => `${r.name}=${r.uid}`)).toEqual(["unix-devs=ada", "unix-staff=ada"]);
    expect(refs.filter((r) => r.memberAttr === "member")).toHaveLength(3);
  });

  it("leaves a uid that two entries carry alone", async () => {
    const { backend } = await open();
    const text = (name: string, after: string[]) => ({ name, kind: "text", before: [], after });
    // svc-mail is an account under ou=services; a person with the same uid makes it ambiguous.
    const r = await backend.apply("prod", [
      { op: "add", dn: `uid=svc-mail,ou=people,${base}`, attributes: [text("objectClass", ["inetOrgPerson", "organizationalPerson", "person", "top"]), text("uid", ["svc-mail"]), text("cn", ["Mail Twin"]), text("sn", ["Twin"])] },
    ] as never);
    expect(r.applied).toBe(1);
    const resolved = (await backend.resolveUids("prod", ["svc-mail", "ghost.user", "ada"])).matches ?? [];
    expect(resolved.map((m) => m.matches)).toEqual([2, 0, 1]);
    const refs = (await backend.referrers("prod", `uid=svc-mail,${services}`)).entries ?? [];
    expect(refs.filter((x) => x.memberAttr === "memberUid")).toEqual([]);
  });

  it("creates a person who is also a posixAccount, with the next free number and a group picked by name", async () => {
    const { user, backend } = await open();
    await user.click(await item(/^ou=people/));
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /^POSIX user/ }));
    await user.type(within(dialog).getByLabelText(/First name/), "Mary");
    await user.type(within(dialog).getByLabelText(/Last name/), "Jackson");
    // The uid is the first letter of the first name and the last name; the home follows it.
    expect(within(dialog).getByLabelText(/User ID/)).toHaveValue("mjackson");
    expect(within(dialog).getByLabelText(/Home directory/)).toHaveValue("/home/mjackson");
    expect(within(dialog).getByLabelText(/Login shell/)).toHaveValue("/bin/bash");
    await waitFor(() => expect(within(dialog).getByLabelText(/User number/)).toHaveValue("1000"));
    expect(within(dialog).getByRole("combobox", { name: /Primary group/ })).toHaveTextContent("unix-devs (2002)");
    expect(within(dialog).getByText(/objectClass: inetOrgPerson, organizationalPerson, person, posixAccount, top/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    await screen.findByText("Saved 1 change to localhost.");
    const e = await backend.entry("prod", `uid=mjackson,ou=people,${base}`);
    expect(e.failure).toBeNull();
    expect(e.objectClasses).toEqual(expect.arrayContaining(["inetOrgPerson", "posixAccount"]));
    for (const [name, value] of [["uidNumber", "1000"], ["gidNumber", "2002"], ["homeDirectory", "/home/mjackson"], ["loginShell", "/bin/bash"]]) {
      expect(e.attributes?.find((a) => a.name === name)?.values).toEqual([value]);
    }
    // The number is now in use.
    expect((await backend.posixInfo("prod", 1000)).uidTakenBy).toEqual(["mjackson"]);
  });

  it("refuses a POSIX user without a number or a home directory", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    await user.click(within(dialog).getByRole("button", { name: /^POSIX user/ }));
    await user.type(within(dialog).getByLabelText(/Last name/), "Hopper");
    await waitFor(() => expect(within(dialog).getByLabelText(/User number/)).toHaveValue("1000"));
    await user.clear(within(dialog).getByLabelText(/User number/));
    await user.clear(within(dialog).getByLabelText(/Home directory/));
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    const alerts = within(dialog).getAllByRole("alert").map((a) => a.textContent).join(" ");
    expect(alerts).toMatch(/requires the attribute uidNumber/);
    expect(alerts).toMatch(/1 more problem/);
  });

  it("starts a person's uid as the first letter of the first name and the last name, until it is edited", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await heading("people");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    const dialog = screen.getByRole("dialog", { name: "New entry" });
    const uid = within(dialog).getByLabelText(/User ID/);
    await user.type(within(dialog).getByLabelText(/First name/), "Ada");
    expect(uid).toHaveValue("a");
    await user.type(within(dialog).getByLabelText(/Last name/), "Lovelace");
    expect(uid).toHaveValue("alovelace");
    await user.clear(within(dialog).getByLabelText(/First name/));
    await user.type(within(dialog).getByLabelText(/First name/), "Augusta");
    expect(uid).toHaveValue("alovelace");
    await user.clear(uid);
    await user.type(uid, "countess");
    await user.type(within(dialog).getByLabelText(/Last name/), "-King");
    expect(uid).toHaveValue("countess");
  });
});
