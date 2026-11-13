import type { AllowedAttribute, ClassInfo, EntryAttribute, EntryChange, EntryView, Failure, FindResult, GIDResult, POSIXResult, RelatedEntry, TreeNode, UIDMatch } from "./backend";
import type { AttributeChange, EntryResult } from "../../bindings/github.com/S0obi/kanopa/services/models";
import { parentDn, rdnParts, splitDn } from "@/lib/dn";

/**
 * The test server's sample directory (test/ldap/seedgen), for the fake backend:
 * dc=example,dc=org with 1,182 people, 24 groups and 3 POSIX groups, 3 service accounts, 70 hosts and a referral.
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
  // POSIX groups list their members by uid (memberUid). unix-devs lists a uid nobody carries, and a service account's.
  for (const [cn, desc, gid, uids] of [
    ["unix-staff", "Unix group of the staff", "2001", ["ada", "alan", "grace"]],
    ["unix-devs", "Unix group of the developers", "2002", ["ada", "margaret", "ghost.user", "svc-mail"]],
    ["unix-empty", "Unix group with no member yet", "2003", []],
  ] as Array<[string, string, string, string[]]>)
    add(`cn=${cn},ou=groups,${BASE}`, { objectClass: ["posixGroup", "top"], cn: [cn], description: [desc], gidNumber: [gid], ...(uids.length ? { memberUid: uids } : {}), ...stamps });
  for (const [uid, desc] of [["svc-kanopa", "Kanopa read-only service account"], ["svc-backup", "Nightly directory backup"], ["svc-mail", "Mail server address lookups"]])
    add(`uid=${uid},ou=services,${BASE}`, { objectClass: ["account", "simpleSecurityObject", "top"], uid: [uid], description: [desc], userPassword: ["{SSHA}yyyy"], ...stamps });
  const hosts: Array<[string, string, string]> = [["web01", "Public web server", "10.0.4.11"], ["db01", "Primary database server", "10.0.4.21"]];
  for (let i = hosts.length; i < 70; i++) {
    const kind = ["app", "cache", "build", "mail", "file", "print"][i % 6];
    hosts.push([`${kind}${String(i).padStart(2, "0")}`, `Internal ${kind} server`, `10.0.${5 + Math.floor(i / 50)}.${10 + (i % 50)}`]);
  }
  for (const [cn, desc, ip] of hosts)
    add(`cn=${cn},ou=hosts,${BASE}`, { objectClass: ["device", "ipHost", "top"], cn: [cn], description: [desc], ipHostNumber: [ip], ...stamps });
  if (large()) addLargeProfile(add, stamps);
  add(`ou=partners,${BASE}`, { objectClass: ["referral", "extensibleObject"], ou: ["partners"], ref: ["ldap://partners.example.org/ou=partners,dc=example,dc=org"] });
  m.set(key(SUBSCHEMA), { dn: SUBSCHEMA, attrs: { objectClass: ["top", "subentry", "subschema", "extensibleObject"], cn: ["Subschema"] }, children: [] });
  return m;
}

/**
 * The large profile, as `task ldap:up PROFILE=large` seeds it: ou=archive with 10,000 entries, and
 * cn=everyone, a group of 5,000 members. On with `?large` in the address, or setLargeProfile(true).
 */
let largeOn = typeof location !== "undefined" && new URLSearchParams(location.search).has("large");
const large = () => largeOn;
export function setLargeProfile(on: boolean) {
  largeOn = on;
  dir = null;
}
export const LARGE = { ou: `ou=archive,${BASE}`, group: `cn=everyone,ou=groups,${BASE}`, children: 10_000, members: 5_000 };

