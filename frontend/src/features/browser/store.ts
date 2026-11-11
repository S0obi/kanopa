import { create } from "zustand";
import type { Backend, Failure, SessionInfo, TreeNode } from "@/api/backend";
import { lineage, splitDn } from "@/lib/dn";

/** DNs as keys: case-insensitive, no spaces after commas. */
export const dnKey = (dn: string) => splitDn(dn).join(",").toLowerCase();

export interface NodeState {
  node: TreeNode;
  children?: string[]; // keys of the children read so far
  more?: string; // token for the next page
  total?: number; // children on the server, when known
  truncated?: boolean;
  loading?: boolean;
  error?: string;
}

export type ConnectionState = "connected" | "lost" | "reconnecting";

interface BrowserState {
  session: SessionInfo | null;
  nodes: Record<string, NodeState>;
  roots: string[];
  expanded: Record<string, true>;
  selected: string | null; // the DN as the server wrote it
  connection: ConnectionState;
  lost: Failure | null;
  lastReadMs: number | null;
  /** The entry view's tab: attributes, ldif, members or memberOf. */
  tab: string;
  setTab(tab: string): void;

  start(b: Backend, session: SessionInfo): Promise<void>;
  select(dn: string | null): void;
  toggle(b: Backend, dn: string): Promise<void>;
  expand(b: Backend, dn: string): Promise<void>;
  collapse(dn: string): void;
  collapseAll(): void;
  loadMore(b: Backend, dn: string): Promise<void>;
  reveal(b: Backend, dn: string): Promise<void>;
  /** Replaces nodes the server sent again (after Apply), keeping what is known of their children. */
  patchNodes(list: TreeNode[]): void;
  /** Reads the children of dn again from the first page, if the tree has read them. */
  refresh(b: Backend, dn: string): Promise<void>;
  /** Forgets entries that no longer exist under these DNs (deleted, or renamed away). */
  forget(dns: string[]): void;
  /** Reads the roots and every expanded entry again (Refresh, and after Reconnect). */
  reload(b: Backend): Promise<void>;
  /** Any read that failed: a lost connection switches the whole screen to "lost". */
  failed(f: Failure): void;
  setConnection(state: ConnectionState, session?: SessionInfo): void;
}

