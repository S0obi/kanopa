import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";
import { exportFileName } from "./exportLdif";

// Export LDIF: from the tree's menu, with a scope, the secrets box, the Save dialog, progress and the result.

const SLOW = { timeout: 4000 };

async function open(patch: { readOnly?: boolean } = {}) {
  const backend = createFakeBackend({ connections: sampleConnections().map((c) => (c.id === "prod" ? { ...c, ...patch } : c)) });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await out.user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
  await out.user.keyboard("{ArrowRight}");
  await screen.findByRole("treeitem", { name: /^uid=ada / });
  return { ...out, backend };
}
type Opened = Awaited<ReturnType<typeof open>>;

async function openDialog(user: Opened["user"], target: RegExp) {
  await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("treeitem", { name: target }) });
  await user.click(await screen.findByRole("menuitem", { name: /Export LDIF/ }));
  return screen.findByRole("dialog", { name: "Export LDIF" });
}

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.activeDirectory = false;
  FAKE.exporting.path = "C:\\Users\\ada\\Documents\\export.ldif";
  FAKE.exporting.subtreeEntries = 4;
  FAKE.exporting.suggested = [];
  FAKE.exporting.started = [];
  FAKE.exporting.failAfter = -1;
  FAKE.exporting.cutAfter = 0;
  FAKE.exporting.perPoll = 4;
  FAKE.opened.folder = [];
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("the file name the Save dialog suggests", () => {
  it("is the entry's name, safe for any file system", () => {
    expect(exportFileName("ou=people,dc=example,dc=org")).toBe("people.ldif");
    expect(exportFileName("uid=ada,ou=people,dc=example,dc=org")).toBe("ada.ldif");
    expect(exportFileName("dc=example,dc=org")).toBe("example.ldif");
    expect(exportFileName("cn=a:b/c?d,dc=org")).toBe("a_b_c_d.ldif");
    expect(exportFileName("cn=Lovelace\\, Ada,ou=people,dc=org")).toBe("Lovelace, Ada.ldif");
    expect(exportFileName("cn=con,dc=org")).toBe("_con.ldif");
    expect(exportFileName("cn=...,dc=org")).toBe("export.ldif");
    expect(exportFileName("cn=" + "a".repeat(300) + ",dc=org")).toBe(`${"a".repeat(100)}.ldif`);
  });
});

