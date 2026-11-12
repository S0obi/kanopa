import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "@/features/browser/BrowserScreen";
import { useChanges } from "@/features/browser/changes";

async function open() {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  return { ...out, backend };
}

type User = Awaited<ReturnType<typeof open>>["user"];

const field = () => screen.getByRole("combobox", { name: "Search entries" });
const tree = () => screen.getByRole("tree", { name: "Directory tree" });
// A search is a few async steps: a busy machine can take longer than the default second.
const list = () => screen.findByRole("listbox", { name: "Matching entries" }, { timeout: 4000 });
const options = async () => within(await list()).findAllByRole("option", {}, { timeout: 4000 });

async function find(user: User, text: string) {
  await user.click(field());
  await user.clear(field());
  await user.type(field(), text);
}

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.paging = true;
  FAKE.serverLimit = 0;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("the header search", () => {
  it("finds Ada by her name, and a click selects her in the tree and opens her", async () => {
    const { user } = await open();
    await find(user, "ada");
    const rows = await options();
    expect(rows[0]).toHaveTextContent("Ada Lovelace");
    expect(rows[0]).toHaveTextContent("ada.lovelace@example.org");
    expect(rows[0]).toHaveTextContent("uid=ada,ou=people,dc=example,dc=org");
    expect(await within(await list()).findByText("Names and mail")).toBeInTheDocument();
    expect(within(await list()).getByText("Ada").tagName).toBe("MARK");

    await user.click(rows[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
    expect(await within(tree()).findByRole("treeitem", { name: /^uid=ada,/ })).toHaveAttribute("aria-selected", "true");
    // The list closes and the text stays; focusing the field brings the same results back.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field()).toHaveValue("ada");
    await user.click(field());
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
  });

  it("shows what it understands while it is focused and empty, and a click tries an example", async () => {
    const { user } = await open();
    expect(screen.queryByText("Try")).not.toBeInTheDocument();
    await user.click(field());
    expect(await screen.findByText("Try")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /ada lov/ }));
    expect(field()).toHaveValue("ada lov");
    expect(field()).toHaveFocus();
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
    expect(screen.queryByText("Try")).not.toBeInTheDocument();
  });

  it("closes when the keyboard leaves the field: Esc and Tab", async () => {
    const { user } = await open();
    await user.click(field());
    expect(await screen.findByText("Try")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Try")).not.toBeInTheDocument();

    await find(user, "ada");
    await options();
    await user.tab();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Coming back brings the same results.
    await user.click(field());
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
  });

  it("opens the first result when Enter comes before the results do", async () => {
    FAKE.delayMs = 150;
    const { user } = await open();
    await user.click(field());
    await user.keyboard("ada{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("finds an entry by a pasted DN, and says so when there is none", async () => {
    const { user } = await open();
    await find(user, "uid=ada,ou=people,dc=example,dc=org");
    expect(await within(await list()).findByText("Distinguished name")).toBeInTheDocument();
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
    await find(user, "uid=nobody,ou=people,dc=example,dc=org");
    expect(await screen.findByText(/No entry at/)).toHaveTextContent("uid=nobody,ou=people,dc=example,dc=org");
  });

  it("ignores the half-typed end of a search", async () => {
    const { user } = await open();
    await find(user, "ada l");
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
    await find(user, "a b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows a result that sits beyond the tree's first page", async () => {
    const { user } = await open();
    // zoe.zurcher is about the 870th of 1,182 people: the tree lists 500 at first.
    await find(user, "zoe.zurcher");
    const rows = await options();
    expect(rows[0]).toHaveTextContent("zoe.zurcher");
    await user.click(rows[0]!);
    expect(await within(tree()).findByRole("treeitem", { name: /^uid=zoe.zurcher,/ }, { timeout: 6000 })).toHaveAttribute("aria-selected", "true");
  });

  it("leaves Ctrl+F to an open dialog", async () => {
    const { user } = await open();
    await user.click(await within(tree()).findByRole("treeitem", { name: /^ou=people/ }));
    await user.click(await screen.findByRole("button", { name: "New entry" }));
    expect(await screen.findByRole("dialog", { name: "New entry" })).toBeInTheDocument();
    const press = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(field()).not.toHaveFocus();
  });

  it("is reached with Ctrl+F and Ctrl+K, and Esc clears it", async () => {
    const { user } = await open();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(field()).toHaveFocus();
    await user.keyboard("ada");
    expect(await list()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(field()).toHaveValue("");
    expect(field()).not.toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(field()).toHaveFocus();
  });

  it("opens an entry from the keyboard: arrows to choose, Enter to open", async () => {
    const { user } = await open();
    await find(user, "an");
    await options();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const chosen = screen.getAllByRole("option")[1]!;
    expect(chosen).toHaveAttribute("aria-selected", "true");
    expect(field()).toHaveAttribute("aria-activedescendant", chosen.id);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Anton Bianchi" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter with nothing chosen opens the first result", async () => {
    const { user } = await open();
    await find(user, "ada lov");
    await options();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
  });

  it("every word has to match, and mail counts", async () => {
    const { user } = await open();
    await find(user, "ada hopper");
    expect(await screen.findByText("No entry matches “ada hopper”.")).toBeInTheDocument();
    await find(user, "grace.hopper");
    expect((await options())[0]).toHaveTextContent("Grace Hopper");
  });

  it("shows ten of the matches and says there are more", async () => {
    const { user } = await open();
    await find(user, "an");
    const rows = await options();
    expect(rows).toHaveLength(10);
    expect(within(await list()).getByText("10 of 200+")).toBeInTheDocument();
    expect(within(await list()).getByText("More entries match. Keep typing to narrow the list.")).toBeInTheDocument();
  });

  it("treats ( and attribute=value as an LDAP filter", async () => {
    const { user } = await open();
    await find(user, "(&(objectClass=inetOrgPerson)(uid=ada))");
    expect((await options())[0]).toHaveTextContent("Ada Lovelace");
    expect(await within(await list()).findByText("LDAP filter")).toBeInTheDocument();
    await find(user, "uid=alan");
    expect(await screen.findByText("Alan Turing")).toBeInTheDocument();
    expect(await within(await list()).findByText("LDAP filter")).toBeInTheDocument();
    await find(user, "(uid=nobody)");
    expect(await screen.findByText(/No entry matches/)).toHaveTextContent("(uid=nobody)");
  });

  it("explains a filter that can't be sent, and where", async () => {
    const { user } = await open();
    await find(user, "(&(uid=ada)");
    expect(await screen.findByText("Missing ) to close the ( at position 1.")).toBeInTheDocument();
    expect(screen.getByText(/▲ character 12/)).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("waits for two characters", async () => {
    const { user } = await open();
    await find(user, "a");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.type(field(), "d");
    expect(await list()).toBeInTheDocument();
  });

  it("says when the server stopped the list at its size limit and doesn't page", async () => {
    FAKE.paging = false;
    FAKE.serverLimit = 50;
    const { user } = await open();
    expect(screen.getByText("No paging")).toBeInTheDocument();
    await find(user, "an");
    expect(await screen.findByText(/The server stopped at 50 entries \(its size limit\) and doesn't page/)).toBeInTheDocument();
  });

  it("is disabled while the connection is lost", async () => {
    const { user } = await open();
    await find(user, "ada");
    await options();
    FAKE.lost = true;
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(field()).toHaveAttribute("placeholder", "Reconnect to search");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("the tree on a server that stops its lists", () => {
  it("says the list was cut short, and the keyboard goes past the note", async () => {
    FAKE.serverLimit = 300;
    const { user } = await open();
    await user.click(await within(tree()).findByRole("treeitem", { name: /^ou=people/ }));
    await user.keyboard("{ArrowRight}");
    // End jumps to the last row; the note is not a place to stop.
    await user.keyboard("{End}");
    expect(await screen.findByText("The server stopped the list at 300 entries (its size limit)")).toBeInTheDocument();
    const rows = within(tree()).getAllByRole("treeitem");
    expect(rows[rows.length - 1]).toHaveAttribute("aria-selected", "true");
  });
});
