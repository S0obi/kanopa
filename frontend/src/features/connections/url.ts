export type Security = "ldaps" | "starttls" | "none";

export interface LdapUrl {
  scheme: "ldap" | "ldaps";
  host: string;
  /** The port as typed, or undefined when the URL has none. */
  port?: number;
}

const URL_RE = /^(ldaps?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i;

export function parseLdapUrl(raw: string): LdapUrl | null {
  const m = URL_RE.exec(raw.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { scheme: m[1].toLowerCase() as LdapUrl["scheme"], host: m[2], port };
}

export const defaultPort = (scheme: LdapUrl["scheme"]) => (scheme === "ldaps" ? 636 : 389);

export function formatLdapUrl(u: LdapUrl): string {
  return `${u.scheme}://${u.host}:${u.port ?? defaultPort(u.scheme)}`;
}

/**
 * Typing a URL updates the encryption from its scheme: ldaps:// is LDAPS;
 * ldap:// keeps StartTLS or None, and turns LDAPS into StartTLS.
 */
export function securityForUrl(raw: string, current: Security): Security {
  const u = parseLdapUrl(raw);
  if (!u) return current;
  if (u.scheme === "ldaps") return "ldaps";
  return current === "ldaps" ? "starttls" : current;
}

/**
 * Choosing an encryption rewrites the URL's scheme and swaps the default port
 * (636 ↔ 389). A custom port is kept. An unparseable URL is left alone.
 */
export function urlForSecurity(raw: string, sec: Security): string {
  const u = parseLdapUrl(raw);
  if (!u) return raw;
  const scheme = sec === "ldaps" ? "ldaps" : "ldap";
  let port = u.port ?? defaultPort(u.scheme);
  if (scheme === "ldaps" && port === 389) port = 636;
  if (scheme === "ldap" && port === 636) port = 389;
  return formatLdapUrl({ scheme, host: u.host, port });
}
