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
