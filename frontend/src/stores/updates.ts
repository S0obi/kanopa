import { create } from "zustand";
import type { Backend, UpdateStatus } from "@/api/backend";

interface UpdatesState {
  status: UpdateStatus | null;
  /** The person asked for a check by hand, so "checking", "up to date" and a failed check are said out loud. */
  byHand: boolean;
  /** What the person closed (state and version), so the same notice doesn't come back. */
  dismissed: string;
  refresh(b: Backend): Promise<void>;
  set(s: UpdateStatus): void;
  askByHand(b: Backend): Promise<void>;
  dismiss(): void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  byHand: false,
  dismissed: "",
  async refresh(b) {
    try {
      set({ status: await b.updateStatus() });
    } catch {
      // Updating is never worth an error of its own: the next poll tries again.
    }
  },
  set: (status) => set({ status }),
  async askByHand(b) {
    set({ byHand: true, dismissed: "" });
    try {
      set({ status: await b.checkForUpdates() });
    } catch {
      /* the poll shows what happened */
    }
  },
  dismiss() {
    const s = get().status;
    if (s) set({ dismissed: `${s.state}:${s.version}` });
  },
}));

/** Resets the store between tests. */
export function resetUpdates() {
  useUpdates.setState({ status: null, byHand: false, dismissed: "" });
}
