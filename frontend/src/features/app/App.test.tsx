import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useLayout } from "@/stores/layout";
import { useToasts } from "@/ui";
import { BrowserScreen } from "@/features/browser/BrowserScreen";
import { useChanges } from "@/features/browser/changes";
import { AppMenu } from "./AppMenu";
import { CrashBoundary, crashDetails } from "./CrashBoundary";

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.opened = { logFolder: 0, repo: 0 };
  FAKE.clientErrors = [];
  FAKE.layout = { sidebarWidth: 0, tab: "" };
  useToasts.setState({ toasts: [] });
  useChanges.setState({ byConnection: {} });
  useApp.setState({ view: { name: "welcome" } });
});

describe("About", () => {
  it("shows the version and the system, and copies diagnostics without anything about a server", async () => {
    const backend = createFakeBackend();
    const { user } = renderWith(<AppMenu />, backend);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "About Kanopa…" }));
    const dialog = await screen.findByRole("dialog", { name: "About Kanopa" });
    expect(await within(dialog).findByText("0.0.0-fake")).toBeInTheDocument();
    expect(within(dialog).getByText("(abc1234)")).toBeInTheDocument();
    expect(within(dialog).getByText("windows amd64")).toBeInTheDocument();
    expect(within(dialog).getByText("WebView2 150.0")).toBeInTheDocument();
    expect(within(dialog).getByText("MIT")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Copy diagnostics" }));
    expect(backend.clipboard.text).toContain("Kanopa 0.0.0-fake (abc1234)");
    expect(backend.clipboard.text).not.toMatch(/Server:/);
    expect(await screen.findByText("Copied the diagnostics.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Open the project page" }));
    await user.click(within(dialog).getByRole("button", { name: "Open log folder" }));
    expect(FAKE.opened).toEqual({ logFolder: 1, repo: 1 });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "About Kanopa" })).not.toBeInTheDocument();
  });

  it("adds the make of the server you are connected to, and only that", async () => {
    const backend = createFakeBackend({ connections: sampleConnections() });
    const r = await backend.connect("prod", "", false);
    useApp.setState({ view: { name: "connected", session: { ...r.session!, vendor: "OpenLDAP 2.6" } } });
    const { user } = renderWith(<AppMenu />, backend);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "About Kanopa…" }));
    await user.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    expect(backend.clipboard.text).toContain("Server: OpenLDAP 2.6");
    expect(backend.clipboard.text).not.toContain("localhost");
  });

  it("opens the log folder from the menu", async () => {
    const { user } = renderWith(<AppMenu />, createFakeBackend());
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Open log folder" }));
    expect(FAKE.opened.logFolder).toBe(1);
  });
});

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("the entry view broke");
  return <p>All good</p>;
}

function Wrapper() {
  const [explode, setExplode] = useState(true);
  return (
    <CrashBoundary>
      <button type="button" onClick={() => setExplode(false)}>
        Fix it
      </button>
      <Bomb explode={explode} />
    </CrashBoundary>
  );
}

describe("the crash screen", () => {
  beforeEach(() => {
    // React logs the error it catches; the test doesn't need that noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("replaces a blank window with a calm screen, logs the error, and Try again brings the screen back", async () => {
    const backend = createFakeBackend();
    function Page({ explode }: { explode: boolean }) {
      return (
        <CrashBoundary>
          <Bomb explode={explode} />
        </CrashBoundary>
      );
    }
    const first = renderWith(<Page explode />, backend);
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText(/Your connections and settings are safe/)).toBeInTheDocument();
    expect(FAKE.clientErrors).toHaveLength(1);
    expect(FAKE.clientErrors[0]!.message).toBe("Error: the entry view broke");
    expect(FAKE.clientErrors[0]!.stack).toContain("Bomb");

    await first.user.click(screen.getByRole("button", { name: "Copy details" }));
    expect(backend.clipboard.text).toContain("Kanopa 0.0.0-fake");
    expect(backend.clipboard.text).toContain("the entry view broke");
    await first.user.click(screen.getByRole("button", { name: "Open log folder" }));
    expect(FAKE.opened.logFolder).toBe(1);
  });

  it("offers Try again twice, then only Reload window", async () => {
    const { user } = renderWith(<Wrapper />, createFakeBackend());
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Trying again while the cause is still there crashes again; the second time it stops offering it.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload window" })).toBeInTheDocument();
  });

  it("says what a reload would drop, and keeps the changes for Try again", async () => {
    useChanges.setState({
      byConnection: { prod: { "uid=ada,ou=people,dc=example,dc=org": { dn: "uid=ada,ou=people,dc=example,dc=org", title: "Ada", attrs: [{ name: "title", kind: "text", before: ["a"], after: ["b"] }] } } },
    });
    renderWith(<Wrapper />, createFakeBackend());
    expect(await screen.findByText(/Your 1 pending change is kept if you try again, and dropped if you reload the window/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload and drop 1 change" })).toBeInTheDocument();
    expect(Object.keys(useChanges.getState().byConnection.prod ?? {})).toHaveLength(1);
  });

  it("writes details for a bug report from the error", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n    at x";
    expect(crashDetails(e, "in Bomb", "0.1.0")).toBe("Kanopa 0.1.0\nError: boom\nError: boom\n    at x\nin Bomb");
  });
});

describe("what the interface remembers", () => {
  it("opens with the saved tree width and entry tab, and remembers a change", async () => {
    FAKE.layout = { sidebarWidth: 340, tab: "ldif" };
    const backend = createFakeBackend({ connections: sampleConnections() });
    await useLayout.getState().load(backend);
    expect(useLayout.getState()).toMatchObject({ sidebarWidth: 340, tab: "ldif" });

    const r = await backend.connect("prod", "", false);
    useApp.setState({ view: { name: "connected", session: r.session! } });
    const { user } = renderWith(<BrowserScreen session={r.session!} />, backend);
    await screen.findByRole("treeitem", { name: /^ou=people/ });
    const nav = screen.getByRole("navigation", { name: "Directory" });
    expect((nav.parentElement as HTMLElement).style.width).toBe("340px");

    await user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
    expect(await screen.findByRole("tab", { name: "LDIF" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /^Attributes/ }));
    await vi.waitFor(() => expect(FAKE.layout.tab).toBe("attributes"), { timeout: 2000 });
  });

  it("ignores a saved tab it doesn't have, and a width that can't be right", async () => {
    FAKE.layout = { sidebarWidth: -4, tab: "settings" };
    await useLayout.getState().load(createFakeBackend());
    expect(useLayout.getState()).toMatchObject({ sidebarWidth: 0, tab: "" });
  });
});