function addLargeProfile(add: (dn: string, attrs: Attrs) => void, stamps: Attrs) {
  add(LARGE.ou, { objectClass: ["organizationalUnit", "top"], ou: ["archive"], description: ["Former employees and old accounts"], ...stamps });
  const uids: string[] = [];
  for (let i = 1; i <= LARGE.children; i++) {
    const uid = `arch${String(i).padStart(5, "0")}`;
    if (i <= LARGE.members) uids.push(`uid=${uid},${LARGE.ou}`);
    add(`uid=${uid},${LARGE.ou}`, {
      objectClass: ["inetOrgPerson", "organizationalPerson", "person", "top"], uid: [uid], cn: [`Archive ${i}`], sn: [`Archive${i}`], givenName: ["Archive"],
      mail: [`${uid}@example.org`], ...stamps,
    });
  }
  add(LARGE.group, { objectClass: ["groupOfNames", "top"], cn: ["everyone"], description: ["Everyone in the archive"], member: uids, ...stamps });
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
  if (has(oc, "groupOfNames", "groupOfUniqueNames", "posixGroup")) return "group";
  if (has(oc, "inetOrgPerson", "person")) return "person";
  if (has(oc, "device", "ipHost", "subschema")) return "server";
  return "entry";
}

const DN_ATTRS = new Set(["member", "uniquemember", "manager", "owner", "seealso", "creatorsname"]);
const OPERATIONAL = new Set(["createtimestamp", "creatorsname", "entryuuid"]);
const SINGLE = new Set(["displayname", "employeenumber"]);
const REQUIRED: Record<string, string[]> = { person: ["objectclass", "cn", "sn"], group: ["objectclass", "cn", "member"], posix: ["objectclass", "cn", "gidnumber"], ou: ["objectclass", "ou"] };
const STRUCTURAL: Record<string, string> = { person: "inetOrgPerson", group: "groupOfNames", posix: "posixGroup", ou: "organizationalUnit" };
/** The schema kind of an entry: a posixGroup is a group that lists uids, and has its own rules. */
const schemaOf = (oc: string[], type: string) => (type === "group" && has(oc, "posixGroup") && !has(oc, "groupOfNames", "groupOfUniqueNames") ? "posix" : type);
// What the object classes allow, as the fixture's schema would say (a sample, not the whole schema).
const ALLOWED: Record<string, Array<[string, string, boolean]>> = {
  person: [["cn", "text", false], ["sn", "text", false], ["description", "text", false], ["displayName", "text", true], ["employeeNumber", "text", true],
    ["givenName", "text", false], ["l", "text", false], ["mail", "text", false], ["manager", "dn", false], ["mobile", "text", false],
    ["roomNumber", "text", false], ["seeAlso", "dn", false], ["telephoneNumber", "text", false], ["title", "text", false], ["userPassword", "password", false]],
  group: [["businessCategory", "text", false], ["description", "text", false], ["o", "text", false], ["owner", "dn", false], ["seeAlso", "dn", false]],
  posix: [["description", "text", false], ["gidNumber", "text", true], ["memberUid", "text", false], ["userPassword", "password", false]],
  ou: [["description", "text", false], ["l", "text", false], ["postalCode", "text", false], ["seeAlso", "dn", false], ["telephoneNumber", "text", false]],
};

