import type { AllowedAttribute, EntryAttribute, EntryChange, EntryView, Failure, RelatedEntry, TreeNode } from "./backend";
import { splitDn } from "@/lib/dn";

/**
 * The test server's sample directory (test/ldap/seedgen), for the fake backend:
 * dc=example,dc=org with 1,182 people, 24 groups, 3 service accounts, 70 hosts and a referral.
 */
export const BASE = "dc=example,dc=org";
export const SUBSCHEMA = "cn=Subschema";

type Attrs = Record<string, string[]>;
interface Node {
  dn: string;
  attrs: Attrs;
  children: string[];
}

const named = [
  ["ada", "Ada", "Lovelace", "Principal engineer", "Research", "grace"],
  ["alan", "Alan", "Turing", "Research scientist", "Research", "ada"],
  ["grace", "Grace", "Hopper", "Director of engineering", "Engineering", ""],
  ["katherine", "Katherine", "Johnson", "Data scientist", "Research", "ada"],
  ["margaret", "Margaret", "Hamilton", "Software engineer", "Engineering", "grace"],
  ["edsger", "Edsger", "Dijkstra", "Software engineer", "Engineering", "grace"],
] as const;

const firsts = ["Adele", "Bruno", "Chiara", "Dario", "Elena", "Fabio", "Greta", "Hugo", "Ines", "Jonas", "Lea", "Marco", "Nora", "Oscar", "Paula",
  "Quentin", "Rosa", "Simon", "Tara", "Urs", "Vera", "Walter", "Xenia", "Yann", "Zoe", "Anton", "Bea", "Carl", "Dora", "Emil", "Flora", "Gino",
  "Hanna", "Ivo", "Jana", "Kurt", "Lina", "Max", "Nina", "Otto"];
const lasts = ["Ammann", "Bianchi", "Cattaneo", "Dubois", "Egger", "Favre", "Gerber", "Huber", "Imhof", "Jaquet", "Keller", "Lüthi", "Meier",
  "Nussbaum", "Ott", "Perrin", "Rossi", "Schmid", "Tanner", "Vogel", "Weber", "Zürcher", "Baumann", "Frei", "Graf", "Hofer", "Kunz", "Moser", "Roth", "Steiner"];
const groupNames: Array<[string, string]> = [["admins", "Directory administrators"], ["engineering", "Engineering department"],
  ["research", "Research department"], ["support", "Support team"], ["vpn-users", "Remote access through the VPN"], ["design", "Product design"],
  ["finance", "Finance department"], ["hr", "Human resources"], ["legal", "Legal department"], ["marketing", "Marketing team"],
  ["operations", "Operations team"], ["platform", "Platform team"], ["qa", "Quality assurance"], ["sales", "Sales team"], ["security", "Security team"],
  ["data", "Data team"], ["devops", "DevOps team"], ["mobile", "Mobile apps team"], ["web", "Web team"], ["infra", "Infrastructure team"],
  ["analytics", "Analytics team"], ["it-helpdesk", "IT help desk"], ["wiki-editors", "Wiki editors"], ["interns", "Interns"]];
const namedMembers: Record<string, string[]> = {
  admins: ["ada", "grace"], engineering: ["grace", "margaret", "ada"], research: ["ada", "alan", "katherine"], support: ["katherine"],
  "vpn-users": ["grace", "alan", "margaret"],
};

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]/g, "");
const person = (uid: string) => `uid=${uid},ou=people,${BASE}`;
const key = (dn: string) => splitDn(dn).join(",").toLowerCase();

