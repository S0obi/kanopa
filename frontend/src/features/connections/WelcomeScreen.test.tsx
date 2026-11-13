import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FAKE, createFakeBackend, sampleConnections } from "@/api/fake";
import { renderWith } from "@/test/render";
import { useApp } from "@/stores/app";
import { WelcomeScreen } from "./WelcomeScreen";

function setup(connections = sampleConnections(), notice = "") {
  const backend = createFakeBackend({ connections, notice });
  return { ...renderWith(<WelcomeScreen platform="windows" />, backend), backend };
}

const row = (name: string) => screen.getByText(name, { selector: "span" }).closest("[role=row]") as HTMLElement;

beforeEach(() => {
  FAKE.delayMs = 0;
  useApp.setState({ view: { name: "welcome" } });
});

describe("WelcomeScreen", () => {
  it("lists the saved connections like the design", async () => {
    setup();
    expect(await screen.findByText("Production directory")).toBeInTheDocument();
    const prod = row("Production directory");
    expect(within(prod).getByText("ldaps://localhost:636")).toBeInTheDocument();
    expect(within(prod).getByText("LDAPS")).toBeInTheDocument();
    expect(within(prod).getByText(/^Today, \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(row("Local OpenLDAP")).getByText("Unencrypted")).toBeInTheDocument();
    expect(within(row("Local OpenLDAP")).getByText("Anonymous bind")).toBeInTheDocument();
    expect(within(row("Staging")).getByText("Last attempt failed")).toBeInTheDocument();
    expect(screen.getByText("4 saved connections")).toBeInTheDocument();
  });

  it("shows an empty state with no connections", async () => {
    setup([]);
    expect(await screen.findByText("No saved connections yet")).toBeInTheDocument();
    expect(screen.getByText("0 saved connections")).toBeInTheDocument();
  });

  it("shows the notice about a damaged file once", async () => {
    setup([], "Kanopa couldn't read your saved connections, so it started with none.");
    expect(await screen.findByText(/started with none/)).toBeInTheDocument();
  });

  it("filters by name, host or base DN", async () => {
    const { user } = setup();
    await screen.findByText("Production directory");
    await user.type(screen.getByLabelText("Filter connections"), "corp");
    expect(screen.getByText("Corporate Active Directory")).toBeInTheDocument();
    expect(screen.queryByText("Production directory")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Filter connections"));
    await user.type(screen.getByLabelText("Filter connections"), "zzz");
    expect(screen.getByText("No saved connection matches “zzz”.")).toBeInTheDocument();
  });

  it("Ctrl+F focuses the filter and Ctrl+N opens a new connection", async () => {
    const { user } = setup();
    await screen.findByText("Production directory");
    await user.keyboard("{Control>}f{/Control}");
    expect(screen.getByLabelText("Filter connections")).toHaveFocus();
    await user.keyboard("{Control>}n{/Control}");
    expect(screen.getByRole("dialog", { name: "New connection" })).toBeInTheDocument();
  });

  it("connects the highlighted connection with Enter", async () => {
    const { user } = setup();
    await screen.findByText("Production directory");
    await user.click(screen.getByLabelText("Filter connections"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(useApp.getState().view.name).toBe("connected"));
  });

  it("offers Update password after a refused bind", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Connect to Corporate Active Directory" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Bind refused.");
    expect(alert).toHaveTextContent("Invalid credentials (49)");
    await user.click(within(alert).getByRole("button", { name: "Update password" }));
    expect(screen.getByRole("dialog", { name: "Edit connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password", { exact: true })).toHaveFocus();
  });

  it("offers Edit connection after a timeout", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Connect to Staging" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Timeout (-5)");
    expect(within(alert).getByRole("button", { name: "Edit connection" })).toBeInTheDocument();
  });

  it("asks once before connecting without encryption", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Connect to Local OpenLDAP" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Connect without encryption?" });
    expect(dialog).toHaveTextContent("localhost:389 uses neither LDAPS nor StartTLS");
    await user.click(within(dialog).getByRole("button", { name: "Connect anyway" }));
    await waitFor(() => expect(useApp.getState().view.name).toBe("connected"));

    useApp.setState({ view: { name: "welcome" } });
    await user.click(await screen.findByRole("button", { name: "Connect to Local OpenLDAP" }));
    await waitFor(() => expect(useApp.getState().view.name).toBe("connected"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks for a password that is not saved, and can save it", async () => {
    const conns = sampleConnections();
    conns[0] = { ...conns[0], savePassword: false, hasPassword: false, password: undefined };
    const { user, backend } = setup(conns);
    await user.click(await screen.findByRole("button", { name: "Connect to Production directory" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to Production directory" });
    await user.type(within(dialog).getByLabelText("Password"), "kanopa-admin");
    await user.click(within(dialog).getByLabelText("Save the password in the Windows Credential Manager"));
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(useApp.getState().view.name).toBe("connected"));
    expect(backend.passwords.get("prod")).toBe("kanopa-admin");
  });

  it("duplicates right after the original and opens it for editing", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Production directory" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(await screen.findByRole("dialog", { name: "Edit connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Connection name")).toHaveValue("Production directory (copy)");
    await user.keyboard("{Escape}");
    const names = screen.getAllByRole("row").slice(1).map((r) => r.querySelector(".font-semibold")?.textContent);
    expect(names.slice(0, 2)).toEqual(["Production directory", "Production directory (copy)"]);
  });

  it("deletes after a confirmation that names the host and the store", async () => {
    const { user, backend } = setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Production directory" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete the connection “Production directory”?" });
    expect(dialog).toHaveTextContent("Kanopa removes its settings and the saved password from the Windows Credential Manager. Nothing changes on localhost. This cannot be undone.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText("Deleted the connection “Production directory”.")).toBeInTheDocument();
    expect(screen.queryByText("Production directory", { selector: "span" })).not.toBeInTheDocument();
    expect(backend.passwords.has("prod")).toBe(false);
  });

  it("creates a connection and shows it in the list", async () => {
    const { user } = setup([]);
    await user.click((await screen.findAllByRole("button", { name: "New connection" }))[0]);
    await user.type(screen.getByLabelText("Connection name"), "Test directory");
    await user.type(screen.getByLabelText("LDAP URL"), "ldaps://localhost:636");
    await user.type(screen.getByLabelText("Bind DN"), "cn=admin,dc=example,dc=org");
    await user.type(screen.getByLabelText("Password", { exact: true }), "kanopa-admin");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved “Test directory”.")).toBeInTheDocument();
    expect(screen.getByText("Test directory", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("1 saved connection")).toBeInTheDocument();
  });
});

