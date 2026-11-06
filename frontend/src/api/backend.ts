import { createContext, useContext } from "react";
import type {
  ConnectionParams,
  ConnectResult,
  EntryAttribute,
  EntryView,
  Failure,
  ListResult,
  RelatedEntry,
  RelatedResult,
  SavedConnection,
  SaveRequest,
  SessionInfo,
  TestResult,
  TreeNode,
  TreeResult,
} from "../../bindings/github.com/S0obi/kanopa/services/models";

export type {
  ConnectionParams, ConnectResult, EntryAttribute, EntryView, Failure, ListResult, RelatedEntry, RelatedResult, SavedConnection,
  SaveRequest, SessionInfo, TestResult, TreeNode, TreeResult,
};

/** Why a connection attempt stopped (services.Reason*). */
export type ConnectReason = "" | "needsPassword" | "badPassword" | "needsConsent" | "unreachable" | "other";

/**
 * Everything the UI asks of the Go side. The app uses the Wails bindings;
 * Vitest and Playwright use the fake backend (src/api/fake.ts).
 * Methods that return a Promise<void> or a value reject with an Error whose message is ready to show.
 */
export interface Backend {
  testConnection(p: ConnectionParams, signal?: AbortSignal): Promise<TestResult>;
  fetchBaseDn(p: ConnectionParams, signal?: AbortSignal): Promise<TestResult>;

  listConnections(): Promise<ListResult>;
  saveConnection(r: SaveRequest): Promise<SavedConnection>;
  duplicateConnection(id: string): Promise<SavedConnection>;
  deleteConnection(id: string): Promise<void>;
  allowUnencrypted(id: string): Promise<void>;
  connect(id: string, password: string, savePassword: boolean, signal?: AbortSignal): Promise<ConnectResult>;
  disconnect(id: string): Promise<void>;

  /** The top of the tree: naming contexts and the schema entry. */
  roots(id: string): Promise<TreeResult>;
  /** One page of the children of dn; more is the previous page's token, "" for the first. */
  children(id: string, dn: string, more: string): Promise<TreeResult>;
  entry(id: string, dn: string): Promise<EntryView>;
  memberOf(id: string, dn: string): Promise<RelatedResult>;
  /** null while the connection answers. */
  ping(id: string): Promise<Failure | null>;
  copyText(text: string): Promise<void>;
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("useBackend needs a BackendContext provider");
  return b;
}

/** The text to show for a rejected backend call. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
