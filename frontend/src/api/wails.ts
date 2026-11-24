import { Clipboard, Dialogs, Events } from "@wailsio/runtime";
import { AppService, ChangeService, ConnectionService, DirectoryService, SettingsService, UpdateService } from "../../bindings/github.com/S0obi/kanopa/services";
import type { Backend, ThemeChoice } from "./backend";

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
  find: (id, kind, q) => DirectoryService.Find(id, kind, q),
  referrers: (id, dn) => DirectoryService.Referrers(id, dn),
  resolveUids: (id, uids) => DirectoryService.ResolveUIDs(id, uids),
  gidCheck: (id, gid) => DirectoryService.GIDCheck(id, gid),
  posixInfo: (id, uid) => DirectoryService.POSIXInfo(id, uid),
  passwordPolicy: (id, dn) => DirectoryService.PasswordPolicy(id, dn),
  accountStatus: (id, dn) => DirectoryService.AccountStatus(id, dn),
  objectClasses: (id) => DirectoryService.ObjectClasses(id),
  countChildren: (id, dn) => DirectoryService.CountChildren(id, dn),
  ping: (id) => DirectoryService.Ping(id),
  quick: (id, text, signal) => withSignal(DirectoryService.Quick(id, text), signal),
  copyText: async (text) => {
    await Clipboard.SetText(text);
  },
  copySecret: (text, seconds) => AppService.CopySecret(text, seconds),
  chooseExportFile: async (suggestedName) => {
    // Wails answers "" when the person cancels (some versions reject instead).
    try {
      return (await Dialogs.SaveFile({ Title: "Export LDIF", Filename: suggestedName, CanCreateDirectories: true, Filters: [{ DisplayName: "LDIF files (*.ldif)", Pattern: "*.ldif" }] })) ?? "";
    } catch {
      return "";
    }
  },
  startExport: (id, dn, path, options) => DirectoryService.StartExport(id, dn, path, options),
  exportProgress: (job) => DirectoryService.ExportProgress(job),
  cancelExport: (job) => DirectoryService.CancelExport(job),
  showInFolder: (path) => AppService.ShowInFolder(path),
  preview: (id, changes) => ChangeService.Preview(id, changes),
  apply: (id, changes) => ChangeService.Apply(id, changes),
  setPendingChanges: (n) => AppService.SetPendingChanges(n),
  onCloseRequested: (f) => Events.On("kanopa:close-requested", () => f()),
  closeAnyway: () => AppService.CloseAnyway(),
  about: () => AppService.About(),
  diagnostics: () => AppService.Diagnostics(),
  openLogFolder: () => AppService.OpenLogFolder(),
  openRepo: () => AppService.OpenRepo(),
  logClientError: (message, stack) => AppService.LogClientError(message, stack),
  updateStatus: () => UpdateService.UpdateStatus(),
  setAutoUpdate: (on) => UpdateService.SetAutoUpdate(on),
  checkForUpdates: () => UpdateService.CheckForUpdates(),
  restartToUpdate: () => UpdateService.RestartToUpdate(),
  openReleasesPage: () => UpdateService.OpenReleasesPage(),
  layout: () => SettingsService.Layout(),
  setLayout: (layout) => SettingsService.SetLayout(layout),
  theme: async () => (await SettingsService.Theme()) as ThemeChoice,
  setTheme: (choice) => SettingsService.SetTheme(choice),
  setAppearance: (resolved) => SettingsService.SetAppearance(resolved),
};
