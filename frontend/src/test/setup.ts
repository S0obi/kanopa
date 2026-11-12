import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { useLayout } from "@/stores/layout";

// What the interface remembers (tab, pane width) must not leak from one test into the next.
afterEach(() => {
  cleanup();
  useLayout.setState({ sidebarWidth: 0, tab: "" });
});

// jsdom has no layout: give the tree's ResizeObserver a no-op stand-in.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