function build(): Map<string, Node> {
  const m = new Map<string, Node>();
  const add = (dn: string, attrs: Attrs) => {
    m.set(key(dn), { dn, attrs, children: [] });
    const parent = splitDn(dn).slice(1).join(",");
    if (parent) m.get(key(parent))?.children.push(dn);
  };
  const stamps = { createTimestamp: ["20261106100000Z"], creatorsName: [`cn=admin,${BASE}`], entryUUID: ["809afb97-0fd3-4d40-ac57-8151b081c9d8"] };
  add(BASE, { objectClass: ["dcObject", "organization", "top"], dc: ["example"], o: ["Example Organization"], ...stamps });
  for (const [ou, desc] of [["people", "People and their login accounts"], ["groups", "Authorization groups"], ["services", "Accounts used by applications"], ["hosts", "Servers and network devices"]])
    add(`ou=${ou},${BASE}`, { objectClass: ["organizationalUnit", "top"], ou: [ou], description: [desc], ...stamps });

  const generated: string[] = [];
  const people: Array<[string, string, string, string, string, string]> = named.map((p) => [...p]);
  let n = 0;
  outer: for (const l of lasts)
    for (const f of firsts) {
      if (people.length >= 1182) break outer;
      n++;
      const uid = slug(`${f}.${l}`);
      generated.push(uid);
      people.push([uid, f, l, ["Software engineer", "Support specialist", "Account manager", "Analyst", "Designer", "Technician", "Consultant"][n % 7],
        ["Engineering", "Research", "Support", "Sales", "Operations", "Finance"][n % 6], named[n % 6][0]]);
    }
  for (const [uid, given, sn, title, dept, manager] of people) {
    const attrs: Attrs = {
      objectClass: ["inetOrgPerson", "organizationalPerson", "person", "top"], uid: [uid], cn: [`${given} ${sn}`], sn: [sn], givenName: [given],
      mail: [`${slug(`${given}.${sn}`)}@example.org`], title: [title], departmentNumber: [dept], userPassword: ["{SSHA}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], ...stamps,
    };
    if (manager) attrs.manager = [person(manager)];
    if (uid === "ada") attrs.jpegPhoto = ["\u0000jpeg"];
    add(person(uid), attrs);
  }
  groupNames.forEach(([cn, desc], i) => {
    const members = namedMembers[cn] ?? Array.from({ length: 3 + (i % 6) }, (_, j) => generated[(i * 37 + j * 11) % generated.length]);
    add(`cn=${cn},ou=groups,${BASE}`, { objectClass: ["groupOfNames", "top"], cn: [cn], description: [desc], member: members.map(person), ...stamps });
  });
  for (const [uid, desc] of [["svc-kanopa", "Kanopa read-only service account"], ["svc-backup", "Nightly directory backup"], ["svc-mail", "Mail server address lookups"]])
    add(`uid=${uid},ou=services,${BASE}`, { objectClass: ["account", "simpleSecurityObject", "top"], uid: [uid], description: [desc], userPassword: ["{SSHA}yyyy"], ...stamps });
  const hosts: Array<[string, string, string]> = [["web01", "Public web server", "10.0.4.11"], ["db01", "Primary database server", "10.0.4.21"]];
  for (let i = hosts.length; i < 70; i++) {
    const kind = ["app", "cache", "build", "mail", "file", "print"][i % 6];
    hosts.push([`${kind}${String(i).padStart(2, "0")}`, `Internal ${kind} server`, `10.0.${5 + Math.floor(i / 50)}.${10 + (i % 50)}`]);
  }
  for (const [cn, desc, ip] of hosts)
    add(`cn=${cn},ou=hosts,${BASE}`, { objectClass: ["device", "ipHost", "top"], cn: [cn], description: [desc], ipHostNumber: [ip], ...stamps });
  add(`ou=partners,${BASE}`, { objectClass: ["referral", "extensibleObject"], ou: ["partners"], ref: ["ldap://partners.example.org/ou=partners,dc=example,dc=org"] });
  m.set(key(SUBSCHEMA), { dn: SUBSCHEMA, attrs: { objectClass: ["top", "subentry", "subschema", "extensibleObject"], cn: ["Subschema"] }, children: [] });
  return m;
}

let dir: Map<string, Node> | null = null;
const directory = () => (dir ??= build());

/** Forgets every change applied to the sample directory (for tests). */
export function resetFakeDirectory() {
  dir = null;
}

const has = (oc: string[], ...names: string[]) => names.some((n) => oc.some((c) => c.toLowerCase() === n.toLowerCase()));
export function typeOf(oc: string[], dn: string): string {
  if (key(dn) === key(BASE) || has(oc, "dcObject", "organization")) return "root";
  if (has(oc, "organizationalUnit")) return "ou";
  if (has(oc, "groupOfNames")) return "group";
  if (has(oc, "inetOrgPerson", "person")) return "person";
  if (has(oc, "device", "ipHost", "subschema")) return "server";
  return "entry";
}

const DN_ATTRS = new Set(["member", "uniquemember", "manager", "owner", "seealso", "creatorsname"]);
const OPERATIONAL = new Set(["createtimestamp", "creatorsname", "entryuuid"]);
const SINGLE = new Set(["displayname", "employeenumber"]);
const REQUIRED: Record<string, string[]> = { person: ["objectclass", "cn", "sn"], group: ["objectclass", "cn", "member"], ou: ["objectclass", "ou"] };
const STRUCTURAL: Record<string, string> = { person: "inetOrgPerson", group: "groupOfNames", ou: "organizationalUnit" };
// What the object classes allow, as the fixture's schema would say (a sample, not the whole schema).
const ALLOWED: Record<string, Array<[string, string, boolean]>> = {
  person: [["cn", "text", false], ["sn", "text", false], ["description", "text", false], ["displayName", "text", true], ["employeeNumber", "text", true],
    ["givenName", "text", false], ["l", "text", false], ["mail", "text", false], ["manager", "dn", false], ["mobile", "text", false],
    ["roomNumber", "text", false], ["seeAlso", "dn", false], ["telephoneNumber", "text", false], ["title", "text", false], ["userPassword", "password", false]],
  group: [["businessCategory", "text", false], ["description", "text", false], ["o", "text", false], ["owner", "dn", false], ["seeAlso", "dn", false]],
  ou: [["description", "text", false], ["l", "text", false], ["postalCode", "text", false], ["seeAlso", "dn", false], ["telephoneNumber", "text", false]],
};

/** A stand-in for Go's value fingerprint. */
export function valueId(v: string): string {
  let h = 5381;
  for (let i = 0; i < v.length; i++) h = ((h * 33) ^ v.charCodeAt(i)) >>> 0;
  return `v${h.toString(16)}${v.length.toString(16)}`;
}

export function fakeNode(dn: string): TreeNode | null {
  const n = directory().get(key(dn));
  if (!n) return null;
  const oc = n.attrs.objectClass ?? [];
  const referral = has(oc, "referral");
  const rdn = splitDn(dn)[0];
  const sub = referral ? n.attrs.ref[0] : n.attrs.description?.[0] ?? (rdn.startsWith("cn=") ? "" : n.attrs.cn?.[0] ?? "");
  return { dn: n.dn, rdn, type: referral ? "entry" : typeOf(oc, dn), sub, hasChildren: n.children.length > 0, count: -1, referral };
}

export function fakeChildren(dn: string): TreeNode[] | null {
  const n = directory().get(key(dn));
  return n ? n.children.map((c) => fakeNode(c)!) : null;
}

function ldifLine(name: string, v: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = /^[\x01-\x09\x0b\x0c\x0e-\x7f]*$/.test(v) && !/^[ :<]/.test(v) && !v.endsWith(" ");
  return safe ? `${name}: ${v}` : `${name}:: ${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}`;
}

export function fakeEntry(dn: string): EntryView | null {
  const n = directory().get(key(dn));
  if (!n) return null;
  const oc = n.attrs.objectClass ?? [];
  const type = typeOf(oc, dn);
  const required = new Set(REQUIRED[type] ?? ["objectclass"]);
  const attributes: EntryAttribute[] = Object.entries(n.attrs).map(([name, values]) => {
    const lower = name.toLowerCase();
    const kind = lower.includes("password") ? "password" : DN_ATTRS.has(lower) ? "dn" : lower === "jpegphoto" ? "binary" : "text";
    const shown = kind === "password" ? values.map((v) => `{SSHA} hashed value · ${v.length} bytes`) : kind === "binary" ? values.map(() => "JPEG image · 14,236 bytes") : values;
    const ids = kind === "password" || kind === "binary" ? values.map(valueId) : null;
    return { name, values: shown, ids, kind, operational: OPERATIONAL.has(lower), singleValue: SINGLE.has(lower), required: required.has(lower) };
  });
  const present = new Set(Object.keys(n.attrs).map((a) => a.toLowerCase()));
  const allowed: AllowedAttribute[] = (ALLOWED[type] ?? [])
    .filter(([name]) => !present.has(name.toLowerCase()))
    .map(([name, kind, singleValue]) => ({ name, kind, singleValue, required: required.has(name.toLowerCase()) }));
  const ldif = [ldifLine("dn", n.dn)];
  for (const a of attributes) if (!a.operational) for (const v of n.attrs[a.name]) ldif.push(ldifLine(a.name, v));
  const rdnValue = splitDn(dn)[0].split("=").slice(1).join("=");
  return {
    dn: n.dn, type, objectClasses: oc, attributes, allowed, ldif: `${ldif.join("\n")}\n`, referral: has(oc, "referral"), elapsedMs: 12, failure: null,
    title: type === "person" ? n.attrs.cn[0] : rdnValue,
    subtitle: type === "person" ? [n.attrs.title?.[0], n.attrs.departmentNumber?.[0], n.attrs.mail?.[0]].filter(Boolean).join(" · ") : n.attrs.description?.[0] ?? "",
  };
}

/** A refused change, worded like Go's: "<name> (<code>) — <detail>". */
const refused = (code: number, name: string, title: string, detail: string): Failure => ({ title, message: `${name} (${code}) — ${detail}`, code, lost: false });

/** Go's ldapx.Conflict: names the attributes that changed since they were read. */
function conflict(attrs: string[]): Failure {
  const n = attrs.length;
  const what =
    n === 0
      ? "someone changed this entry since you read it."
      : n === 1
        ? `${attrs[0]} changed on the server since you read it.`
        : `${attrs.slice(0, -1).join(", ")} and ${attrs[n - 1]} changed on the server since you read them.`;
  return refused(122, "Assertion failed", "Entry changed meanwhile.", `${what} Reload the entry, then make your changes again.`);
}

/** Applies one entry's changes like OpenLDAP would, or says why it refuses them. */
export function fakeModify(ch: EntryChange): Failure | null {
  const n = directory().get(key(ch.dn));
  if (!n) return refused(32, "No such object", "Entry gone.", "this entry no longer exists: someone deleted or renamed it. Reload the tree.");
  const type = typeOf(n.attrs.objectClass ?? [], ch.dn);
  const valuesOf = (attrs: Attrs, name: string) => attrs[Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name] ?? [];
  const changed = (ch.attributes ?? []).filter((a) => {
    const now = valuesOf(n.attrs, a.name);
    const ids = a.kind === "binary" || a.kind === "password" ? now.map(valueId) : now;
    const before = a.before ?? [];
    return ids.length !== before.length || !before.every((v) => ids.includes(v));
  });
  if (changed.length) return conflict(changed.map((a) => a.name));
  const next: Attrs = { ...n.attrs };
  for (const a of ch.attributes ?? []) {
    const name = Object.keys(next).find((k) => k.toLowerCase() === a.name.toLowerCase()) ?? a.name;
    const now = next[name] ?? [];
    const hidden = a.kind === "binary" || a.kind === "password";
    const after = a.after ?? [];
    let values = hidden ? now.filter((v) => after.includes(valueId(v))) : after;
    if (a.kind === "password" && a.password) values = [`{SSHA}${btoa(a.password).slice(0, 28)}`];
    if (SINGLE.has(name.toLowerCase()) && values.length > 1)
      return refused(19, "Constraint violation", "Change refused.", `attribute '${name}' cannot have multiple values.`);
    if (values.length) next[name] = values;
    else delete next[name];
  }
  for (const r of REQUIRED[type] ?? [])
    if (!Object.keys(next).some((k) => k.toLowerCase() === r)) {
      const attr = (ALLOWED[type] ?? []).find(([a]) => a.toLowerCase() === r)?.[0] ?? r;
      return refused(65, "Object class violation", "Required attribute missing.", `${STRUCTURAL[type]} requires the attribute ${attr}.`);
    }
  n.attrs = next;
  return null;
}

/** The change set as Go's Preview writes it (text values only; hidden values become comments). */
export function fakePreview(changes: EntryChange[]): string {
  const records: string[] = [];
  for (const ch of changes) {
    const lines: string[] = [];
    if (ch.title) lines.push(`# ${ch.title}`);
    lines.push(ldifLine("dn", ch.dn), "changetype: modify");
    let password = false;
    for (const a of ch.attributes ?? []) {
      const before = a.before ?? [];
      const after = a.after ?? [];
      const added = after.filter((v) => !before.includes(v));
      const removed = before.filter((v) => !after.includes(v));
      if (a.kind === "password" && a.password) {
        password = true;
        continue;
      }
      if (!added.length && !removed.length) continue;
      if (a.kind === "binary" || a.kind === "password") {
        lines.push(`delete: ${a.name}`, `# ${removed.length} ${a.kind} value${removed.length === 1 ? "" : "s"} removed, not shown`, "-");
        continue;
      }
      const op = !after.length ? "delete" : !before.length ? "add" : added.length && removed.length ? "replace" : added.length ? "add" : "delete";
      const vals = op === "replace" || (op === "add" && !before.length) ? after : op === "add" ? added : after.length ? removed : [];
      lines.push(`${op}: ${a.name}`, ...vals.map((v) => ldifLine(a.name, v)), "-");
    }
    if (password) lines.splice(ch.title ? 1 : 0, 0, "# The password is set with the Password Modify operation (RFC 3062); it is not shown.");
    if (lines.length > (ch.title ? 3 : 2) + (password ? 1 : 0) || password) records.push(lines.join("\n") + "\n");
  }
  return records.join("\n");
}

export function fakeMemberOf(dn: string): RelatedEntry[] {
  const out: RelatedEntry[] = [];
  for (const n of directory().values())
    if ((n.attrs.member ?? []).some((m) => key(m) === key(dn)))
      out.push({ dn: n.dn, name: n.attrs.cn[0], type: "group", description: n.attrs.description?.[0] ?? "" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
