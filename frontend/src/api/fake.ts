import type { Backend, ConnectionParams, ConnectResult, Failure, SavedConnection, SaveRequest, TestResult, ThemeChoice, ThemeName } from "./backend";
import { BASE, SUBSCHEMA, fakeApply, fakeChildren, fakeClasses, fakeEntry, fakeFind, fakeGidCheck, fakeMemberOf, fakePosixInfo, fakeNode, fakePreview, fakeReferrers, fakeResolveUids } from "./fakeDirectory";
import { fakeQuick } from "./fakeQuick";

/**
 * A stand-in for the Go services, for Vitest, Playwright and UI work in a plain browser
 * (`vite --mode fake`, add `?empty` to start with no connections). It answers like the
 * OpenLDAP fixture in test/ldap:
 *
 * - admin: cn=admin,dc=example,dc=org / kanopa-admin; reader: uid=svc-kanopa,… / kanopa-reader
 * - localhost and ldap.example.org answer; down.example.org refuses; slow.example.org times out;
 *   nowhere.example.org does not resolve
 * - the certificate is self-signed, so verification fails unless it is turned off
 */
export const FAKE = {
  baseDn: "dc=example,dc=org",
  accounts: {
    "cn=admin,dc=example,dc=org": "kanopa-admin",
    "uid=svc-kanopa,ou=services,dc=example,dc=org": "kanopa-reader",
  } as Record<string, string>,
  delayMs: 250,
  /** Simulates a server that stopped answering. */
  lost: false,
  /** Makes the referring-groups search fail, as a server over its limits would. */
  failReferrers: false,
  /** Set by the fake backend: pretends the person closed the window. */
  requestClose: () => {},
  /** Entries with unapplied changes, as the app last reported them; closed once the window would close. */
  window: { pending: 0, closed: false },
  /** The theme the fake "settings file" holds, and what the window was last painted for. */
  theme: { choice: "system" as ThemeChoice, appearance: "light" as ThemeName },
  /** Makes saving the theme fail, as a read-only settings file would. */
  failThemeSave: false,
  /** False simulates a server without the paged results control. */
  paging: true,
  /** A server-side size limit on searches (0: none); a search with more matches stops there. */
  serverLimit: 0,
  /** What the fake "settings file" remembers of the layout. */
  layout: { sidebarWidth: 0, tab: "" },
  /** How many times the log folder and the home page were opened, and what the interface logged as errors. */
  opened: { logFolder: 0, repo: 0 },
  clientErrors: [] as Array<{ message: string; stack: string }>,
};

const URL_RE = /^(ldaps?):\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i;

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function fail(code: number, name: string, title: string, detail: string): TestResult {
  return { ok: false, title, message: `${detail} ${name} (${code})`, code, elapsedMs: 0, namingContexts: null, baseDn: "", vendor: "" };
}

function canonical(url: string): { url: string; host: string; port: number; scheme: string } | null {
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] ? Number(m[3]) : scheme === "ldaps" ? 636 : 389;
  return { url: `${scheme}://${m[2]}:${port}`, host: m[2], port, scheme };
}

function fakeOutcome(p: ConnectionParams): TestResult {
  const u = canonical(p.url);
  if (!u) return { ...fail(0, "", "Check the connection settings.", ""), message: "Enter an LDAP URL such as ldaps://ldap.example.org:636." };
  const { host, port, scheme } = u;
  const hp = `${host}:${port}`;
  const secs = p.timeoutSeconds || 10;
  const local = host === "localhost" || host === "127.0.0.1";

  if (host === "nowhere.example.org")
    return fail(-1, "Can't contact LDAP server", "Host not found.", `Kanopa can't find the host ${host}. Check the host name, then try again.`);
  if (host === "down.example.org" || (local && port !== 389 && port !== 636))
    return fail(-1, "Can't contact LDAP server", "Server not running.",
      `Nothing answered on ${hp}. ${local ? "Start the LDAP server on this computer, then try again." : "Check that the server is running and that the host and port are right, then try again."}`);
  if (host === "slow.example.org")
    return fail(-5, "Timeout", "No answer.", `Nothing came back from ${hp} within ${secs} seconds. Check your VPN or network, then try again.`);
  if (p.verifyCert && (scheme === "ldaps" || p.security === "starttls"))
    return fail(-11, "Connect error", "Certificate not trusted.",
      `The certificate of ${host} is not trusted: it is signed by an unknown authority. Add its certificate authority to the system trust store, or turn off certificate verification for a test server.`);
  if (p.bind === "simple") {
    if (!p.password) return fail(49, "Invalid credentials", "Password missing.", `Enter the password for ${p.bindDn}, or choose Anonymous.`);
    if (FAKE.accounts[p.bindDn.trim()] !== p.password)
      return fail(49, "Invalid credentials", "Bind refused.", `The server refused the password for ${p.bindDn.trim()}. Enter the current password, then try again.`);
  }
  return { ok: true, title: "Connection works", message: "", code: 0, elapsedMs: 42, namingContexts: [FAKE.baseDn], baseDn: FAKE.baseDn, vendor: "OpenLDAP" };
}

