import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { resetFakeDirectory } from "@/api/fakeDirectory";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { useToasts } from "@/ui";
import { BrowserScreen } from "./BrowserScreen";
import { useChanges } from "./changes";

// The account status banner: locked (Unlock), expired (Reset password…), must change. One banner, the worst state first.

async function open(uid: string, title: string, patch: Record<string, unknown> = {}) {
  const backend = createFakeBackend({ connections: sampleConnections().map((c) => (c.id === "prod" ? { ...c, ...patch } : c)) });
  const r = await backend.connect("prod", "", false);
  useApp.setState({ view: { name: "connected", session: r.session! } });
  const out = renderWith(<BrowserScreen session={r.session!} />, backend);
  await out.user.click(await screen.findByRole("treeitem", { name: /^ou=people/ }));
  await out.user.keyboard("{ArrowRight}");
  await out.user.click(await screen.findByRole("treeitem", { name: new RegExp(`^uid=${uid} `) }));
  await screen.findByRole("heading", { level: 1, name: title });
  return { ...out, backend };
}

const bar = () => screen.getByRole("region", { name: "Pending changes" });
const MOMENT = String.raw`\d{1,2} Nov( \d{4})? at \d{2}:\d{2}`;

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.lost = false;
  FAKE.passwordPolicy = true;
  FAKE.activeDirectory = false;
  resetFakeDirectory();
  useChanges.setState({ byConnection: {} });
  useToasts.setState({ toasts: [] });
});

describe("the account status banner", () => {
  it("says a lock from failed logins, and unlocks it as a pending change", async () => {
    const { user, backend } = await open("katherine", "Katherine Johnson");
    const banner = (await screen.findByText("Locked after failed logins.")).closest(".kn-banner") as HTMLElement;
    expect(banner).toHaveTextContent(new RegExp(`The lock was set on ${MOMENT}\\. Katherine Johnson can't log in until it expires or you unlock the account\\.`));
    expect(banner).toHaveAttribute("role", "status");

    await user.click(within(banner).getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Unlock pending.")).toBeInTheDocument();
    expect(screen.getByText("The lock is removed when you apply pending changes.")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("Pending change: pwdAccountLockedTime on uid=katherine");
    await user.click(within(bar()).getByRole("button", { name: "Review LDIF" }));
    expect(await screen.findByRole("region", { name: "Pending changes as LDIF" })).toHaveTextContent("delete: pwdAccountLockedTime");

    // Undo puts the banner back and empties the changes.
    await user.click(screen.getByRole("button", { name: "Undo unlock" }));
    expect(await screen.findByText("Locked after failed logins.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pending changes" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(within(bar()).getByRole("button", { name: /Apply/ }));
    expect(await screen.findByText(/^Saved 1 change to localhost\./)).toBeInTheDocument();
    await waitForNoBanner();
    expect((await backend.accountStatus("prod", "uid=katherine,ou=people,dc=example,dc=org")).locked).toBe(false);
  });

  it("says a lock by an admin", async () => {
    await open("margaret", "Margaret Hamilton");
    const banner = (await screen.findByText("Locked by an admin.")).closest(".kn-banner") as HTMLElement;
    expect(banner).toHaveTextContent("Margaret Hamilton can't log in until someone unlocks the account.");
    expect(within(banner).getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("says a lock may have ended when the policy cannot be read, and still offers Unlock", async () => {
    await open("alan", "Alan Turing");
    const banner = (await screen.findByText("Locked after failed logins.")).closest(".kn-banner") as HTMLElement;
    expect(banner).toHaveTextContent("It may have expired already: Kanopa can't read how long the lock lasts.");
    expect(within(banner).getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("says a password must change at the next login, with no action", async () => {
    await open("grace", "Grace Hopper");
    const banner = (await screen.findByText("Must change password.")).closest(".kn-banner") as HTMLElement;
    expect(banner).toHaveTextContent("Grace Hopper chooses a new password at the next login.");
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says an expired password, and opens Reset password… from it", async () => {
    const { user } = await open("edsger", "Edsger Dijkstra");
    const banner = (await screen.findByText("Password expired.")).closest(".kn-banner") as HTMLElement;
    expect(banner).toHaveTextContent(/It expired on \d{1,2} Jan 2020\. Edsger Dijkstra can't log in until the password is reset\./);
    await user.click(within(banner).getByRole("button", { name: "Reset password…" }));
    expect(await screen.findByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
  });

  it("shows nothing for a person with no known problem", async () => {
    await open("ada", "Ada Lovelace");
    await waitForNoBanner();
    expect(screen.queryByText(/Locked|Must change password|Password expired|Unlock pending/)).not.toBeInTheDocument();
  });

  it("shows nothing on a server without a password policy, and asks nothing of it", async () => {
    FAKE.passwordPolicy = false;
    const { backend } = await open("katherine", "Katherine Johnson");
    const spy: string[] = [];
    const original = backend.accountStatus;
    backend.accountStatus = async (id, dn) => (spy.push(dn), original(id, dn));
    await waitForNoBanner();
    expect(screen.queryByText("Locked after failed logins.")).not.toBeInTheDocument();
    expect(spy).toEqual([]);
  });

  it("does not offer Unlock on a read-only connection", async () => {
    await open("katherine", "Katherine Johnson", { readOnly: true });
    const banner = (await screen.findByText("Locked after failed logins.")).closest(".kn-banner") as HTMLElement;
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
  });
});

async function waitForNoBanner() {
  // A banner that is going to appear does so once the status is read; give that read time to land.
  await new Promise((r) => setTimeout(r, 50));
}
