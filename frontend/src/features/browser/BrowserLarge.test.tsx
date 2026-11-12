import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { LARGE, resetFakeDirectory, setLargeProfile } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";
import { useBrowser } from "./store";

// The large profile: a group of 5,000 members. Every list that could hold them draws only what is in view.

async function openEveryone() {
  const backend = createFakeBackend({ connections: sampleConnections() });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await screen.findByRole("treeitem", { name: /^ou=people/ });
  act(() => useBrowser.getState().select(LARGE.group));
  await screen.findByRole("heading", { level: 1, name: "everyone" });
  return out;
}

beforeAll(() => setLargeProfile(true));
afterAll(() => setLargeProfile(false));
beforeEach(() => {
  FAKE.delayMs = 0;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
});

describe("a group of 5,000 members", () => {
  it("lists the members, 5,000 of them, drawing only the rows in view", async () => {
    const { user } = await openEveryone();
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(await screen.findByRole("heading", { name: "5,000 members" })).toBeInTheDocument();
    const rows = document.querySelectorAll("[role=tabpanel] ul > li");
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(120);
    // Each row says where it is in the list.
    expect(rows[0]).toHaveAttribute("aria-setsize", "5000");
    expect(rows[0]).toHaveAttribute("aria-posinset", "1");
  });

  it("shows 25 values of member with Show all, then a window of them", async () => {
    const { user } = await openEveryone();
    const table = await screen.findByRole("table", { name: "Attributes" });
    expect(within(table).getAllByTitle(/^Open uid=arch/)).toHaveLength(25);
    await user.click(within(table).getByRole("button", { name: "Show all 5,000 member values" }));
    const drawn = within(table).getAllByTitle(/^Open uid=arch/).length;
    expect(drawn).toBeGreaterThan(25);
    expect(drawn).toBeLessThan(150);
    await user.click(within(table).getByRole("button", { name: "Show fewer member values" }));
    expect(within(table).getAllByTitle(/^Open uid=arch/)).toHaveLength(25);
  });

  it("draws a window of the LDIF, not 5,000 lines", async () => {
    const { user } = await openEveryone();
    await user.click(screen.getByRole("tab", { name: "LDIF" }));
    const view = await screen.findByRole("region", { name: /LDIF of cn=everyone/ });
    const lines = view.querySelectorAll(".kn-ldif__line");
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.length).toBeLessThan(400);
    expect(view.querySelector(".kn-ldif__gutter")?.children.length).toBe(lines.length);
  });

  it("edits the member list without drawing 5,000 inputs", async () => {
    const { user } = await openEveryone();
    await user.click(await screen.findByRole("button", { name: "Edit member" }));
    const dialog = await screen.findByRole("dialog", { name: /Edit member/ });
    const inputs = within(dialog).getAllByRole("textbox", { name: /^member value \d+$/ });
    expect(inputs.length).toBeGreaterThan(5);
    expect(inputs.length).toBeLessThan(120);
    expect(within(dialog).getByLabelText("Change against the server").querySelectorAll(".kn-diff__row").length).toBeLessThan(120);
  });
});
