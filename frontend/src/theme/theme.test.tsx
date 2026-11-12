import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { FAKE, createFakeBackend } from "@/api/fake";
import { renderWith } from "@/test/render";
import { useToasts } from "@/ui";
import { ThemeMenu } from "./ThemeMenu";
import { resolveTheme, useTheme } from "./theme";

/** A stand-in for the browser's dark-mode query, which the test can flip. */
function osTheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((f) => f());
    },
    listeners,
  };
}

const page = () => document.documentElement.dataset;

beforeEach(() => {
  FAKE.delayMs = 0;
  FAKE.theme = { choice: "system", appearance: "light" };
  FAKE.failThemeSave = false;
  useToasts.setState({ toasts: [] });
  delete page().theme;
  delete page().themeChoice;
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveTheme", () => {
  it("follows the OS only for System", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("the theme store", () => {
  it("starts from the saved choice and paints the window for it", async () => {
    osTheme(false);
    FAKE.theme.choice = "dark";
    await useTheme.getState().start(createFakeBackend());
    expect(page().theme).toBe("dark");
    expect(page().themeChoice).toBe("dark");
    expect(FAKE.theme.appearance).toBe("dark");
  });

  it("follows the OS while the choice is System, and stops when it is not", async () => {
    const os = osTheme(false);
    const backend = createFakeBackend();
    await useTheme.getState().start(backend);
    expect(page().theme).toBe("light");
    os.set(true);
    expect(page().theme).toBe("dark");
    expect(FAKE.theme.appearance).toBe("dark");

    await useTheme.getState().choose(backend, "light");
    os.set(false);
    os.set(true);
    // A manual choice stays, and the window is told again after each OS change.
    expect(page().theme).toBe("light");
    expect(FAKE.theme.appearance).toBe("light");
  });

  it("saves a choice, and keeps it for this run when it can't be saved", async () => {
    osTheme(false);
    const backend = createFakeBackend();
    await useTheme.getState().start(backend);
    await useTheme.getState().choose(backend, "dark");
    expect(FAKE.theme.choice).toBe("dark");
    expect(useToasts.getState().toasts).toHaveLength(0);

    FAKE.failThemeSave = true;
    await useTheme.getState().choose(backend, "light");
    expect(page().theme).toBe("light");
    expect(useToasts.getState().toasts[0]?.message).toMatch(/could not save the theme.*newer Kanopa/);
  });

  it("starts as System when the saved choice can't be read", async () => {
    osTheme(true);
    const backend = createFakeBackend();
    backend.theme = () => Promise.reject(new Error("unreadable"));
    await useTheme.getState().start(backend);
    expect(page().theme).toBe("dark");
    expect(page().themeChoice).toBe("system");
  });
});

describe("ThemeMenu", () => {
  it("lists the three themes, ticks the current one and switches", async () => {
    osTheme(false);
    const backend = createFakeBackend();
    await useTheme.getState().start(backend);
    const { user } = renderWith(<ThemeMenu />, backend);
    await user.click(screen.getByRole("button", { name: "Theme" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["System", "Clearing", "Night forest"]);
    expect(items[0]?.querySelector("svg")).not.toBeNull();
    expect(items[2]?.querySelector("svg")).toBeNull();

    await user.click(items[2]!);
    expect(page().theme).toBe("dark");
    expect(FAKE.theme.choice).toBe("dark");
    // The button shows the moon now.
    await user.click(screen.getByRole("button", { name: "Theme" }));
    expect((await screen.findAllByRole("menuitem"))[2]?.querySelector("svg")).not.toBeNull();
  });
});
