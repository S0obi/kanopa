import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";

async function openAda(id = "prod", patch: Record<string, unknown> = {}) {
  const backend = createFakeBackend({ connections: sampleConnections().map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const r = await backend.connect(id, "", false);
  if (!r.ok) throw new Error(r.message);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await out.user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
  await out.user.keyboard("{ArrowRight}");
  await out.user.click(await screen.findByRole("treeitem", { name: /^uid=ada,/ }));
  await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" });
  return { ...out, backend };
}

const table = () => screen.getByRole("table", { name: "Attributes" });
const bar = () => screen.getByRole("region", { name: "Pending changes" });

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
});

describe("editing an entry", () => {
  it("edits a value, shows it against the server, applies it", async () => {
    const { user } = await openAda();
    await user.click(within(table()).getByRole("button", { name: "Edit title" }));
    const dialog = screen.getByRole("dialog", { name: /Edit title/ });
    const input = within(dialog).getByRole("textbox", { name: "title value 1" });
    await user.clear(input);
    await user.type(input, "Chief engineer");
    expect(within(dialog).getByLabelText("Change against the server")).toHaveTextContent("−removed: Principal engineer+added: Chief engineer");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(table()).getByText("Chief engineer")).toBeInTheDocument();
    expect(within(table()).getByText("Principal engineer").closest(".kn-attrs__was")).toHaveTextContent("was Principal engineer");
    expect(bar()).toHaveTextContent("Pending change: title on uid=ada. Nothing is sent until you apply.");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    expect(await screen.findByRole("region", { name: "Pending changes as LDIF" })).toHaveTextContent("replace: titletitle: Chief engineer-");

    await user.keyboard("{Control>}s{/Control}");
    expect(await screen.findByText("Saved 1 change to localhost.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pending changes" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Chief engineer · Research · ada.lovelace@example.org")).toBeInTheDocument());
  });

  it("adds an allowed attribute and keeps single values single", async () => {
    const { user } = await openAda();
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    const dialog = screen.getByRole("dialog", { name: "Add attribute" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Find an attribute" }), "display");
    await user.click(within(dialog).getByRole("option", { name: /displayName/ }));
    await user.type(within(dialog).getByLabelText(/Value for/), "Countess Lovelace{Enter}");
    expect(within(table()).getByText("Countess Lovelace")).toBeInTheDocument();
    expect(within(table()).getByText("Added")).toBeInTheDocument();

    // displayName holds one value: the editor offers no second one.
    await user.click(within(table()).getByRole("button", { name: "Edit displayName" }));
    const editor = screen.getByRole("dialog", { name: /Edit displayName/ });
    expect(within(editor).getByText("Single value")).toBeInTheDocument();
    expect(within(editor).queryByRole("button", { name: "Add value" })).not.toBeInTheDocument();
  });

  it("a refused Apply keeps the changes and shows the code", async () => {
    const { user } = await openAda();
    await user.click(within(table()).getByRole("button", { name: "Edit sn" }));
    const dialog = screen.getByRole("dialog", { name: /Edit sn/ });
    await user.clear(within(dialog).getByRole("textbox", { name: "sn value 1" }));
    await user.click(within(dialog).getByRole("button", { name: "Add to changes" }));
    expect(within(table()).getByText("Deleted")).toBeInTheDocument();

    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Required attribute missing. uid=ada was not changed.");
    expect(alert).toHaveTextContent("Object class violation (65) — inetOrgPerson requires the attribute sn.");
    expect(alert).toHaveTextContent("Your 1 pending change is kept.");
    expect(bar()).toHaveTextContent("Pending change: sn on uid=ada");
  });

  it("a read-only account gets Insufficient access (50)", async () => {
    const { user } = await openAda("prod", { bindDn: "uid=svc-kanopa,ou=services,dc=example,dc=org", password: "kanopa-reader" });
    await user.click(within(table()).getByRole("button", { name: "Edit title" }));
    await user.type(screen.getByRole("textbox", { name: "title value 1" }), "!{Enter}");
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Insufficient access (50) — ");
  });

  it("names the attribute someone else changed meanwhile", async () => {
    const { user, backend } = await openAda();
    await user.click(within(table()).getByRole("button", { name: "Edit title" }));
    await user.type(screen.getByRole("textbox", { name: "title value 1" }), "!{Enter}");
    // Someone else changes Ada's title before Apply.
    const r = await backend.apply("prod", [
      { dn: "uid=ada,ou=people,dc=example,dc=org", title: "", attributes: [{ name: "title", kind: "text", before: ["Principal engineer"], after: ["Director"], password: "" }] },
    ]);
    expect(r.applied).toBe(1);
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Assertion failed (122) — title changed on the server since you read it. Reload the entry, then make your changes again.",
    );
    expect(bar()).toHaveTextContent("Pending change: title on uid=ada");
  });

  it("offers no edit control on a read-only connection", async () => {
    await openAda("prod", { readOnly: true });
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(within(table()).queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add attribute" })).not.toBeInTheDocument();
  });

  it("removes a binary value, and never shows a new password", async () => {
    const { user } = await openAda();
    await user.click(within(table()).getByRole("button", { name: "Edit jpegPhoto" }));
    let dialog = screen.getByRole("dialog", { name: /Edit jpegPhoto/ });
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await user.click(within(dialog).getByRole("button", { name: "Add to changes" }));

    await user.click(within(table()).getByRole("button", { name: "Edit userPassword" }));
    dialog = screen.getByRole("dialog", { name: /Edit userPassword/ });
    expect(within(dialog).getByText("Sent over LDAPS. The server stores it hashed and never shows it again.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("New password"), "n3w-Passw0rd{Enter}");
    expect(bar()).toHaveTextContent("2 pending changes on 1 entry");
    expect(document.body.textContent).not.toContain("n3w-Passw0rd");

    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    const ldif = await screen.findByRole("region", { name: "Pending changes as LDIF" });
    expect(ldif).toHaveTextContent("delete: jpegPhoto# 1 binary value removed, not shown");
    expect(ldif).toHaveTextContent("Password Modify");
    expect(ldif).not.toHaveTextContent("n3w-Passw0rd");
  });

  it("asks before Disconnect drops pending changes, and Discard drops them", async () => {
    const { user } = await openAda();
    await user.click(within(table()).getByRole("button", { name: "Edit title" }));
    await user.type(screen.getByRole("textbox", { name: "title value 1" }), "!{Enter}");

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const ask = screen.getByRole("alertdialog", { name: "Disconnect with pending changes?" });
    expect(ask).toHaveTextContent("1 change was not applied to localhost. Disconnecting drops it.");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(useApp.getState().view.name).toBe("connected");

    await user.click(within(bar()).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Discarded 1 change. Entries are as the server has them.")).toBeInTheDocument();
    expect(within(table()).getByText("Principal engineer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(useApp.getState().view.name).toBe("welcome");
  });
});
