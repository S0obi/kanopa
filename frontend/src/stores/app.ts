import { create } from "zustand";
import type { SessionInfo } from "@/api/backend";

/** Which screen the single Kanopa window shows. */
export type View = { name: "welcome" } | { name: "connected"; session: SessionInfo };

interface AppState {
  view: View;
  openSession: (session: SessionInfo) => void;
  closeSession: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: { name: "welcome" },
  openSession: (session) => set({ view: { name: "connected", session } }),
  closeSession: () => set({ view: { name: "welcome" } }),
}));
