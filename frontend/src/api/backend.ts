import { createContext, useContext } from "react";
import type {
  AllowedAttribute,
  ApplyResult,
  ClassInfo,
  ClassesResult,
  CountResult,
  ConnectionParams,
  ConnectResult,
  EntryAttribute,
  EntryChange,
  EntryView,
  Failure,
  FilterCheck,
  FindResult,
  ListResult,
  PreviewResult,
  QuickHit,
  QuickResult,
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
  AllowedAttribute, ApplyResult, ClassInfo, ClassesResult, ConnectionParams, CountResult, ConnectResult, EntryAttribute, EntryChange, EntryView, Failure, FilterCheck, FindResult, ListResult, PreviewResult,
  QuickHit, QuickResult, RelatedEntry, RelatedResult, SavedConnection,
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
  /** Picker search under the base DN: kind "people" or "groups", q of 2 characters or more. */
  find(id: string, kind: "people" | "groups", q: string): Promise<FindResult>;
  /** How many entries lie directly below dn, reading none of them. */
  countChildren(id: string, dn: string): Promise<CountResult>;
  /** Structural and auxiliary object classes of the server's schema, for the New entry form. */
  objectClasses(id: string): Promise<ClassesResult>;
  /** Groups whose member or uniqueMember lists dn, with the attribute that lists it. */
  referrers(id: string, dn: string): Promise<RelatedResult>;
  /** null while the connection answers. */
  ping(id: string): Promise<Failure | null>;
  /**
   * The header search: words match names and mail (best first), an LDAP filter is sent as is.
   * Reads up to 200 matches from the base DN and returns the best 10. Aborting the signal stops it.
   */
  quick(id: string, text: string, signal?: AbortSignal): Promise<QuickResult>;
  copyText(text: string): Promise<void>;

  /** The pending changes as LDIF; nothing is sent. */
  preview(id: string, changes: EntryChange[]): Promise<PreviewResult>;
  /** Sends the changes entry by entry, stopping at the first failure. */
  apply(id: string, changes: EntryChange[]): Promise<ApplyResult>;

  /** Tells the window how many entries have unapplied changes, so closing it asks first. */
  setPendingChanges(n: number): Promise<void>;
  /** Called when the person closes the window while changes are pending. Returns the unsubscribe. */
  onCloseRequested(f: () => void): () => void;
  /** Closes the window, dropping the pending changes. */
  closeAnyway(): Promise<void>;

  /** The saved theme choice. */
  theme(): Promise<ThemeChoice>;
  /** Saves the theme choice; rejects when it can't be kept between runs. */
  setTheme(choice: ThemeChoice): Promise<void>;
  /** Tells the window which theme the page now shows, so its frame (title bar, background) matches. */
  setAppearance(resolved: ThemeName): Promise<void>;
}

/** Clearing (light), Night forest (dark), or whichever the operating system uses. */
export type ThemeChoice = "system" | "light" | "dark";
export type ThemeName = "light" | "dark";

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
