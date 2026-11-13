/** Splits a DN into its RDNs, leaf first, on commas not escaped with a backslash. */
export function splitDn(dn: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === "\\") {
      cur += dn[i] + (dn[i + 1] ?? "");
      i++;
      continue;
    }
    if (dn[i] === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += dn[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The DN one level up, or "" for a single RDN. */
export function parentDn(dn: string): string {
  return splitDn(dn).slice(1).join(",");
}

/** Every ancestor of dn, nearest the root first, ending with dn itself. */
export function lineage(dn: string): string[] {
  const rdns = splitDn(dn);
  return rdns.map((_, i) => rdns.slice(rdns.length - 1 - i).join(",")).filter(Boolean);
}

/** DNs compare case-insensitively and ignore spaces after commas. */
export function sameDn(a: string, b: string): boolean {
  return splitDn(a).join(",").toLowerCase() === splitDn(b).join(",").toLowerCase();
}

/** "uid=ada" → ["uid=", "ada"]. */
export function rdnParts(rdn: string): [string, string] {
  const i = rdn.indexOf("=");
  return i > 0 ? [rdn.slice(0, i + 1), rdn.slice(i + 1)] : ["", rdn];
}

// attr=value pairs separated by commas (RFC 4514); a value may hold escaped characters such as "\,".
const RDN_PART = String.raw`\s*(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)\s*=\s*(?:\\.|[^,+\\])+`;
const DN_SYNTAX = new RegExp(String.raw`^${RDN_PART}(?:\+${RDN_PART})*(?:,${RDN_PART}(?:\+${RDN_PART})*)*\s*$`);

/** Whether v reads as a DN: "cn=Soubiran\, Thibault,ou=Users,dc=example,dc=org" does, "admin" does not. */
export const isDnSyntax = (v: string) => DN_SYNTAX.test(v);
