import { Clipboard, Events } from "@wailsio/runtime";
import { AppService, ChangeService, ConnectionService, DirectoryService } from "../../bindings/github.com/S0obi/kanopa/services";
import type { Backend } from "./backend";

type Cancellable<T> = Promise<T> & { cancel(): void };

// Wails calls return cancellable promises; an aborted signal cancels the Go context.
function withSignal<T>(p: Cancellable<T>, signal?: AbortSignal): Promise<T> {
  signal?.addEventListener("abort", () => p.cancel(), { once: true });
  return p;
}

export const wailsBackend: Backend = {
  testConnection: (p, signal) => withSignal(ConnectionService.Test(p), signal),
  fetchBaseDn: (p, signal) => withSignal(ConnectionService.FetchBaseDN(p), signal),
  listConnections: () => ConnectionService.List(),
  saveConnection: (r) => ConnectionService.Save(r),
  duplicateConnection: (id) => ConnectionService.Duplicate(id),
  deleteConnection: (id) => ConnectionService.Delete(id),
  allowUnencrypted: (id) => ConnectionService.AllowUnencrypted(id),
  connect: (id, password, save, signal) => withSignal(ConnectionService.Connect(id, password, save), signal),
  disconnect: (id) => ConnectionService.Disconnect(id),
  roots: (id) => DirectoryService.Roots(id),
  children: (id, dn, more) => DirectoryService.Children(id, dn, more),
  entry: (id, dn) => DirectoryService.Entry(id, dn),
  memberOf: (id, dn) => DirectoryService.MemberOf(id, dn),
  ping: (id) => DirectoryService.Ping(id),
  copyText: async (text) => {
    await Clipboard.SetText(text);
  },
  preview: (id, changes) => ChangeService.Preview(id, changes),
  apply: (id, changes) => ChangeService.Apply(id, changes),
  setPendingChanges: (n) => AppService.SetPendingChanges(n),
  onCloseRequested: (f) => Events.On("kanopa:close-requested", () => f()),
  closeAnyway: () => AppService.CloseAnyway(),
};
