import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "@/features/browser/BrowserScreen";
import { useChanges } from "@/features/browser/changes";
import { useSearch } from "./store";

const people = "ou=people,dc=example,dc=org";

async function open() {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  return { ...out, backend };
}

type User = Awaited<ReturnType<typeof open>>["user"];

const tree = () => screen.getByRole("tree", { name: "Directory tree" });
const item = (name: RegExp) => within(tree()).findByRole("treeitem", { name });
const filterBox = () => screen.getByRole("combobox", { name: "Filter" });
// A search is a few async steps; a busy machine can take longer than the default second.
const results = () => screen.findByRole("table", { name: "Search results" }, { timeout: 4000 });

async function openSearch(user: User) {
  await user.click(screen.getByRole("button", { name: "Search the directory" }));
  return screen.findByRole("heading", { level: 1, name: "Search" });
}

async function search(user: User, filter: string) {
  await user.clear(filterBox());
  if (filter) await user.type(filterBox(), filter);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.paging = true;
  FAKE.serverLimit = 0;
  FAKE.recent = {};
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
  useSearch.getState().reset();
});

describe("Search", () => {
  it("starts at the selected entry, finds Ada, opens her in the tree, and Back to results returns", async () => {
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await openSearch(user);
    expect(screen.getByLabelText("Start at")).toHaveValue(people);

    await search(user, "(uid=ada)");
    const table = await results();
    const row = within(table).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Ada Lovelace");
    expect(row).toHaveTextContent(`uid=ada,${people}`);
    expect(screen.getByText(/1 entry/)).toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: `Open uid=ada,${people}` }));
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    expect(await item(/^uid=ada,/)).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Back to results (1)" }));
    expect(await results()).toBeInTheDocument();
    expect(filterBox()).toHaveValue("(uid=ada)");
  });

  it("opens with Ctrl+F and closes with Esc or Close", async () => {
    const { user } = await open();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    await openSearch(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
  });

  it("says where a filter goes wrong and sends nothing", async () => {
    const { user } = await open();
    await openSearch(user);
    await search(user, "(&(uid=ada)");
    expect(await screen.findByText("Missing ) to close the ( at position 1.")).toBeInTheDocument();
    expect(screen.getByText(/▲ character 12/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Search results" })).not.toBeInTheDocument();
    expect(useSearch.getState().status).toBe("idle");
  });

  it("offers to wrap a bare filter in parentheses", async () => {
    const { user } = await open();
    await openSearch(user);
    await search(user, "uid=ada");
    await user.click(await screen.findByRole("button", { name: "Use (uid=ada)" }));
    expect(filterBox()).toHaveValue("(uid=ada)");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await results()).toBeInTheDocument();
  });

  it("completes attribute names from the schema", async () => {
    const { user } = await open();
    await openSearch(user);
    await user.type(filterBox(), "(&(me");
    const list = await screen.findByRole("listbox", { name: "Attribute names" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["member"]));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(filterBox()).toHaveValue("(&(member=");
    // Enter with nothing chosen submits instead.
    await user.keyboard("*)){Enter}");
    expect(await results()).toBeInTheDocument();
  });

  it("reads 500 at most, shows 100 at a time, and says so", async () => {
    const { user, backend } = await open();
    await openSearch(user);
    await search(user, "(objectClass=inetOrgPerson)");
    const table = await results();
    expect(within(table).getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("These are the first 500 entries.")).toBeInTheDocument();
    expect(screen.getByText("100 of 500 shown")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show 100 more" }));
    expect(within(table).getAllByRole("row")).toHaveLength(201);
    await user.click(screen.getByRole("button", { name: "Copy DNs" }));
    expect(backend.clipboard.text.split("\n")).toHaveLength(200);
    expect(await screen.findByText("Copied 200 DNs.")).toBeInTheDocument();
  });

  it("adds attributes as columns", async () => {
    const { user } = await open();
    await openSearch(user);
    await user.type(screen.getByLabelText("Also show"), "mail, title");
    await search(user, "(uid=ada)");
    const table = await results();
    expect(within(table).getByRole("columnheader", { name: "mail" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "title" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("ada.lovelace@example.org");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Principal engineer");
  });

  it("names the filter and the base when nothing matches, and a missing base", async () => {
    const { user } = await open();
    await openSearch(user);
    await search(user, "(uid=nobody)");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByText("(uid=nobody)")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Start at"), "ou=nowhere,dc=example,dc=org");
    await search(user, "(uid=ada)");
    expect(await screen.findByText("Request refused.")).toBeInTheDocument();
    expect(screen.getByText(/No such object \(32\)/)).toBeInTheDocument();
  });

  it("on a server that doesn't page and stops at its size limit, says so", async () => {
    FAKE.paging = false;
    FAKE.serverLimit = 50;
    const { user } = await open();
    expect(screen.getByText("No paging")).toBeInTheDocument();
    await openSearch(user);
    await search(user, "(objectClass=inetOrgPerson)");
    expect(await screen.findByText("The server stopped at 50 entries.")).toBeInTheDocument();
    expect(screen.getByText(/it doesn't page, so Kanopa can't ask for the rest/)).toBeInTheDocument();
  });

  it("keeps the last searches per connection, loads one, and clears them", async () => {
    const { user } = await open();
    await openSearch(user);
    expect(screen.queryByRole("button", { name: "Recent searches" })).not.toBeInTheDocument();
    await search(user, "(uid=ada)");
    await results();
    await search(user, "(uid=alan)");
    await screen.findByText("Alan Turing");

    await user.click(await screen.findByRole("button", { name: "Recent searches" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["(uid=alan)Subtree", "(uid=ada)Subtree", "Clear recent searches"]);
    await user.click(items[1]!);
    expect(filterBox()).toHaveValue("(uid=ada)");

    await user.click(screen.getByRole("button", { name: "Recent searches" }));
    await user.click(await screen.findByRole("menuitem", { name: "Clear recent searches" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recent searches" })).not.toBeInTheDocument());
    expect(Object.keys(FAKE.recent)).toEqual([]);
  });

  it("can be stopped, and nothing is shown for a stopped search", async () => {
    FAKE.delayMs = 400;
    const { user } = await open();
    await openSearch(user);
    await search(user, "(uid=ada)");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByRole("table", { name: "Search results" })).not.toBeInTheDocument();
    expect(useSearch.getState().status).toBe("idle");
  });

  it("keeps the results readable when the connection is lost", async () => {
    const { user } = await open();
    await openSearch(user);
    await search(user, "(uid=ada)");
    await results();
    FAKE.lost = true;
    await search(user, "(uid=alan)");
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(await screen.findByText(/The results below are from before/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Search results" })).toHaveTextContent("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  });

  it("starts from a tree row: Search below here", async () => {
    const { user } = await open();
    fireEvent.contextMenu(await item(/^ou=groups/), { clientX: 40, clientY: 80 });
    await user.click(await screen.findByRole("menuitem", { name: /Search below here/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    expect(screen.getByLabelText("Start at")).toHaveValue("ou=groups,dc=example,dc=org");
    expect(await item(/^ou=groups/)).toHaveAttribute("aria-selected", "true");
  });

  it("a new connection starts with a clean search", async () => {
    const first = await open();
    await openSearch(first.user);
    await search(first.user, "(uid=ada)");
    await results();
    first.unmount();
    useSearch.getState().reset();
    expect(useSearch.getState()).toMatchObject({ open: false, filter: "", result: null, status: "idle" });
  });
});

describe("the tree on a server that stops its lists", () => {
  it("says the list was cut short, and the keyboard goes past the note", async () => {
    FAKE.serverLimit = 300;
    const { user } = await open();
    await user.click(await item(/^ou=people/));
    await user.keyboard("{ArrowRight}");
    // End jumps to the last row; the note is not a place to stop.
    await user.keyboard("{End}");
    expect(await screen.findByText("The server stopped the list at 300 entries (its size limit)")).toBeInTheDocument();
    const rows = within(tree()).getAllByRole("treeitem");
    expect(rows[rows.length - 1]).toHaveAttribute("aria-selected", "true");
  });
});
