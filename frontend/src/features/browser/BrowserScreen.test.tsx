import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { BrowserScreen } from "./BrowserScreen";
import { useBrowser, visibleRows } from "./store";

async function connected() {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  return { ...out, backend };
}

const tree = () => screen.getByRole("tree", { name: "Directory tree" });
const item = (name: RegExp) => within(tree()).getByRole("treeitem", { name });

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
});
afterEach(() => {
  FAKE.lost = false;
});

describe("BrowserScreen", () => {
  it("opens on the base DN with its children", async () => {
    await connected();
    expect(item(/^dc=example,dc=org/)).toHaveAttribute("aria-expanded", "true");
    expect(item(/^ou=people People and their login accounts/)).toBeInTheDocument();
    expect(item(/^ou=partners/)).toHaveTextContent("referral");
    expect(item(/^cn=Subschema Schema/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "example" })).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("ldaps://localhost:636")).toBeInTheDocument();
  });

  it("pages through 1,182 people with Show N more", async () => {
    const { user } = await connected();
    await user.click(item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(useBrowser.getState().nodes["ou=people,dc=example,dc=org"]?.children).toHaveLength(500));
    const rows = () => visibleRows(useBrowser.getState().nodes, useBrowser.getState().roots, useBrowser.getState().expanded);
    expect(rows().find((r) => r.kind === "more")).toMatchObject({ remaining: 682 });
    // The "Show 682 more" row sits above the four other OUs and the schema entry.
    await user.keyboard("{End}{ArrowUp>5/}");
    expect(await screen.findByRole("button", { name: "Show 682 more" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(useBrowser.getState().nodes["ou=people,dc=example,dc=org"]?.children).toHaveLength(1000));
    await user.keyboard("{End}{ArrowUp>5/}{Enter}");
    await waitFor(() => expect(useBrowser.getState().nodes["ou=people,dc=example,dc=org"]?.children).toHaveLength(1182));
    expect(rows().some((r) => r.kind === "more")).toBe(false);
  });

  it("shows an entry: attributes, LDIF, member of, links", async () => {
    const { user, backend } = await connected();
    await user.click(item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("treeitem", { name: /^uid=ada / }));
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Attributes" });
    expect(within(table).getByText("JPEG image · 14,236 bytes")).toBeInTheDocument();
    expect(within(table).getByText(/^\{SSHA\} hashed value/)).toBeInTheDocument();
    expect(within(table).getAllByText("required").length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("button", { name: "Copy DN" }));
    expect(backend.clipboard.text).toBe("uid=ada,ou=people,dc=example,dc=org");

    await user.click(screen.getByRole("tab", { name: "LDIF" }));
    expect(screen.getByRole("region", { name: /^LDIF of uid=ada/ })).toHaveTextContent("dn: uid=ada,ou=people,dc=example,dc=org");

    await user.click(screen.getByRole("tab", { name: /Member of/ }));
    expect(await screen.findByText("Member of 5 groups")).toBeInTheDocument();
    for (const g of ["admins", "engineering", "research"]) expect(screen.getByText(g)).toBeInTheDocument();

    // The manager value opens Grace.
    await user.click(screen.getByRole("tab", { name: /Attributes/ }));
    await user.click(screen.getByRole("button", { name: "uid=grace,ou=people,dc=example,dc=org" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Grace Hopper" })).toBeInTheDocument();

    // The breadcrumb opens an ancestor.
    await user.click(within(screen.getByRole("navigation", { name: "Distinguished name" })).getByRole("button", { name: "ou=people" }));
    expect(await screen.findByRole("heading", { level: 1, name: "people" })).toBeInTheDocument();
  });

  it("lists a group's members", async () => {
    const { user } = await connected();
    await user.click(item(/^ou=groups/));
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("treeitem", { name: /^cn=admins/ }));
    await screen.findByRole("heading", { level: 1, name: "admins" });
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(screen.getByText("2 members")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "uid=ada,ou=people,dc=example,dc=org" })).toBeInTheDocument();
  });

  it("says when the connection is lost, and reconnects", async () => {
    const { user } = await connected();
    FAKE.lost = true;
    await user.click(item(/^ou=hosts/));
    await user.keyboard("{ArrowRight}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Connection to localhost lost.");
    expect(alert).toHaveTextContent("Server is unavailable (52)");
    expect(screen.getByText("Connection lost")).toBeInTheDocument();

    FAKE.lost = false;
    await user.click(within(alert).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByRole("treeitem", { name: /^cn=web01/ })).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("Disconnect goes back to the saved connections", async () => {
    const { user } = await connected();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(useApp.getState().view.name).toBe("welcome");
  });
});