describe("Export LDIF", () => {
  it("exports one entry through the Save dialog and shows where the file went", async () => {
    const { user } = await open();
    const d = await openDialog(user, /^uid=ada /);
    expect(within(d).getByRole("button", { name: "This entry", pressed: true })).toBeInTheDocument();
    expect(within(d).getByRole("checkbox", { name: /Include password hashes and secrets/ })).not.toBeChecked();
    expect(within(d).getByText("Reads from the server. Nothing is changed.")).toBeInTheDocument();

    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    const done = await screen.findByRole("dialog", { name: "Export done" }, SLOW);
    expect(within(done).getByText("1 entry exported.")).toBeInTheDocument();
    expect(within(done).getByText("C:\\Users\\ada\\Documents\\export.ldif")).toBeInTheDocument();
    expect(FAKE.exporting.suggested).toEqual(["ada.ldif"]);
    expect(FAKE.exporting.started).toEqual([{ id: "prod", dn: "uid=ada,ou=people,dc=example,dc=org", path: "C:\\Users\\ada\\Documents\\export.ldif", subtree: false, secrets: false }]);

    await user.click(within(done).getByRole("button", { name: "Show in folder" }));
    expect(FAKE.opened.folder).toEqual(["C:\\Users\\ada\\Documents\\export.ldif"]);
    await user.click(within(done).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exports everything below an entry, with the secrets only when ticked", async () => {
    const { user } = await open();
    const d = await openDialog(user, /^ou=people/);
    await user.click(within(d).getByRole("button", { name: "Entry and everything below" }));
    await user.click(within(d).getByRole("checkbox", { name: /Include password hashes and secrets/ }));
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    const done = await screen.findByRole("dialog", { name: "Export done" }, SLOW);
    expect(within(done).getByText("4 entries exported.")).toBeInTheDocument();
    expect(FAKE.exporting.started[0]).toMatchObject({ dn: "ou=people,dc=example,dc=org", subtree: true, secrets: true });
    expect(FAKE.exporting.suggested).toEqual(["people.ldif"]);
  });

  it("does nothing when the person closes the Save dialog", async () => {
    FAKE.exporting.path = "";
    const { user } = await open();
    const d = await openDialog(user, /^uid=ada /);
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    await waitFor(() => expect(FAKE.exporting.suggested).toHaveLength(1));
    expect(FAKE.exporting.started).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Export LDIF" })).toBeInTheDocument();
  });

  it("cancels a running export", async () => {
    FAKE.exporting.perPoll = 1;
    FAKE.exporting.subtreeEntries = 50;
    const { user } = await open();
    const d = await openDialog(user, /^ou=people/);
    await user.click(within(d).getByRole("button", { name: "Entry and everything below" }));
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    const running = await screen.findByRole("dialog", { name: "Exporting…" });
    expect(within(running).getByRole("progressbar", { name: "Writing the file" })).toBeInTheDocument();
    await user.click(within(running).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain("Export canceled. No file was written.");
  });

  it("keeps an export the server cut short and says why, with the referrals it did not follow", async () => {
    FAKE.exporting.subtreeEntries = 800;
    FAKE.exporting.cutAfter = 500;
    FAKE.exporting.perPoll = 500;
    const { user } = await open();
    const d = await openDialog(user, /^ou=people/);
    await user.click(within(d).getByRole("button", { name: "Entry and everything below" }));
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    const done = await screen.findByRole("dialog", { name: "Export incomplete" }, SLOW);
    expect(within(done).getByText(/The server stopped after 500 entries\. Size limit exceeded \(4\)\./)).toBeInTheDocument();
    expect(within(done).getByText("1 referral not followed.")).toBeInTheDocument();
    expect(within(done).getByText("ldap://partners.example.org/ou=partners,dc=example,dc=org")).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
  });

  it("says when an export failed and that no file was written", async () => {
    FAKE.exporting.failAfter = 1;
    const { user } = await open();
    const d = await openDialog(user, /^ou=people/);
    await user.click(within(d).getByRole("button", { name: "Entry and everything below" }));
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    const done = await screen.findByRole("dialog", { name: "Export failed" }, SLOW);
    expect(within(done).getByText("Couldn't write the file.")).toBeInTheDocument();
    expect(within(done).getByText(/No file was written\./)).toBeInTheDocument();
    expect(within(done).queryByRole("button", { name: "Show in folder" })).not.toBeInTheDocument();
  });

  it("stays on the options and says why when the export can't start", async () => {
    const { user } = await open();
    const d = await openDialog(user, /^uid=ada /);
    FAKE.lost = true;
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    expect(await within(d).findByText(/Connection to localhost lost\./)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Export LDIF" })).toBeInTheDocument();
  });

  it("says that unapplied changes are not in the file, only when they touch what is exported", async () => {
    const { user } = await open();
    useChanges.setState({
      byConnection: { prod: { "uid=ada,ou=people,dc=example,dc=org": { dn: "uid=ada,ou=people,dc=example,dc=org", title: "Ada Lovelace", attrs: [{ name: "title", kind: "text", before: [], after: ["Countess"] }] } } },
    });
    const d = await openDialog(user, /^ou=people/);
    expect(within(d).queryByText("Pending changes aren't included.")).not.toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Entry and everything below" }));
    expect(within(d).getByText("Pending changes aren't included.")).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "This entry" }));
    expect(within(d).queryByText("Pending changes aren't included.")).not.toBeInTheDocument();
  });

  it("works on a read-only connection", async () => {
    const { user } = await open({ readOnly: true });
    const d = await openDialog(user, /^uid=ada /);
    await user.click(within(d).getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByRole("dialog", { name: "Export done" }, SLOW)).toBeInTheDocument();
  });

  it("is offered in the entry's own menu too", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("treeitem", { name: /^uid=ada / }));
    await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" });
    await user.click(screen.getByRole("button", { name: "More entry actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Export LDIF/ }));
    expect(await screen.findByRole("dialog", { name: "Export LDIF" })).toBeInTheDocument();
  });
});