/** A stand-in for Go's value fingerprint. */
function valueId(v: string): string {
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
  const schema = schemaOf(oc, type);
  const required = new Set(REQUIRED[schema] ?? ["objectclass"]);
  const attributes: EntryAttribute[] = Object.entries(n.attrs).map(([name, values]) => {
    const lower = name.toLowerCase();
    const kind = lower.includes("password") ? "password" : DN_ATTRS.has(lower) ? "dn" : lower === "jpegphoto" ? "binary" : "text";
    const shown = kind === "password" ? values.map((v) => `{SSHA} hashed value · ${v.length} bytes`) : kind === "binary" ? values.map(() => "JPEG image · 14,236 bytes") : values;
    const ids = kind === "password" || kind === "binary" ? values.map(valueId) : null;
    return { name, values: shown, ids, kind, operational: OPERATIONAL.has(lower), singleValue: SINGLE.has(lower), required: required.has(lower) };
  });
  const present = new Set(Object.keys(n.attrs).map((a) => a.toLowerCase()));
  const allowed: AllowedAttribute[] = (ALLOWED[schema] ?? [])
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

const valuesOf = (attrs: Attrs, name: string) => attrs[Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name] ?? [];
const nameIn = (attrs: Attrs, name: string) => Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
const isDelta = (a: AttributeChange) => (a.add?.length ?? 0) + (a.remove?.length ?? 0) > 0;
const notFound = () => refused(32, "No such object", "Entry gone.", "this entry no longer exists: someone deleted or renamed it. Reload the tree.");
const nonLeaf = () => refused(66, "Not allowed on non-leaf", "Entry has children.", "this entry has entries below it. Delete them first.");

function missingRequired(type: string, attrs: Attrs): Failure | null {
  for (const r of REQUIRED[type] ?? [])
    if (!Object.keys(attrs).some((k) => k.toLowerCase() === r)) {
      const attr = (ALLOWED[type] ?? []).find(([a]) => a.toLowerCase() === r)?.[0] ?? r;
      return refused(65, "Object class violation", "Required attribute missing.", `${STRUCTURAL[type]} requires the attribute ${attr}.`);
    }
  return null;
}

/** How two values of an attribute are compared: memberUid exactly (caseExactIA5Match), the rest as DNs are. */
const sameValue = (attr: string) => (attr.toLowerCase() === "memberuid" ? (a: string, b: string) => a === b : (a: string, b: string) => key(a) === key(b));

/** Applies one entry's changes like OpenLDAP would, or says why it refuses them. */
function fakeModify(ch: EntryChange): Failure | null {
  const n = directory().get(key(ch.dn));
  if (!n) return notFound();
  const oc = n.attrs.objectClass ?? [];
  const type = schemaOf(oc, typeOf(oc, ch.dn));
  const changed = (ch.attributes ?? []).filter((a) => {
    const now = valuesOf(n.attrs, a.name);
    const same = sameValue(a.name);
    if (isDelta(a)) return (a.remove ?? []).some((v) => !now.some((x) => same(x, v)));
    const ids = a.kind === "binary" || a.kind === "password" ? now.map(valueId) : now;
    const before = a.before ?? [];
    return ids.length !== before.length || !before.every((v) => ids.includes(v));
  });
  if (changed.length) return conflict(changed.map((a) => a.name));
  const next: Attrs = { ...n.attrs };
  for (const a of ch.attributes ?? []) {
    const name = nameIn(next, a.name);
    const now = next[name] ?? [];
    const hidden = a.kind === "binary" || a.kind === "password";
    let values: string[];
    if (isDelta(a)) {
      const same = sameValue(a.name);
      values = now.filter((v) => !(a.remove ?? []).some((r) => same(r, v)));
      for (const v of a.add ?? []) if (!values.some((x) => same(x, v))) values.push(v);
    } else {
      const after = a.after ?? [];
      values = hidden ? now.filter((v) => after.includes(valueId(v))) : after;
      if (a.kind === "password" && a.password) values = [`{SSHA}${btoa(a.password).slice(0, 28)}`];
    }
    if (SINGLE.has(name.toLowerCase()) && values.length > 1)
      return refused(19, "Constraint violation", "Change refused.", `attribute '${name}' cannot have multiple values.`);
    if (values.length) next[name] = values;
    else delete next[name];
  }
  const missing = missingRequired(type, next);
  if (missing) return missing;
  n.attrs = next;
  return null;
}

function fakeAdd(ch: EntryChange): Failure | null {
  const d = directory();
  if (d.has(key(ch.dn))) return refused(68, "Entry already exists", "Name taken.", "an entry with this DN already exists. Choose another name.");
  const parent = parentDn(ch.dn);
  if (!d.has(key(parent))) return notFound();
  const attrs: Attrs = {};
  for (const a of ch.attributes ?? []) {
    if (a.kind === "password") {
      if (a.password) attrs[a.name] = [`{SSHA}${btoa(a.password).slice(0, 28)}`];
      continue;
    }
    const vals = (a.after ?? []).filter((v) => v.trim());
    if (vals.length) attrs[a.name] = vals;
  }
  const missing = missingRequired(schemaOf(attrs.objectClass ?? [], typeOf(attrs.objectClass ?? [], ch.dn)), attrs);
  if (missing) return missing;
  d.set(key(ch.dn), { dn: ch.dn, attrs: { ...attrs, createTimestamp: ["20261111120000Z"], creatorsName: [`cn=admin,${BASE}`], entryUUID: [crypto.randomUUID()] }, children: [] });
  d.get(key(parent))!.children.push(ch.dn);
  return null;
}

function fakeDelete(dn: string): Failure | null {
  const d = directory();
  const n = d.get(key(dn));
  if (!n) return notFound();
  if (n.children.length) return nonLeaf();
  d.delete(key(dn));
  const p = d.get(key(parentDn(dn)));
  if (p) p.children = p.children.filter((c) => key(c) !== key(dn));
  return null;
}

function fakeRename(dn: string, to: string): Failure | null {
  const d = directory();
  const n = d.get(key(dn));
  if (!n) return notFound();
  if (n.children.length) return refused(66, "Not allowed on non-leaf", "Entry has children.", "Kanopa renames only entries without entries below them.");
  if (d.has(key(to))) return refused(68, "Entry already exists", "Name taken.", "an entry with this DN already exists. Choose another name.");
  const [attrEq, oldValue] = rdnParts(splitDn(dn)[0]);
  const [, newValue] = rdnParts(splitDn(to)[0]);
  const attr = nameIn(n.attrs, attrEq.slice(0, -1));
  const unesc = (v: string) => v.replace(/\\(.)/g, "$1");
  n.attrs[attr] = [...(n.attrs[attr] ?? []).filter((v) => v !== unesc(oldValue)), unesc(newValue)];
  n.dn = to;
  d.delete(key(dn));
  d.set(key(to), n);
  const p = d.get(key(parentDn(dn)));
  if (p) p.children = p.children.map((c) => (key(c) === key(dn) ? to : c));
  return null;
}

interface Step {
  index: number;
  op: string;
  dn: string;
  to?: string;
  newRdn?: string;
  ch: EntryChange;
}

const escapeRdn = (v: string) =>
  [...v].map((c, i) => (`,+"\\<>;`.includes(c) || (i === 0 && (c === " " || c === "#")) || (i === v.length - 1 && c === " ") ? `\\${c}` : c)).join("");

/** Go's orderChanges: renames, adds parents first, modifies, deletes children first; DNs follow renames. */
function order(changes: EntryChange[]): Step[] {
  const moves: Array<[string, string]> = [];
  const steps: Step[] = changes.map((ch, index) => {
    const op = ch.op || "modify";
    if (op !== "rename") return { index, op, dn: ch.dn, ch };
    const [attr] = rdnParts(splitDn(ch.dn)[0]);
    const newRdn = `${attr}${escapeRdn(ch.newRdn)}`;
    const to = `${newRdn},${parentDn(ch.dn)}`;
    moves.push([ch.dn, to]);
    return { index, op, dn: ch.dn, to, newRdn, ch };
  });
  const rewrite = (dn: string) => {
    for (const [from, to] of moves) {
      if (key(dn) === key(from)) return to;
      if (key(dn).endsWith(`,${key(from)}`)) return `${splitDn(dn).slice(0, splitDn(dn).length - splitDn(from).length).join(",")},${to}`;
    }
    return dn;
  };
  for (const s of steps) {
    if (s.op === "rename") continue;
    s.dn = rewrite(s.dn);
    s.ch = {
      ...s.ch, dn: s.dn,
      attributes: (s.ch.attributes ?? []).map((a) => (a.kind === "dn" ? { ...a, after: (a.after ?? []).map(rewrite), add: (a.add ?? []).map(rewrite) } : a)),
    };
  }
  const rank: Record<string, number> = { rename: 0, add: 1, modify: 2, delete: 3 };
  const depth = (dn: string) => splitDn(dn).length;
  return [...steps].sort((a, b) => rank[a.op] - rank[b.op] || (a.op === "add" ? depth(a.dn) - depth(b.dn) : a.op === "delete" ? depth(b.dn) - depth(a.dn) : 0));
}

/** Applies a change set like Go's ChangeService.Apply: in order, stopping at the first refusal. */
export function fakeApply(changes: EntryChange[], refuse?: () => Failure | null): EntryResult[] {
  const out: EntryResult[] = [];
  for (const s of order(changes)) {
    const f =
      refuse?.() ??
      (s.op === "add" ? fakeAdd(s.ch) : s.op === "delete" ? fakeDelete(s.dn) : s.op === "rename" ? fakeRename(s.dn, s.to!) : fakeModify(s.ch));
    const dn = s.op === "rename" && !f ? s.to! : s.dn;
    out.push({ index: s.index, op: s.op, dn, ok: !f, node: f || s.op === "delete" ? null : fakeNode(dn), failure: f });
    if (f) break;
  }
  return out;
}

/** The change set as Go's Preview writes it, in the order Apply sends it. */
export function fakePreview(changes: EntryChange[]): string {
  const records: string[] = [];
  for (const s of order(changes)) {
    const ch = s.ch;
    const lines: string[] = [];
    if (ch.title) lines.push(`# ${ch.title}`);
    if (s.op === "delete") {
      records.push([...lines, ldifLine("dn", s.dn), "changetype: delete"].join("\n") + "\n");
      continue;
    }
    if (s.op === "rename") {
      records.push([...lines, ldifLine("dn", s.dn), "changetype: modrdn", ldifLine("newrdn", s.newRdn!), "deleteoldrdn: 1"].join("\n") + "\n");
      continue;
    }
    if (s.op === "add") {
      lines.push(ldifLine("dn", s.dn), "changetype: add");
      for (const a of ch.attributes ?? []) {
        if (a.kind === "password") continue;
        for (const v of a.after ?? []) lines.push(ldifLine(a.name, v));
      }
      if ((ch.attributes ?? []).some((a) => a.kind === "password" && a.password))
        lines.push("# userPassword is set with the Password Modify operation (RFC 3062) after the add; it is not shown.");
      records.push(lines.join("\n") + "\n");
      continue;
    }
    lines.push(ldifLine("dn", s.dn), "changetype: modify");
    let password = false;
    let any = false;
    for (const a of ch.attributes ?? []) {
      if (isDelta(a)) {
        if (a.remove?.length) lines.push(`delete: ${a.name}`, ...a.remove.map((v) => ldifLine(a.name, v)), "-");
        if (a.add?.length) lines.push(`add: ${a.name}`, ...a.add.map((v) => ldifLine(a.name, v)), "-");
        any = true;
        continue;
      }
      const before = a.before ?? [];
      const after = a.after ?? [];
      const added = after.filter((v) => !before.includes(v));
      const removed = before.filter((v) => !after.includes(v));
      if (a.kind === "password" && a.password) {
        password = true;
        continue;
      }
      if (!added.length && !removed.length) continue;
      any = true;
      if (a.kind === "binary" || a.kind === "password") {
        lines.push(`delete: ${a.name}`, `# ${removed.length} ${a.kind} value${removed.length === 1 ? "" : "s"} removed, not shown`, "-");
        continue;
      }
      const op = !after.length ? "delete" : !before.length ? "add" : added.length && removed.length ? "replace" : added.length ? "add" : "delete";
      const vals = op === "replace" || (op === "add" && !before.length) ? after : op === "add" ? added : after.length ? removed : [];
      lines.push(`${op}: ${a.name}`, ...vals.map((v) => ldifLine(a.name, v)), "-");
    }
    if (password) lines.splice(ch.title ? 1 : 0, 0, "# The password is set with the Password Modify operation (RFC 3062); it is not shown.");
    if (any || password) records.push(lines.join("\n") + "\n");
  }
  return records.join("\n");
}

/** The entry's uid: what a posixGroup's memberUid holds. */
const uidOf = (dn: string) => directory().get(key(dn))?.attrs.uid?.[0] ?? "";

export function fakeMemberOf(dn: string): RelatedEntry[] {
  const uid = uidOf(dn);
  const out: RelatedEntry[] = [];
  for (const n of directory().values()) {
    const byDn = (n.attrs.member ?? []).some((m) => key(m) === key(dn));
    const byUid = !!uid && (n.attrs.memberUid ?? []).includes(uid);
    if (byDn || byUid)
      out.push({ dn: n.dn, name: n.attrs.cn[0], type: "group", description: n.attrs.description?.[0] ?? "", memberAttr: byDn ? "member" : "memberUid", uid: "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups that list dn, as Go's Referrers finds them: by DN, and by uid unless another entry carries the same uid. */
export function fakeReferrers(dn: string): RelatedEntry[] {
  const uid = uidOf(dn);
  let shared = false;
  if (uid) for (const n of directory().values()) if (key(n.dn) !== key(dn) && (n.attrs.uid ?? []).includes(uid)) shared = true;
  return fakeMemberOf(dn)
    .filter((g) => g.memberAttr !== "memberUid" || !shared)
    .map((g) => ({ ...g, description: "", uid: g.memberAttr === "memberUid" ? uid : "" }));
}

/** What each uid stands for, as Go's ResolveUIDs: the first entry that carries it, and how many do. */
export function fakeResolveUids(uids: string[]): UIDMatch[] {
  return uids.map((uid) => {
    const l = uid.toLowerCase();
    const hits = [...directory().values()].filter((n) => (n.attrs.uid ?? []).some((v) => v.toLowerCase() === l));
    const first = hits[0];
    if (!first) return { uid, dn: "", name: "", type: "", matches: 0 };
    return { uid, dn: first.dn, name: first.attrs.cn?.[0] ?? splitDn(first.dn)[0], type: typeOf(first.attrs.objectClass ?? [], first.dn), matches: hits.length };
  });
}

/** The next free gidNumber, and the posixGroups that already use gid, as Go's GIDCheck. */
export function fakeGidCheck(gid: number): GIDResult {
  let highest = 999;
  const takenBy: string[] = [];
  for (const n of directory().values()) {
    const g = Number(n.attrs.gidNumber?.[0]);
    if (!Number.isFinite(g)) continue;
    highest = Math.max(highest, g);
    if (gid > 0 && g === gid && has(n.attrs.objectClass ?? [], "posixGroup")) takenBy.push(n.attrs.cn?.[0] ?? n.dn);
  }
  return { next: highest + 1, takenBy: takenBy.sort(), failure: null };
}

/** The next free uidNumber, who holds uid, and the posixGroups to pick from, as Go's POSIXInfo. */
export function fakePosixInfo(uid: number): POSIXResult {
  let highest = 999;
  const uidTakenBy: string[] = [];
  const groups: Array<{ cn: string; gid: number }> = [];
  for (const n of directory().values()) {
    const oc = n.attrs.objectClass ?? [];
    const u = Number(n.attrs.uidNumber?.[0]);
    if (Number.isFinite(u)) {
      highest = Math.max(highest, u);
      if (uid > 0 && u === uid) uidTakenBy.push(n.attrs.uid?.[0] ?? n.attrs.cn?.[0] ?? n.dn);
    }
    const g = Number(n.attrs.gidNumber?.[0]);
    if (has(oc, "posixGroup") && Number.isFinite(g)) groups.push({ cn: n.attrs.cn?.[0] ?? n.dn, gid: g });
  }
  groups.sort((a, b) => a.cn.toLowerCase().localeCompare(b.cn.toLowerCase()));
  return { nextUid: highest + 1, uidTakenBy: uidTakenBy.sort(), groups, failure: null };
}

/** Picker search, as Go's DirectoryService.Find. */
export function fakeFind(kind: "people" | "groups", q: string): FindResult {
  const t = q.trim();
  const filter =
    kind === "people"
      ? `(&(|(objectClass=inetOrgPerson)(objectClass=posixAccount))(|(uid=${t}*)(cn=*${t}*)(mail=${t}*)))`
      : `(&(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(cn=*${t}*))`;
  if ([...t].length < 2) return { entries: [], total: 0, more: false, filter, base: BASE, failure: null };
  const l = t.toLowerCase();
  const hits: RelatedEntry[] = [];
  for (const n of directory().values()) {
    const oc = n.attrs.objectClass ?? [];
    const cn = n.attrs.cn?.[0] ?? "";
    if (kind === "people") {
      if (!has(oc, "inetOrgPerson", "posixAccount")) continue;
      const uid = n.attrs.uid?.[0] ?? "";
      const mail = n.attrs.mail?.[0] ?? "";
      if (!(uid.toLowerCase().startsWith(l) || cn.toLowerCase().includes(l) || mail.toLowerCase().startsWith(l))) continue;
      hits.push({ dn: n.dn, name: cn, type: "person", description: mail, memberAttr: "", uid });
    } else {
      if (!has(oc, "groupOfNames", "groupOfUniqueNames", "posixGroup") || !cn.toLowerCase().includes(l)) continue;
      hits.push({
        dn: n.dn, name: cn, type: "group", description: n.attrs.description?.[0] ?? "", uid: "",
        memberAttr: has(oc, "groupOfNames") ? "member" : has(oc, "groupOfUniqueNames") ? "uniqueMember" : "memberUid",
      });
    }
  }
  hits.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { entries: hits.slice(0, 8), total: hits.length, more: false, filter, base: BASE, failure: null };
}

/** The entries under base that a filter matches, in directory order; null when base is not in the directory. */
export function fakeSearch(base: string, scope: "base" | "one" | "sub", match: (attrs: Attrs) => boolean): Array<{ dn: string; attrs: Attrs }> | null {
  const root = key(base);
  if (!directory().has(root)) return null;
  const out: Array<{ dn: string; attrs: Attrs }> = [];
  for (const [k, n] of directory()) {
    const inside = scope === "base" ? k === root : scope === "one" ? splitDn(n.dn).slice(1).join(",").toLowerCase() === root : k === root || k.endsWith(`,${root}`);
    if (inside && match(n.attrs)) out.push({ dn: n.dn, attrs: n.attrs });
  }
  return out;
}

/** A sample of the fixture's schema, as Go's ObjectClasses lists it. */
export function fakeClasses(): ClassInfo[] {
  const a = (name: string, kind = "text", singleValue = false) => ({ name, kind, singleValue, required: false });
  const must = (...names: string[]) => names.map((n) => ({ ...a(n), required: true }));
  const personMay = [a("description"), a("seeAlso", "dn"), a("telephoneNumber"), a("userPassword", "password")];
  return [
    { name: "account", kind: "STRUCTURAL", desc: "RFC1274: account", must: must("uid"), may: [a("description"), a("host"), a("l"), a("o"), a("ou"), a("seeAlso", "dn")] },
    { name: "device", kind: "STRUCTURAL", desc: "RFC2256: a device", must: must("cn"), may: [a("description"), a("l"), a("o"), a("ou"), a("owner", "dn"), a("serialNumber"), a("seeAlso", "dn")] },
    { name: "groupOfNames", kind: "STRUCTURAL", desc: "RFC2256: a group of names (DNs)", must: [...must("cn"), { ...a("member", "dn"), required: true }], may: [a("businessCategory"), a("description"), a("o"), a("ou"), a("owner", "dn"), a("seeAlso", "dn")] },
    { name: "inetOrgPerson", kind: "STRUCTURAL", desc: "RFC2798: Internet Organizational Person", must: must("sn", "cn"), may: [a("displayName", "text", true), a("givenName"), a("mail"), a("title"), a("uid"), ...personMay] },
    { name: "ipHost", kind: "AUXILIARY", desc: "Abstraction of a host, an IP device", must: [...must("cn"), { ...a("ipHostNumber"), required: true }], may: [a("description"), a("l"), a("manager", "dn")] },
    { name: "organizationalUnit", kind: "STRUCTURAL", desc: "RFC2256: an organizational unit", must: must("ou"), may: [a("description"), a("l"), a("postalCode"), a("seeAlso", "dn"), a("telephoneNumber")] },
    { name: "person", kind: "STRUCTURAL", desc: "RFC2256: a person", must: must("sn", "cn"), may: personMay },
    { name: "posixGroup", kind: "STRUCTURAL", desc: "Abstraction of a group of accounts", must: [...must("cn"), { ...a("gidNumber"), required: true }], may: [a("description"), a("memberUid"), a("userPassword", "password")] },
    { name: "simpleSecurityObject", kind: "AUXILIARY", desc: "RFC1274: simple security object", must: [{ ...a("userPassword", "password"), required: true }], may: [] },
  ];
}
