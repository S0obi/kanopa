import type { Backend, ConnectionParams, ConnectResult, SavedConnection, SaveRequest, TestResult } from "./backend";

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

export function fakeOutcome(p: ConnectionParams): TestResult {
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
      bindDn: "cn=admin,dc=example,dc=org", savePassword: true, hasPassword: true, password: "kanopa-admin", verifyCert: false, lastUsed: hoursAgo(1) },
    { ...base, id: "staging", name: "Staging", url: "ldap://slow.example.org:389", security: "starttls", baseDn: "dc=staging,dc=example,dc=org", bind: "simple",
      bindDn: "uid=svc-kanopa,ou=services,dc=example,dc=org", savePassword: true, hasPassword: true, password: "kanopa-reader", verifyCert: true, lastUsed: hoursAgo(30),
      lastError: "Nothing came back from slow.example.org:389 within 10 seconds. Check your VPN or network, then try again. Timeout (-5)" },
    { ...base, id: "ad", name: "Corporate Active Directory", url: "ldaps://dc01.corp.example.com:636", security: "ldaps", baseDn: "DC=corp,DC=example,DC=com", bind: "simple",
      bindDn: "CN=Kanopa Reader,OU=Service Accounts,DC=corp,DC=example,DC=com", savePassword: true, hasPassword: true, password: "an-old-password", verifyCert: false, lastUsed: hoursAgo(24 * 9) },
    { ...base, id: "local", name: "Local OpenLDAP", url: "ldap://localhost:389", security: "none", baseDn: "dc=example,dc=org", bind: "anonymous",
      bindDn: "", savePassword: false, hasPassword: false, verifyCert: false, lastUsed: hoursAgo(24 * 9 + 3) },
  ];
}

export interface FakeOptions {
  connections?: Array<SavedConnection & { password?: string }>;
  notice?: string;
}

let seq = 0;

/** A fresh fake backend with its own connections and credential store. */
export function createFakeBackend(opts: FakeOptions = {}): Backend & { passwords: Map<string, string> } {
  const conns: SavedConnection[] = [];
  const passwords = new Map<string, string>();
  for (const { password, ...c } of opts.connections ?? []) {
    conns.push({ ...c });
    if (password && c.savePassword) passwords.set(c.id, password);
  }
  let notice = opts.notice ?? "";
  const find = (id: string) => {
    const c = conns.find((x) => x.id === id);
    if (!c) throw new Error("This connection no longer exists. It may have been deleted in another window.");
    return c;
  };
  const view = (c: SavedConnection): SavedConnection => ({ ...c, hasPassword: c.bind === "simple" && c.savePassword && passwords.has(c.id) });

  return {
    passwords,
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
        bind: r.bind, bindDn: r.bind === "simple" ? r.bindDn : "", savePassword: r.bind === "simple" && r.savePassword, hasPassword: false,
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
      const u = canonical(c.url)!;
      return {
        ok: true, title: "Connected.", code: 0, reason: "", message: `Bound to ${u.host}:${u.port} in 42 ms over ${secLabel(c.url, c.security)}.`,
        session: {
          connectionId: id, name: c.name, url: u.url, security: secLabel(c.url, c.security), boundAs: c.bind === "simple" ? c.bindDn : "",
          baseDn: c.baseDn || FAKE.baseDn, vendor: "", namingContexts: [FAKE.baseDn], ldapVersions: ["3"], controls: 14, extensions: 5, elapsedMs: 42, readOnly: c.readOnly,
        },
      };
    },
    async disconnect() {},
  };
}

/** The backend `vite --mode fake` runs against. */
export const fakeBackend = createFakeBackend({
  connections: typeof location !== "undefined" && new URLSearchParams(location.search).has("empty") ? [] : sampleConnections(),
});
