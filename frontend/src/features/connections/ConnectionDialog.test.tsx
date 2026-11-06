import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { renderWith } from "@/test/render";
import { ConnectionDialog, type ConnectionDialogProps } from "./ConnectionDialog";

type User = ReturnType<typeof userEvent.setup>;

function setup(props: Partial<ConnectionDialogProps> = {}, backend = createFakeBackend()) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const r = renderWith(<ConnectionDialog mode="new" platform="windows" onSaved={onSaved} onClose={onClose} {...props} />, backend);
  return { ...r, onSaved, onClose, backend };
}

async function fillAdmin(user: User, pw = "kanopa-admin") {
  await user.type(screen.getByLabelText("Connection name"), "Test directory");
  await user.type(screen.getByLabelText("LDAP URL"), "ldaps://localhost:636");
  await user.type(screen.getByLabelText("Bind DN"), "cn=admin,dc=example,dc=org");
  await user.type(screen.getByLabelText("Password", { exact: true }), pw);
}

async function verificationOff(user: User) {
  await user.click(screen.getByRole("button", { name: /Advanced/ }));
  await user.click(screen.getByLabelText("Verify the server certificate against the system trust store"));
}

beforeEach(() => {
  FAKE.delayMs = 0;
});

describe("ConnectionDialog — new", () => {
  it("is a labelled modal dialog that focuses the name", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "New connection" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Connection name")).toHaveFocus();
    expect(screen.getByText(/The password goes to the Windows Credential Manager, never to the settings file\./)).toBeInTheDocument();
  });

  it("explains what is missing before saving", async () => {
    const { user, onSaved } = setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a name for this connection.")).toBeInTheDocument();
    expect(screen.getByText("Enter an LDAP URL such as ldaps://ldap.example.org:636.")).toBeInTheDocument();
    expect(screen.getByText("Enter a bind DN, or choose Anonymous.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("tests without needing a name", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("LDAP URL"), "ldaps://localhost:636");
    await user.type(screen.getByLabelText("Bind DN"), "cn=admin,dc=example,dc=org");
    await user.type(screen.getByLabelText("Password", { exact: true }), "kanopa-admin");
    await verificationOff(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByText("Connection works")).closest("[role=status]")).toHaveTextContent(
      "Bound as cn=admin,dc=example,dc=org in 42 ms over LDAPS. The server offers 1 naming context: dc=example,dc=org.",
    );
    expect(screen.queryByText("Enter a name for this connection.")).not.toBeInTheDocument();
  });

  it("keeps the URL and the encryption in step", async () => {
    const { user } = setup();
    const url = screen.getByLabelText("LDAP URL");
    await user.type(url, "ldap://localhost");
    expect(screen.getByRole("button", { name: "StartTLS" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "LDAPS" }));
    expect(url).toHaveValue("ldaps://localhost:636");
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(url).toHaveValue("ldap://localhost:389");
    expect(screen.getByText("Unencrypted.")).toBeInTheDocument();
  });

  it("reports a refused password with its result code", async () => {
    const { user } = setup();
    await fillAdmin(user, "wrong");
    await verificationOff(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials (49)");
  });

  it("fetches the base DN from the server", async () => {
    const { user } = setup();
    await fillAdmin(user);
    await verificationOff(user);
    await user.click(screen.getByRole("button", { name: "Fetch from server" }));
    expect(await screen.findByDisplayValue("dc=example,dc=org")).toBe(screen.getByLabelText("Base DN"));
  });

  it("saves, with the password in the credential store", async () => {
    const { user, onSaved, backend } = setup();
    await fillAdmin(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Test directory", url: "ldaps://localhost:636", hasPassword: true }), false, "");
    const saved = onSaved.mock.calls[0][0];
    expect(backend.passwords.get(saved.id)).toBe("kanopa-admin");
  });

  it("Save and connect, also with Ctrl+Enter", async () => {
    const { user, onSaved } = setup();
    await fillAdmin(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), true, "");
  });

  it("puts the primary action first on Windows and last on macOS", () => {
    const names = () => screen.getAllByRole("button").map((b) => b.textContent).filter((t) => /^(Cancel|Save)/.test(t ?? ""));
    const { unmount } = setup();
    expect(names()).toEqual(["Save and connectCtrl+Enter", "Save", "Cancel"]);
    unmount();
    setup({ platform: "mac" });
    expect(names()).toEqual(["Cancel", "Save", "Save and connect⌘↩"]);
  });

  it("closes with Escape", async () => {
    const { user, onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConnectionDialog — edit", () => {
  const conn = { ...sampleConnections()[0], password: undefined };

  it("keeps the saved password when the field stays empty", async () => {
    const backend = createFakeBackend({ connections: sampleConnections() });
    const { user, onSaved } = setup({ mode: "edit", connection: conn }, backend);
    expect(screen.getByRole("dialog", { name: "Edit connection" })).toBeInTheDocument();
    expect(screen.getByText("Leave empty to keep the saved password.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Connection name"));
    await user.type(screen.getByLabelText("Connection name"), "Prod");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "prod", name: "Prod" }), false, "");
    expect(backend.passwords.get("prod")).toBe("kanopa-admin");
  });

  it("tests with the saved password", async () => {
    const backend = createFakeBackend({ connections: sampleConnections() });
    const { user } = setup({ mode: "edit", connection: conn }, backend);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection works")).toBeInTheDocument();
  });

  it("asks for the current password after a refused bind", () => {
    setup({ mode: "edit", connection: conn, reason: "badPassword" });
    expect(screen.getByText(/The server refused the saved password for/)).toHaveTextContent("Invalid credentials (49)");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveFocus();
  });
});

describe("ConnectionDialog — review fixes", () => {
  it("saves once however often Ctrl+Enter is pressed", async () => {
    const backend = createFakeBackend();
    const spy = vi.spyOn(backend, "saveConnection");
    const { user, onSaved } = setup({}, backend);
    await fillAdmin(user);
    await user.keyboard("{Control>}{Enter}{Enter}{Enter}{/Control}");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("hands over a password that is typed but not saved", async () => {
    const { user, onSaved, backend } = setup();
    await fillAdmin(user);
    await user.click(screen.getByLabelText("Save the password in the Windows Credential Manager"));
    await user.click(screen.getByRole("button", { name: /Save and connect/ }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ savePassword: false, hasPassword: false }), true, "kanopa-admin");
    expect(backend.passwords.size).toBe(0);
  });

  it("keeps focus on a busy button, so Ctrl+Enter still works after Test connection", async () => {
    FAKE.delayMs = 200;
    const { user, onSaved } = setup();
    await fillAdmin(user);
    await verificationOff(user);
    const test = screen.getByRole("button", { name: "Test connection" });
    await user.click(test);
    expect(test).toHaveAttribute("aria-busy", "true");
    expect(test).not.toBeDisabled();
    expect(test).toHaveFocus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("leaves arrow keys to the fields inside the dialog", () => {
    setup();
    // fireEvent returns false when a handler called preventDefault().
    expect(fireEvent.keyDown(screen.getByLabelText("Bind method"), { key: "ArrowDown" })).toBe(true);
  });
});
