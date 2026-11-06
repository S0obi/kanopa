import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Banner, Button, Checkbox, Kbd, Logo, Segmented, Select, StatusIndicator, Switch, TextField, Tooltip } from "@/ui";

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
  it("renders options with a label", () => {
    render(<Select label="Bind method" options={[{ value: "simple", label: "Simple bind" }, "Anonymous"]} />);
    expect(screen.getByLabelText("Bind method")).toHaveDisplayValue("Simple bind");
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
