import type { Backend, ConnectionParams, TestResult } from "./backend";

/**
 * A stand-in for the Go services, for Vitest, Playwright and UI work in a plain browser
 * (`vite --mode fake`). It answers like the OpenLDAP fixture in test/ldap:
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

export function fakeOutcome(p: ConnectionParams): TestResult {
  const m = URL_RE.exec(p.url.trim());
  if (!m) return { ...fail(0, "", "Check the connection settings.", ""), message: "Enter an LDAP URL such as ldaps://ldap.example.org:636." };
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const port = m[3] ? Number(m[3]) : scheme === "ldaps" ? 636 : 389;
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

function successText(p: ConnectionParams, r: TestResult): string {
  const who = p.bind === "anonymous" ? "Connected anonymously" : `Bound as ${p.bindDn.trim()}`;
  const sec = /^ldaps:/i.test(p.url.trim()) ? "LDAPS" : p.security === "starttls" ? "StartTLS" : "an unencrypted link";
  return `${who} in ${r.elapsedMs} ms over ${sec}. The server offers 1 naming context: ${FAKE.baseDn}.`;
}

export const fakeBackend: Backend = {
  async testConnection(p, signal) {
    await wait(FAKE.delayMs, signal);
    const r = fakeOutcome(p);
    return r.ok ? { ...r, message: successText(p, r) } : r;
  },
  async fetchBaseDn(p, signal) {
    await wait(FAKE.delayMs, signal);
    const r = fakeOutcome(p);
    return r.ok ? { ...r, message: r.baseDn } : r;
  },
};