describe("WelcomeScreen — review fixes", () => {
  it("keeps arrow keys out of the list while a dialog is open", async () => {
    const { user } = setup();
    await screen.findByText("Production directory");
    await user.click(screen.getByRole("button", { name: "Actions for Staging" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit…" }));
    // The bind method takes the arrow key itself, and the highlighted row behind the dialog stays put.
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Bind method" }), { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Bind method" })).toBeInTheDocument();
    expect(row("Staging")).toHaveAttribute("data-active", "true");
  });

  it("moves through the row menu without moving the highlight", async () => {
    const { user } = setup();
    await screen.findByText("Production directory");
    await user.click(screen.getByRole("button", { name: "Actions for Staging" }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    expect(row("Staging")).toHaveAttribute("data-active", "true");
  });

  it("keeps focus on Connect while connecting", async () => {
    FAKE.delayMs = 200;
    const { user } = setup();
    const connect = await screen.findByRole("button", { name: "Connect to Staging" });
    await user.click(connect);
    expect(connect).toHaveAccessibleName("Connecting to Staging");
    expect(connect).toHaveFocus();
  });

  it("connects a new connection with the password typed but not saved", async () => {
    const { user } = setup([]);
    await user.click((await screen.findAllByRole("button", { name: "New connection" }))[0]);
    await user.type(screen.getByLabelText("Connection name"), "Test directory");
    await user.type(screen.getByLabelText("LDAP URL"), "ldaps://localhost:636");
    await user.type(screen.getByLabelText("Bind DN"), "cn=admin,dc=example,dc=org");
    await user.type(screen.getByLabelText("Password", { exact: true }), "kanopa-admin");
    await user.click(screen.getByLabelText("Save the password in the Windows Credential Manager"));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(screen.getByLabelText("Verify the server certificate against the system trust store"));
    await user.click(screen.getByRole("button", { name: /Save and connect/ }));
    await waitFor(() => expect(useApp.getState().view.name).toBe("connected"));
    expect(screen.queryByRole("dialog", { name: /Connect to/ })).not.toBeInTheDocument();
  });
});
