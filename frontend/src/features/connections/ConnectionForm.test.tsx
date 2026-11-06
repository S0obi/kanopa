import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackendContext, type Backend } from "@/api/backend";
import { FAKE, fakeBackend } from "@/api/fake";
import { ConnectionForm } from "./ConnectionForm";

function setup(backend: Backend = fakeBackend) {
  const user = userEvent.setup();
  render(
    <BackendContext.Provider value={backend}>
      <ConnectionForm platform="windows" />
    </BackendContext.Provider>,
  );
  const url = screen.getByLabelText("LDAP URL");
  const bindDn = screen.getByLabelText("Bind DN");
  const password = screen.getByLabelText("Password");
  return { user, url, bindDn, password };
}

async function fillAdmin(user: ReturnType<typeof userEvent.setup>, f: { url: HTMLElement; bindDn: HTMLElement; password: HTMLElement }, pw = "kanopa-admin") {
  await user.type(f.url, "ldaps://localhost:636");
  await user.type(f.bindDn, "cn=admin,dc=example,dc=org");
  await user.type(f.password, pw);
}

async function turnOffVerification(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Advanced/ }));
  await user.click(screen.getByLabelText("Verify the server certificate against the system trust store"));
}

beforeEach(() => {
  FAKE.delayMs = 0;
});

describe("ConnectionForm", () => {
  it("explains what is missing before testing", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Enter an LDAP URL such as ldaps://ldap.example.org:636.")).toBeInTheDocument();
    expect(screen.getByText("Enter a bind DN, or choose Anonymous.")).toBeInTheDocument();
    expect(screen.getByLabelText("LDAP URL")).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the URL and the encryption in step", async () => {
    const { user, url } = setup();
    await user.type(url, "ldap://localhost");
    expect(screen.getByRole("button", { name: "StartTLS" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "LDAPS" }));
    expect(url).toHaveValue("ldaps://localhost:636");
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(url).toHaveValue("ldap://localhost:389");
    expect(screen.getByText("Unencrypted.")).toBeInTheDocument();
  });

  it("reports a working connection", async () => {
    const f = setup();
    await fillAdmin(f.user, f);
    await turnOffVerification(f.user);
    await f.user.click(screen.getByRole("button", { name: "Test connection" }));
    const ok = await screen.findByText("Connection works");
    expect(ok.closest("[role=status]")).toHaveTextContent(
      "Bound as cn=admin,dc=example,dc=org in 42 ms over LDAPS. The server offers 1 naming context: dc=example,dc=org.",
    );
  });

  it("reports a refused password with its result code", async () => {
    const f = setup();
    await fillAdmin(f.user, f, "wrong");
    await turnOffVerification(f.user);
    await f.user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials (49)");
  });

  it("fails on the self-signed certificate while verification is on", async () => {
    const f = setup();
    await fillAdmin(f.user, f);
    await f.user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("signed by an unknown authority");
  });

  it("fetches the base DN from the server", async () => {
    const f = setup();
    await fillAdmin(f.user, f);
    await turnOffVerification(f.user);
    await f.user.click(screen.getByRole("button", { name: "Fetch from server" }));
    expect(await screen.findByDisplayValue("dc=example,dc=org")).toBe(screen.getByLabelText("Base DN"));
  });

  it("clears a result as soon as a setting changes", async () => {
    const f = setup();
    await fillAdmin(f.user, f, "wrong");
    await turnOffVerification(f.user);
    await f.user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("alert");
    await f.user.type(f.password, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends no credentials for an anonymous bind", async () => {
    const spy = vi.fn(fakeBackend.testConnection);
    const f = setup({ ...fakeBackend, testConnection: spy });
    await f.user.type(f.url, "ldap://localhost");
    await f.user.click(screen.getByRole("button", { name: "None" }));
    await f.user.selectOptions(screen.getByLabelText("Bind method"), "anonymous");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await f.user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Connection works");
    expect(spy.mock.calls[0][0]).toMatchObject({ bind: "anonymous", bindDn: "", password: "" });
  });
});
