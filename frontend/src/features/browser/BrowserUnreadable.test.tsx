import { beforeEach, describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";
import { useBrowser } from "./store";

// An entry the server lists but refuses to read: the pane explains it and offers the DN.

const dn = "cn=unreadable,ou=people,dc=example,dc=org";

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
});

describe("an entry the server refuses to read", () => {
  it("says why, shows the DN and lets the person try again", async () => {
    const backend = createFakeBackend({ connections: sampleConnections() });
    const r = await backend.connect("prod", "", false);
    useApp.setState({ view: { name: "connected", session: r.session! } });
    const { user } = renderWith(<BrowserScreen session={r.session!} />, backend);
    await screen.findByRole("treeitem", { name: /^ou=people/ });

    act(() => useBrowser.getState().select(dn));

    expect(await screen.findByText("Can't read this entry.")).toBeInTheDocument();
    expect(screen.getByText(/access rule that allows listing and not reading/)).toBeInTheDocument();
    expect(screen.getByTestId("unreadable-dn")).toHaveTextContent(dn);
    expect(screen.getByRole("button", { name: "Copy DN" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Can't read this entry.")).toBeInTheDocument();
  });
});
