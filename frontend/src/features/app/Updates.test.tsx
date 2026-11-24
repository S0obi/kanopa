import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend } from "@/api/fake";
import { renderWith } from "@/test/render";
import { resetUpdates } from "@/stores/updates";
import { useChanges } from "@/features/browser/changes";
import { AppMenu } from "./AppMenu";
import { Updates } from "./Updates";

const LONG = { timeout: 5000 };

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.window.pending = 0;
  FAKE.update = { supported: true, asked: false, auto: false, selfUpdate: true, state: "idle", version: "", percent: 0, current: "0.2.0", failure: "" };
  FAKE.updating = { next: "0.3.0", downloadPolls: 2, failDownload: false, failCheck: false, restarts: 0, releasesOpened: 0, polls: 0, refuseRestart: "" };
  useChanges.setState({ byConnection: {} });
  resetUpdates();
});

function App() {
  return (
    <>
      <AppMenu />
      <Updates />
    </>
  );
}

describe("Updates", () => {
  it("shows nothing, and adds no menu items, for a build that never checks", async () => {
    FAKE.update.supported = false;
    const { user } = renderWith(<App />, createFakeBackend());
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await screen.findByRole("menuitem", { name: "About Kanopa…" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Check for updates…" })).not.toBeInTheDocument();
  });

  it("asks once, says what is sent, and goes from the answer yes to a ready update", async () => {
    const { user } = renderWith(<App />, createFakeBackend());
    const dialog = await screen.findByRole("dialog", { name: "Keep Kanopa up to date?" });
    expect(within(dialog).getByText("api.github.com")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Check automatically" }));

    expect(await screen.findByText("Downloading Kanopa 0.3.0", undefined, LONG)).toBeInTheDocument();
    expect(await screen.findByText("Kanopa 0.3.0 is ready.", undefined, LONG)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(FAKE.update).toMatchObject({ asked: true, auto: true });

    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(FAKE.updating.restarts).toBe(1);
  });

  it("remembers Not now, checks nothing, and leaves the check-by-hand item in the menu", async () => {
    const { user } = renderWith(<App />, createFakeBackend());
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(await screen.findByRole("menuitem", { name: "Check for updates…" })).toBeInTheDocument();
    expect(FAKE.update).toMatchObject({ asked: true, auto: false, state: "idle" });
  });

  it("checks by hand with automatic checks off and says when Kanopa is up to date", async () => {
    FAKE.update.asked = true;
    FAKE.updating.next = "";
    const { user } = renderWith(<App />, createFakeBackend());
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates…" }));
    expect(await screen.findByText("Kanopa is up to date.", undefined, LONG)).toBeInTheDocument();
    expect(FAKE.update.auto).toBe(false);
  });

  it("turns automatic checks on and off from the menu", async () => {
    FAKE.update.asked = true;
    FAKE.updating.next = "";
    const { user } = renderWith(<App />, createFakeBackend());
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates automatically" }));
    expect(FAKE.update.auto).toBe(true);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates automatically" }));
    expect(FAKE.update.auto).toBe(false);
  });

  it("keeps Restart to update off while changes are pending, and says why", async () => {
    FAKE.update = { ...FAKE.update, asked: true, auto: true, state: "ready", version: "0.3.0", percent: 100 };
    useChanges.setState({ byConnection: { c1: { "uid=ada,dc=example,dc=org": { dn: "uid=ada,dc=example,dc=org", kind: "modify", attrs: {} } } } as never });
    renderWith(<App />, createFakeBackend());
    expect(await screen.findByText(/Apply or discard your pending change first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeDisabled();
    expect(FAKE.updating.restarts).toBe(0);
  });

  it("points an install that cannot replace itself at the Releases page", async () => {
    FAKE.update = { ...FAKE.update, asked: true, auto: true, selfUpdate: false, state: "available", version: "0.3.0" };
    const { user } = renderWith(<App />, createFakeBackend());
    expect(await screen.findByText("Kanopa 0.3.0 is available.")).toBeInTheDocument();
    expect(screen.getByText(/can't update itself here/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download 0.3.0" }));
    expect(FAKE.updating.releasesOpened).toBe(1);
  });

  it("says when an update didn't install, that Kanopa is unchanged, and offers the Releases page", async () => {
    FAKE.updating.failDownload = true;
    FAKE.update.asked = true;
    FAKE.update.auto = true;
    FAKE.update.state = "checking";
    const { user } = renderWith(<App />, createFakeBackend());
    expect(await screen.findByText("The update didn't install.", undefined, LONG)).toBeInTheDocument();
    expect(screen.getByText(/Kanopa is unchanged \(0\.2\.0\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open the Releases page" }));
    expect(FAKE.updating.releasesOpened).toBe(1);
  });

  it("lets the person close a notice", async () => {
    FAKE.update = { ...FAKE.update, asked: true, auto: true, state: "ready", version: "0.3.0", percent: 100 };
    const { user } = renderWith(<App />, createFakeBackend());
    await screen.findByText("Kanopa 0.3.0 is ready.");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Kanopa 0.3.0 is ready.")).not.toBeInTheDocument();
  });
});