export const useBrowser = create<BrowserState>((set, get) => {
  const putNodes = (list: TreeNode[]) => {
    const nodes = { ...get().nodes };
    for (const n of list) {
      const k = dnKey(n.dn);
      nodes[k] = { ...nodes[k], node: n };
    }
    return nodes;
  };
  const patch = (k: string, p: Partial<NodeState>) => set((s) => ({ nodes: { ...s.nodes, [k]: { ...s.nodes[k], ...p } } }));

  async function readPage(b: Backend, dn: string, more: string) {
    const s = get();
    if (!s.session) return;
    const k = dnKey(dn);
    patch(k, { loading: true, error: undefined });
    const r = await b.children(s.session.connectionId, dn, more);
    if (r.failure) {
      patch(k, { loading: false, error: r.failure.message });
      get().failed(r.failure);
      return;
    }
    const nodes = putNodes((r.nodes ?? []));
    const before = more ? (nodes[k]?.children ?? []) : [];
    nodes[k] = {
      ...nodes[k],
      children: [...before, ...(r.nodes ?? []).map((n) => dnKey(n.dn))],
      more: r.more,
      total: r.total >= 0 ? r.total : nodes[k]?.total,
      truncated: r.truncated,
      loading: false,
    };
    // A parent whose children are known may have none after all.
    nodes[k].node = { ...nodes[k].node, hasChildren: nodes[k].children!.length > 0 || !!r.more };
    set({ nodes, lastReadMs: r.elapsedMs });
  }

  return {
    session: null,
    nodes: {},
    roots: [],
    expanded: {},
    selected: null,
    tab: "attributes",
    setTab: (tab) => set({ tab }),
    connection: "connected",
    lost: null,
    lastReadMs: null,

    async start(b, session) {
      set({ session, nodes: {}, roots: [], expanded: {}, selected: null, connection: "connected", lost: null, lastReadMs: null, tab: "attributes" });
      const r = await b.roots(session.connectionId);
      if (r.failure) return get().failed(r.failure);
      set({ nodes: putNodes((r.nodes ?? [])), roots: (r.nodes ?? []).map((n) => dnKey(n.dn)) });
      // Open the base DN, as the design shows it.
      const first = (r.nodes ?? []).find((n) => n.hasChildren);
      if (first) {
        set({ selected: first.dn });
        await get().expand(b, first.dn);
      }
    },

    select(dn) {
      set({ selected: dn });
    },

    async toggle(b, dn) {
      if (get().expanded[dnKey(dn)]) get().collapse(dn);
      else await get().expand(b, dn);
    },

    async expand(b, dn) {
      const k = dnKey(dn);
      set((s) => ({ expanded: { ...s.expanded, [k]: true } }));
      const n = get().nodes[k];
      if (!n?.children && !n?.loading) await readPage(b, dn, "");
    },

    collapse(dn) {
      const k = dnKey(dn);
      set((s) => {
        const expanded = { ...s.expanded };
        delete expanded[k];
        return { expanded };
      });
    },

    collapseAll() {
      set({ expanded: {} });
    },

    async loadMore(b, dn) {
      const n = get().nodes[dnKey(dn)];
      if (n?.more && !n.loading) await readPage(b, dn, n.more);
    },

    async reveal(b, dn) {
      // Open every ancestor that is in the tree; the entry itself may be beyond a "Show more".
      for (const anc of lineage(dn).slice(0, -1)) {
        if (!get().nodes[dnKey(anc)]) continue;
        // oxlint-disable-next-line no-await-in-loop -- parents first: a child is only in the tree once its parent is read
        await get().expand(b, anc);
      }
    },

    patchNodes(list) {
      if (list.length) set({ nodes: putNodes(list) });
    },
    forget(dns) {
      if (!dns.length) return;
      set((s) => {
        const gone = new Set(dns.map(dnKey));
        const nodes: Record<string, NodeState> = {};
        for (const [k, n] of Object.entries(s.nodes)) {
          if (gone.has(k)) continue;
          nodes[k] = n.children?.some((c) => gone.has(c)) ? { ...n, children: n.children.filter((c) => !gone.has(c)) } : n;
        }
        const expanded = { ...s.expanded };
        for (const k of gone) delete expanded[k];
        return { nodes, expanded };
      });
    },
    async refresh(b, dn) {
      const k = dnKey(dn);
      const n = get().nodes[k];
      if (!n) return;
      if (!n.children) {
        // Never read, or read empty: it may have children now.
        patch(k, { node: { ...n.node, hasChildren: true } });
        if (!get().expanded[k]) return;
      }
      patch(k, { children: undefined, more: undefined });
      await readPage(b, dn, "");
    },
    async reload(b) {
      const s = get();
      if (!s.session) return;
      const open = Object.keys(s.expanded);
      const r = await b.roots(s.session.connectionId);
      if (r.failure) return get().failed(r.failure);
      set({ nodes: putNodes((r.nodes ?? [])), roots: (r.nodes ?? []).map((n) => dnKey(n.dn)) });
      // Children are read again from the first page; parents before children.
      const byDepth = open.map((k) => get().nodes[k]?.node.dn ?? k).sort((a, c) => splitDn(a).length - splitDn(c).length);
      for (const dn of byDepth) {
        if (get().connection !== "connected") return;
        const k = dnKey(dn);
        if (!get().nodes[k]) continue;
        patch(k, { children: undefined, more: undefined });
        // oxlint-disable-next-line no-await-in-loop -- parents first, one paged search at a time on the connection
        await readPage(b, dn, "");
      }
    },

    failed(f) {
      if (f.lost) set({ connection: "lost", lost: f });
    },

    setConnection(connection, session) {
      set(session ? { connection, session, lost: connection === "connected" ? null : get().lost } : { connection });
    },
  };
});

/** One visible line of the tree. */
export type TreeRow =
  | { kind: "node"; key: string; state: NodeState; depth: number; open: boolean; parent: string | null }
  | { kind: "more"; key: string; parent: string; depth: number; remaining: number | null; loading: boolean }
  | { kind: "loading"; key: string; depth: number }
  | { kind: "error"; key: string; depth: number; message: string };

/**
 * The rows the tree shows, in order: expanded nodes, their children, "Show N more" and loading
 * lines. added are pending new entries, by their parent's key: they follow the parent's children.
 */
export function visibleRows(nodes: Record<string, NodeState>, roots: string[], expanded: Record<string, true>, added: Record<string, TreeNode[]> = {}): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (keys: string[], depth: number, parent: string | null) => {
    for (const k of keys) {
      const state = nodes[k] ?? pendingState(k);
      if (!state) continue;
      const extra = (added[k] ?? []).filter((n) => !nodes[k]?.children?.includes(dnKey(n.dn)));
      const open = !!expanded[k] && (state.node.hasChildren || extra.length > 0);
      rows.push({ kind: "node", key: k, state, depth, open, parent });
      if (!open) continue;
      if (state.children) walk(state.children, depth + 1, k);
      if (extra.length) walk(extra.map((n) => dnKey(n.dn)), depth + 1, k);
      if (state.error) rows.push({ kind: "error", key: `${k}#error`, depth: depth + 1, message: state.error });
      else if (state.loading && !state.children) rows.push({ kind: "loading", key: `${k}#loading`, depth: depth + 1 });
      else if (state.more) {
        const remaining = state.total !== undefined && state.children ? state.total - state.children.length : null;
        rows.push({ kind: "more", key: `${k}#more`, parent: k, depth: depth + 1, remaining, loading: !!state.loading });
      }
    }
  };
  const pending: Record<string, NodeState> = {};
  for (const list of Object.values(added)) for (const n of list) pending[dnKey(n.dn)] = { node: n, children: [] };
  const pendingState = (k: string) => pending[k];
  walk(roots, 0, null);
  return rows;
}