function secLabel(url: string, security: string): string {
  return /^ldaps:/i.test(url.trim()) ? "LDAPS" : security === "starttls" ? "StartTLS" : "an unencrypted link";
}

function successText(p: ConnectionParams, r: TestResult): string {
  const who = p.bind === "anonymous" ? "Connected anonymously" : `Bound as ${p.bindDn.trim()}`;
  return `${who} in ${r.elapsedMs} ms over ${secLabel(p.url, p.security)}. The server offers 1 naming context: ${FAKE.baseDn}.`;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

/** The design's sample connections, pointed at hosts the fake knows. */
export function sampleConnections(): Array<SavedConnection & { password?: string }> {
  const base = { timeoutSeconds: 10, pageSize: 500, referrals: "show", readOnly: false, lastError: "", plainConsent: false };
  return [
    { ...base, id: "prod", name: "Production directory", url: "ldaps://localhost:636", security: "ldaps", baseDn: "dc=example,dc=org", bind: "simple",
      bindDn: "cn=admin,dc=example,dc=org", savePassword: true, hasPassword: true, password: "kanopa-admin", verifyCert: false, lastUsed: hoursAgo(0.005) },
    { ...base, id: "staging", name: "Staging", url: "ldap://slow.example.org:389", security: "starttls", baseDn: "dc=staging,dc=example,dc=org", bind: "simple",
      bindDn: "uid=svc-kanopa,ou=services,dc=example,dc=org", savePassword: true, hasPassword: true, password: "kanopa-reader", verifyCert: true, lastUsed: hoursAgo(30),
      lastError: "Nothing came back from slow.example.org:389 within 10 seconds. Check your VPN or network, then try again. Timeout (-5)" },
    { ...base, id: "ad", name: "Corporate Active Directory", url: "ldaps://dc01.corp.example.com:636", security: "ldaps", baseDn: "DC=corp,DC=example,DC=com", bind: "simple",
      bindDn: "CN=Kanopa Reader,OU=Service Accounts,DC=corp,DC=example,DC=com", savePassword: true, hasPassword: true, password: "an-old-password", verifyCert: false, lastUsed: hoursAgo(24 * 9) },
    { ...base, id: "local", name: "Local OpenLDAP", url: "ldap://localhost:389", security: "none", baseDn: "dc=example,dc=org", bind: "anonymous",
      bindDn: "", savePassword: false, hasPassword: false, verifyCert: false, lastUsed: hoursAgo(24 * 9 + 3) },
  ];
}

interface FakeOptions {
  connections?: Array<SavedConnection & { password?: string }>;
  notice?: string;
}

let seq = 0;

/** A fresh fake backend with its own connections and credential store. */
export function createFakeBackend(opts: FakeOptions = {}): Backend & { passwords: Map<string, string>; clipboard: { text: string } } {
  const conns: SavedConnection[] = [];
  const passwords = new Map<string, string>();
  for (const { password, ...c } of opts.connections ?? []) {
    conns.push({ ...c });
    if (password && c.savePassword) passwords.set(c.id, password);
  }
  let notice = opts.notice ?? "";
  const open = new Map<string, number>(); // open sessions and their page size
  const bound = new Map<string, SavedConnection>(); // the connection each session opened
  const closeListeners = new Set<() => void>();
  FAKE.requestClose = () => {
    if (FAKE.window.pending > 0) closeListeners.forEach((f) => f());
    else FAKE.window.closed = true;
  };
  const clipboard = { text: "" };
  // FAKE.lost simulates a server that stopped answering: the session is dropped.
  const check = (id: string): Failure | null => {
    if (FAKE.lost) open.delete(id);
    if (open.has(id)) return null;
    return FAKE.lost
      ? { title: "Connection to localhost lost.", message: "The server stopped answering. Reconnect to keep working. Server is unavailable (52)", code: 52, lost: true }
      : { title: "Not connected.", message: "This connection is closed. Reconnect to keep working.", code: 0, lost: true };
  };
  const find = (id: string) => {
    const c = conns.find((x) => x.id === id);
    if (!c) throw new Error("This connection no longer exists. It may have been deleted in another window.");
    return c;
  };
  // Like Go: savePassword is only true while a password is stored, so it is also hasPassword.
  const view = (c: SavedConnection): SavedConnection => ({ ...c, hasPassword: c.bind === "simple" && c.savePassword });

  return {
    passwords,
    clipboard,
    async testConnection(p, signal) {
      await wait(FAKE.delayMs, signal);
      if (!p.password && p.connectionId) p = { ...p, password: passwords.get(p.connectionId) ?? "" };
      const r = fakeOutcome(p);
      return r.ok ? { ...r, message: successText(p, r) } : r;
    },
    async fetchBaseDn(p, signal) {
      await wait(FAKE.delayMs, signal);
      if (!p.password && p.connectionId) p = { ...p, password: passwords.get(p.connectionId) ?? "" };
      const r = fakeOutcome(p);
      return r.ok ? { ...r, message: r.baseDn } : r;
    },
    async listConnections() {
      const n = notice;
      notice = "";
      return { connections: conns.map(view), notice: n };
    },
    async saveConnection(r: SaveRequest) {
      if (!r.name.trim()) throw new Error("Enter a name for this connection.");
      const u = canonical(r.url);
      if (!u) throw new Error("Enter an LDAP URL such as ldaps://ldap.example.org:636.");
      const old = r.id ? find(r.id) : undefined;
      const c: SavedConnection = {
        id: r.id || `c${++seq}`, name: r.name.trim(), url: u.url, security: u.scheme === "ldaps" ? "ldaps" : r.security, baseDn: r.baseDn,
        bind: r.bind, bindDn: r.bind === "simple" ? r.bindDn : "",
        savePassword: r.bind === "simple" && r.savePassword && (!!r.password || (!!old?.savePassword && passwords.has(old.id))), hasPassword: false,
        timeoutSeconds: r.timeoutSeconds, pageSize: r.pageSize, referrals: r.referrals === "ignore" ? "ignore" : "show", readOnly: r.readOnly,
        verifyCert: r.verifyCert, plainConsent: !!old?.plainConsent && old.url === u.url, lastUsed: old?.lastUsed ?? "", lastError: "",
      };
      if (!c.savePassword) passwords.delete(c.id);
      else if (r.password) passwords.set(c.id, r.password);
      if (old) conns[conns.indexOf(old)] = c;
      else conns.push(c);
      return view(c);
    },
    async duplicateConnection(id) {
      const c = find(id);
      const copy: SavedConnection = { ...c, id: `c${++seq}`, name: `${c.name} (copy)`, lastUsed: "", lastError: "" };
      if (passwords.has(id)) passwords.set(copy.id, passwords.get(id)!);
      conns.splice(conns.indexOf(c) + 1, 0, copy);
      return view(copy);
    },
    async deleteConnection(id) {
      const c = find(id);
      conns.splice(conns.indexOf(c), 1);
      passwords.delete(id);
    },
    async allowUnencrypted(id) {
      find(id).plainConsent = true;
    },
    async connect(id, password, savePassword, signal): Promise<ConnectResult> {
      const c = find(id);
      if (c.security === "none" && !c.plainConsent)
        return { ok: false, title: "Connect without encryption?", message: `${c.url} uses neither LDAPS nor StartTLS.`, code: 0, reason: "needsConsent", session: null };
      let pw = password;
      if (c.bind === "simple" && !pw) {
        const saved = passwords.get(id);
        if (!saved) return { ok: false, title: "Password needed.", message: `Enter the password for ${c.bindDn}.`, code: 0, reason: "needsPassword", session: null };
        pw = saved;
      }
      await wait(FAKE.delayMs * 2, signal);
      const r = fakeOutcome({ url: c.url, security: c.security, bind: c.bind, bindDn: c.bindDn, password: pw, timeoutSeconds: c.timeoutSeconds, verifyCert: c.verifyCert, connectionId: id });
      if (!r.ok) {
        c.lastError = r.message;
        const reason = r.code === 49 ? "badPassword" : r.code === -1 || r.code === -5 ? "unreachable" : "other";
        return { ok: false, title: r.title, message: r.message, code: r.code, reason, session: null };
      }
      if (password && savePassword) {
        passwords.set(id, password);
        c.savePassword = true;
      }
      c.lastUsed = new Date().toISOString();
      c.lastError = "";
      open.set(id, c.pageSize || 500);
      bound.set(id, { ...c });
      const u = canonical(c.url)!;
      return {
        ok: true, title: "Connected.", code: 0, reason: "", message: `Bound to ${u.host}:${u.port} in 42 ms over ${secLabel(c.url, c.security)}.`,
        session: {
          connectionId: id, name: c.name, url: u.url, security: secLabel(c.url, c.security), boundAs: c.bind === "simple" ? c.bindDn : "",
          baseDn: c.baseDn || FAKE.baseDn, vendor: "", namingContexts: [FAKE.baseDn], ldapVersions: ["3"], controls: 14, extensions: 5, elapsedMs: 42, readOnly: c.readOnly,
          subschemaDn: SUBSCHEMA, schemaRead: true, paging: FAKE.paging,
        },
      };
    },
    async disconnect(id) {
      open.delete(id);
    },
    async roots(id) {
      const lost = check(id);
      if (lost) return { nodes: [], more: "", total: -1, truncated: false, serverLimit: false, elapsedMs: 0, failure: lost };
      const roots = [{ ...fakeNode(BASE)!, rdn: BASE }, { ...fakeNode(SUBSCHEMA)!, rdn: SUBSCHEMA, sub: "Schema" }];
      return { nodes: roots, more: "", total: -1, truncated: false, serverLimit: false, elapsedMs: 3, failure: null };
    },
    async children(id, dn, more) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      if (lost) return { nodes: [], more: "", total: -1, truncated: false, serverLimit: false, elapsedMs: 0, failure: lost };
      let all = fakeChildren(dn) ?? [];
      // A server with a size limit lists no more than that, and doesn't say there is more.
      const serverLimit = FAKE.serverLimit > 0 && all.length > FAKE.serverLimit;
      if (serverLimit) all = all.slice(0, FAKE.serverLimit);
      const size = open.get(id) ?? 500;
      const from = more ? Number(more) : 0;
      const to = Math.min(from + size, all.length);
      return { nodes: all.slice(from, to), more: to < all.length ? String(to) : "", total: all.length, truncated: serverLimit, serverLimit, elapsedMs: 9, failure: null };
    },
    async entry(id, dn) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      const empty = { dn, title: "", subtitle: "", type: "entry", objectClasses: [], attributes: [], allowed: [], ldif: "", referral: false, elapsedMs: 0 };
      if (lost) return { ...empty, failure: lost };
      if (dn.toLowerCase().startsWith("cn=unreadable,"))
        return {
          ...empty,
          failure: {
            title: "Can't read this entry.",
            message:
              "The server shows this entry in its folder but refuses to open it. The usual causes are an access rule that allows listing and not reading, or a damaged index on the server. Ask whoever runs the directory, and give them the DN. Other entries are not affected. No such object (32)",
            code: 32,
            lost: false,
          },
        };
      return (
        fakeEntry(dn) ?? {
          ...empty,
          failure: { title: "Entry not found.", message: `The server has no entry at ${dn}. It may have been renamed or deleted. No such object (32)`, code: 32, lost: false },
        }
      );
    },
    async memberOf(id, dn) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      return lost ? { entries: [], truncated: false, failure: lost } : { entries: fakeMemberOf(dn), truncated: false, failure: null };
    },
    async ping(id) {
      return check(id);
    },
    async copyText(text) {
      clipboard.text = text;
    },
    async preview(id, changes) {
      const lost = check(id);
      if (lost) return { ldif: "", entries: 0, failure: lost };
      return { ldif: fakePreview(changes), entries: changes.length, failure: null };
    },
    async apply(id, changes) {
      await wait(FAKE.delayMs);
      const lost = check(id);
      if (lost) return { results: [], applied: 0, elapsedMs: 0, failure: lost };
      const c = bound.get(id)!;
      if (c.readOnly)
        return {
          results: [], applied: 0, elapsedMs: 0,
          failure: { title: "Read-only connection.", message: "This connection is set to read-only, so Kanopa sends no changes over it. Edit the connection to allow changes.", code: 0, lost: false },
        };
      const reader = c.bindDn.startsWith("uid=svc-kanopa");
      const results = fakeApply(changes, () =>
        reader
          ? { title: "Not allowed.", message: "Insufficient access (50) — the account you bound as may not change this entry. Connect as an account with write access.", code: 50, lost: false }
          : null,
      );
      return { results, applied: results.filter((r) => r.ok).length, elapsedMs: 31, failure: null };
    },
    async find(id, kind, q) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      return lost ? { entries: [], total: 0, more: false, filter: "", base: "", failure: lost } : fakeFind(kind, q);
    },
    async countChildren(id, dn) {
      const lost = check(id);
      return lost ? { count: 0, more: false, failure: lost } : { count: (fakeChildren(dn) ?? []).length, more: false, failure: null };
    },
    async objectClasses(id) {
      const lost = check(id);
      return lost ? { classes: [], failure: lost } : { classes: fakeClasses(), failure: null };
    },
    async referrers(id, dn) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      if (lost) return { entries: [], truncated: false, failure: lost };
      if (FAKE.failReferrers)
        return { entries: [], truncated: false, failure: { title: "Request refused.", message: "Administrative limit exceeded (11) — the server stopped the search.", code: 11, lost: false } };
      return { entries: fakeReferrers(dn), truncated: false, failure: null };
    },
    async resolveUids(id, uids) {
      await wait(FAKE.delayMs / 2);
      const lost = check(id);
      return lost ? { matches: [], failure: lost } : { matches: fakeResolveUids(uids), failure: null };
    },
    async gidCheck(id, gid) {
      const lost = check(id);
      return lost ? { next: 0, takenBy: [], failure: lost } : fakeGidCheck(gid);
    },
    async posixInfo(id, uid) {
      const lost = check(id);
      return lost ? { nextUid: 0, uidTakenBy: [], groups: [], failure: lost } : fakePosixInfo(uid);
    },
    async quick(id, text, signal) {
      await wait(FAKE.delayMs, signal);
      const lost = check(id);
      if (lost) return { ...fakeQuick("", FAKE.baseDn, { serverLimit: 0, paged: FAKE.paging }), failure: lost };
      return fakeQuick(text, FAKE.baseDn, { serverLimit: FAKE.serverLimit, paged: FAKE.paging });
    },
    async setPendingChanges(n) {
      FAKE.window.pending = n;
    },
    onCloseRequested(f) {
      closeListeners.add(f);
      return () => closeListeners.delete(f);
    },
    async closeAnyway() {
      FAKE.window.closed = true;
    },
    async about() {
      return { name: "Kanopa", version: "0.0.0-fake", commit: "abc1234", system: "windows amd64", webview: "WebView2 150.0", go: "go1.27", license: "MIT", repo: "https://github.com/S0obi/kanopa", logDir: "" };
    },
    async diagnostics() {
      return ["Kanopa 0.0.0-fake (abc1234)", "System: windows amd64", "Web engine: WebView2 150.0", "Go: go1.27", ""].join("\n");
    },
    async openLogFolder() {
      FAKE.opened.logFolder++;
    },
    async openRepo() {
      FAKE.opened.repo++;
    },
    async logClientError(message, stack) {
      FAKE.clientErrors.push({ message, stack });
    },
    async layout() {
      return { ...FAKE.layout };
    },
    async setLayout(layout) {
      FAKE.layout = { ...layout };
    },
    async theme() {
      return FAKE.theme.choice;
    },
    async setTheme(choice) {
      FAKE.theme.choice = choice;
      if (FAKE.failThemeSave) throw new Error("Your settings were saved by a newer Kanopa, so this one cannot change them. Update Kanopa to keep the theme between runs.");
    },
    async setAppearance(resolved) {
      FAKE.theme.appearance = resolved;
    },
  };
}

/** The backend `vite --mode fake` runs against. */
export const fakeBackend = createFakeBackend({
  connections: typeof location !== "undefined" && new URLSearchParams(location.search).has("empty") ? [] : sampleConnections(),
});
