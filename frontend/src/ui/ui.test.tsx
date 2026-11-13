import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Banner, Button, Checkbox, Dialog, Kbd, Logo, Segmented, Select, StatusIndicator, Switch, TextField, Tooltip } from "@/ui";

describe("Button", () => {
  it("labels an icon-only button for screen readers and as a tooltip", () => {
    render(<Button icon="copy" label="Copy DN" />);
    const b = screen.getByRole("button", { name: "Copy DN" });
    expect(b).toHaveAttribute("title", "Copy DN");
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("kn-btn", "kn-btn--secondary", "kn-btn--icon");
  });

  it("shows busy work", () => {
    render(<Button busy>Test connection</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });
});

describe("Kbd", () => {
  it("writes shortcuts the macOS way", () => {
    const { container } = render(<Kbd keys={["shift", "mod", "f"]} platform="mac" />);
    expect(container.textContent).toBe("⇧⌘F");
  });
  it("writes shortcuts the Windows way", () => {
    const { container } = render(<Kbd keys={["mod", "shift", "f"]} platform="windows" />);
    expect(container.textContent).toBe("Ctrl+Shift+F");
  });
});

describe("TextField", () => {
  it("links the label, hint and error to the input", () => {
    const { rerender } = render(<TextField label="Base DN" hint="Leave empty." />);
    const input = screen.getByLabelText("Base DN");
    expect(input).toHaveAccessibleDescription("Leave empty.");
    rerender(<TextField label="Base DN" error="Invalid DN syntax (34)" />);
    expect(screen.getByLabelText("Base DN")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Base DN")).toHaveAccessibleDescription("Invalid DN syntax (34)");
  });
});

describe("Select", () => {
  const options = [{ value: "simple", label: "Simple bind" }, { value: "anonymous", label: "Anonymous" }, { value: "sasl", label: "SASL", disabled: true }, "Zeta"];
  const box = () => screen.getByRole("combobox", { name: "Bind method" });

  it("shows the chosen option under its label", () => {
    render(<Select label="Bind method" options={options} />);
    expect(box()).toHaveTextContent("Simple bind");
    expect(box()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens a list, marks the chosen option, and a click chooses another", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} value="simple" onChange={onChange} />);
    await user.click(box());
    expect(box()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: "Simple bind" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: "Anonymous" }));
    expect(onChange).toHaveBeenCalledWith("anonymous");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box()).toHaveFocus();
  });

  it("keeps its own value when it is not controlled", async () => {
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} />);
    await user.click(box());
    await user.click(screen.getByRole("option", { name: "Anonymous" }));
    expect(box()).toHaveTextContent("Anonymous");
  });

  it("works from the keyboard: arrows skip a disabled option, Home and End, Enter chooses, Esc closes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} value="simple" onChange={onChange} />);
    box().focus();
    await user.keyboard("{ArrowDown}");
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Simple bind" }).id);
    await user.keyboard("{ArrowDown}");
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Anonymous" }).id);
    await user.keyboard("{ArrowDown}");
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Zeta" }).id);
    await user.keyboard("{Home}");
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Simple bind" }).id);
    await user.keyboard("{End}{Enter}");
    expect(onChange).toHaveBeenCalledWith("Zeta");
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not choose a disabled option", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} value="simple" onChange={onChange} />);
    await user.click(box());
    expect(screen.getByRole("option", { name: "SASL" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "SASL" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("jumps to an option by typing its first letters", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} value="simple" onChange={onChange} />);
    box().focus();
    await user.keyboard("z{Enter}");
    expect(onChange).toHaveBeenCalledWith("Zeta");
  });

  it("closes on an outside click", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Select label="Bind method" options={options} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    await user.click(box());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes its list on Esc without closing the dialog around it", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Dialog title="New entry" onClose={onClose}>
        <Select label="Bind method" options={options} />
      </Dialog>,
    );
    await user.click(box());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("can be disabled", async () => {
    const user = userEvent.setup();
    render(<Select label="Bind method" options={options} disabled />);
    await user.click(box());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("Checkbox and Switch", () => {
  it("toggle from their labels", async () => {
    render(
      <>
        <Checkbox label="Verify the certificate" />
        <Switch label="Read-only" />
      </>,
    );
    await userEvent.click(screen.getByText("Verify the certificate"));
    await userEvent.click(screen.getByText("Read-only"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("switch")).toBeChecked();
  });
});

describe("Segmented", () => {
  it("is a group of pressed buttons", async () => {
    const onChange = vi.fn();
    render(<Segmented label="Encryption" value="ldaps" options={[{ value: "ldaps", label: "LDAPS" }, { value: "none", label: "None" }]} onChange={onChange} />);
    expect(screen.getByRole("group", { name: "Encryption" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "LDAPS" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "None" }));
    expect(onChange).toHaveBeenCalledWith("none");
  });
});

describe("Banner, StatusIndicator, Logo, Tooltip", () => {
  it("announces danger as an alert", () => {
    render(<Banner tone="danger" title="Connection failed.">Invalid credentials (49)</Banner>);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed.Invalid credentials (49)");
  });
  it("carries a word with every status", () => {
    render(<StatusIndicator status="connecting" />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
  });
  it("names the logo", () => {
    render(<Logo wordmark />);
    expect(screen.getByRole("img", { name: "Kanopa" })).toBeInTheDocument();
  });
  it("shows a tooltip on focus", async () => {
    render(
      <Tooltip content="Copy DN">
        <button type="button">c</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy DN");
  });
});
