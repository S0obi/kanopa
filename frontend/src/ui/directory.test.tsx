import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DnBreadcrumb, LdifView, Tabs, tokenizeLdif } from "./directory";

describe("LDIF colours", () => {
  it("colour attribute names, DNs, base64 and folded lines", () => {
    const lines = tokenizeLdif("dn: uid=ada,dc=org\ncn: Ada\njpegPhoto:: /9j/AA==\n AAAA\n# note\n");
    expect(lines[0]).toEqual([["keyword", "dn"], ["punct", ": "], ["dn", "uid=ada,dc=org"]].map(([k, t]) => [k === "keyword" ? "attr" : k, t]));
    expect(lines[1][2]).toEqual(["value", "Ada"]);
    expect(lines[2][2][0]).toBe("encoded");
    expect(lines[3]).toEqual([["encoded", " AAAA"]]);
    expect(lines[4]).toEqual([["comment", "# note"]]);
  });
  it("number the lines of a read-only view", () => {
    const { container } = render(<LdifView value={"dn: cn=x\ncn: x\n"} />);
    expect(screen.getByRole("region", { name: "LDIF" })).toBeInTheDocument();
    expect(container.querySelectorAll(".kn-ldif__line")).toHaveLength(2);
  });
});

describe("DnBreadcrumb", () => {
  it("runs from the root to the entry and opens ancestors", async () => {
    const onNavigate = vi.fn();
    render(<DnBreadcrumb dn="uid=ada,ou=people,dc=example,dc=org" onNavigate={onNavigate} />);
    const segs = screen.getAllByRole("button");
    expect(segs.map((s) => s.textContent)).toEqual(["dc=org", "dc=example", "ou=people", "uid=ada"]);
    expect(segs[3]).toHaveAttribute("aria-current", "location");
    await userEvent.click(segs[2]);
    expect(onNavigate).toHaveBeenCalledWith("ou=people,dc=example,dc=org");
  });
});

describe("Tabs", () => {
  it("move with the arrow keys", async () => {
    const onChange = vi.fn();
    render(<Tabs label="Views" value="a" onChange={onChange} tabs={[{ id: "a", label: "A", count: 3 }, { id: "b", label: "B" }]} />);
    expect(screen.getByRole("tab", { name: "A3" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "A3" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
