import { create } from "zustand";
import { errorText, type Backend, type Failure, type SearchResult } from "@/api/backend";
import { useBrowser } from "@/features/browser/store";
import { parseAttributes } from "./complete";

export type Scope = "base" | "one" | "sub";
export const SCOPES: { value: Scope; label: string }[] = [
  { value: "base", label: "This entry" },
  { value: "one", label: "One level" },
  { value: "sub", label: "Subtree" },
];

/** Rows revealed at a time; a search reads up to 500. */
export const STEP = 100;

export type SearchStatus = "idle" | "running" | "done" | "failed";

interface SearchState {
  /** The search panel is in the right-hand pane. */
  open: boolean;
  base: string;
  scope: Scope;
  filter: string;
  /** Extra columns, as typed. */
  attrs: string;
  status: SearchStatus;
  result: SearchResult | null;
  failure: Failure | null;
  /** How many rows of the result are shown. */
  shown: number;
  /** The result entry last opened in the entry view, for "Back to results". */
  openedDn: string | null;
  running: AbortController | null;

  /** Opens the panel; base, when given, is where the search starts (the selected entry). */
  show(base?: string): void;
  hide(): void;
  setField(p: Partial<Pick<SearchState, "base" | "scope" | "filter" | "attrs">>): void;
  /** Fills the form from a recent search. */
  load(r: { base: string; scope: string; filter: string; attrs: string[] | null }): void;
  /** Runs the search; true when it finished with results to show (even none). */
  run(b: Backend, connectionId: string): Promise<boolean>;
  stop(): void;
  more(): void;
  opened(dn: string | null): void;
  /** A new connection: nothing carries over. */
  reset(): void;
}

const blank = { open: false, base: "", scope: "sub" as Scope, filter: "", attrs: "", status: "idle" as SearchStatus, result: null, failure: null, shown: 0, openedDn: null, running: null };

export const useSearch = create<SearchState>((set, get) => ({
  ...blank,

  show: (base) => set((s) => ({ open: true, base: base ?? s.base })),
  hide: () => set({ open: false }),
  setField: (p) => set(p),
  load: (r) => set({ base: r.base, scope: (["base", "one", "sub"] as const).find((x) => x === r.scope) ?? "sub", filter: r.filter, attrs: (r.attrs ?? []).join(", ") }),

  async run(b, connectionId) {
    get().running?.abort();
    const ctl = new AbortController();
    set({ status: "running", failure: null, running: ctl });
    const { base, scope, filter, attrs } = get();
    try {
      const r = await b.search(connectionId, { base: base.trim(), scope, filter, attributes: parseAttributes(attrs) }, ctl.signal);
      if (get().running !== ctl) return false; // stopped or replaced meanwhile
      if (r.failure) {
        set({ status: "failed", failure: r.failure, running: null });
        // A lost connection switches the whole screen to Reconnect; the old results stay readable.
        if (r.failure.lost) useBrowser.getState().failed(r.failure);
        return false;
      }
      set({ status: "done", result: r, shown: Math.min(STEP, (r.rows ?? []).length), failure: null, running: null });
      return true;
    } catch (e) {
      if (get().running !== ctl) return false;
      if (ctl.signal.aborted) set({ status: "idle", running: null });
      else set({ status: "failed", failure: { title: "Search failed.", message: errorText(e), code: 0, lost: false }, running: null });
      return false;
    }
  },

  stop() {
    const ctl = get().running;
    if (!ctl) return;
    set({ status: "idle", running: null });
    ctl.abort();
  },

  more: () => set((s) => ({ shown: Math.min(s.shown + STEP, s.result?.rows?.length ?? 0) })),
  opened: (dn) => set({ openedDn: dn }),
  reset: () => {
    get().running?.abort();
    set({ ...blank });
  },
}));
