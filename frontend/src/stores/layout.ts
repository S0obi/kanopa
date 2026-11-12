import { create } from "zustand";
import type { Backend, Layout } from "@/api/backend";

/** The entry view's tabs; anything else in a saved layout is ignored. */
const TABS = ["attributes", "ldif", "members", "memberOf"];

interface LayoutState {
  /** The tree pane's width; 0 until the person has resized it. */
  sidebarWidth: number;
  /** The entry view's last tab; empty until the person has picked one. */
  tab: string;
  /** Reads what was remembered, before the first render. */
  load(b: Backend): Promise<void>;
  /** Keeps a change and saves it a moment later, so dragging the divider is one write. */
  remember(p: Partial<Layout>): void;
}

let backend: Backend | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarWidth: 0,
  tab: "",
  async load(b) {
    backend = b;
    try {
      const l = await b.layout();
      set({ sidebarWidth: l.sidebarWidth > 0 ? l.sidebarWidth : 0, tab: TABS.includes(l.tab) ? l.tab : "" });
    } catch {
      // Unreadable settings: the defaults, as if nothing was saved.
    }
  },
  remember(p) {
    set(p);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { sidebarWidth, tab } = get();
      void backend?.setLayout({ sidebarWidth, tab }).catch(() => {});
    }, 400);
  },
}));
