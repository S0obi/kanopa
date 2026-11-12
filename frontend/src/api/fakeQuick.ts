import type { QuickHit, QuickResult } from "./backend";
import { fakeSearch, typeOf } from "./fakeDirectory";
import { fakeCheckFilter, fakeFilterMatcher } from "./fakeFilter";

/**
 * The header search for the fake backend: the same modes, filter, ranking and limits as
 * services/search.go, over the sample directory.
 */

const READ = 200;
const SHOW = 10;
const MIN_CHARS = 2;
const WORDS = 6;
// A distinguished name of two or more parts, such as one copied with Copy DN.
const DN = /^[A-Za-z][A-Za-z0-9._;-]*=[^,]*(,\s*[A-Za-z][A-Za-z0-9._;-]*=[^,]*)+$/;
const PREFIX = ["uid", "mail", "givenName"];
const SUBSTRING = ["cn", "sn", "displayName", "ou"];
const ASSERTION = /^[A-Za-z][A-Za-z0-9._;-]*[~<>]?=/;

const escape = (w: string) => w.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

export function quickFilter(text: string): { mode: "names" | "filter" | "dn"; filter: string; words: string[] } {
  const t = text.trim();
  if (t.startsWith("(")) return { mode: "filter", filter: t, words: [] };
  if (DN.test(t)) return { mode: "dn", filter: "(objectClass=*)", words: [] };
  if (ASSERTION.test(t)) return { mode: "filter", filter: `(${t})`, words: [] };
  // A word needs two characters: the half-typed end of "ada l" is not a word yet.
  const words = t.split(/\s+/).filter((w) => [...w].length >= MIN_CHARS).slice(0, WORDS);
  const one = (w: string) => `(|${PREFIX.map((a) => `(${a}=${escape(w)}*)`).join("")}${SUBSTRING.map((a) => `(${a}=*${escape(w)}*)`).join("")})`;
  return { mode: "names", filter: words.length === 1 ? one(words[0]!) : `(&${words.map(one).join("")})`, words };
}

type Attrs = Record<string, string[]>;
const get = (attrs: Attrs, name: string): string[] => attrs[Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name] ?? [];

const nameOf = (h: { dn: string; attrs: Attrs }) => get(h.attrs, "displayName")[0] || get(h.attrs, "cn")[0] || get(h.attrs, "uid")[0] || get(h.attrs, "ou")[0] || h.dn.split(",")[0]!;

function tierOf(attrs: Attrs, words: string[]): number {
  let worst = 0;
  for (const w of words.map((x) => x.toLowerCase())) {
    let best = 3;
    for (const a of [...PREFIX, ...SUBSTRING])
      for (const raw of get(attrs, a)) {
        const v = raw.toLowerCase();
        if (v === w) best = Math.min(best, 0);
        else if (v.startsWith(w)) best = Math.min(best, 1);
        else if (v.includes(w)) best = Math.min(best, 2);
      }
    worst = Math.max(worst, best);
  }
  return worst;
}

export function fakeQuick(text: string, baseDn: string, opts: { serverLimit: number; paged: boolean }): QuickResult {
  const { mode, filter, words } = quickFilter(text);
  const out: QuickResult = { mode, filter, hits: [], total: 0, more: false, serverLimit: false, paged: opts.paged, elapsedMs: 0, invalid: null, failure: null };
  if (mode === "names" && words.length === 0) return out;
  if (mode === "filter") {
    const bad = fakeCheckFilter(filter);
    if (bad) {
      const bare = !text.trim().startsWith("(");
      return { ...out, invalid: { message: bad.message, position: bare && bad.position > 0 ? bad.position - 1 : bad.position } };
    }
  }
  if (mode === "dn") out.filter = text.trim();
  let found = (mode === "dn" ? fakeSearch(text.trim(), "base", fakeFilterMatcher(filter)!) : fakeSearch(baseDn, "sub", fakeFilterMatcher(filter)!)) ?? [];
  let more = false;
  let serverLimit = false;
  if (opts.serverLimit > 0 && found.length > Math.min(opts.serverLimit, READ)) {
    found = found.slice(0, opts.serverLimit);
    serverLimit = opts.serverLimit < READ;
    more = true;
  }
  if (found.length > READ) {
    found = found.slice(0, READ);
    more = true;
  }
  out.total = found.length;
  out.more = more;
  out.serverLimit = serverLimit;
  out.elapsedMs = 9;
  const list = mode === "names" ? [...found].sort((a, b) => tierOf(a.attrs, words) - tierOf(b.attrs, words) || nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase())) : found;
  out.hits = list.slice(0, SHOW).map((h): QuickHit => {
    const type = typeOf(get(h.attrs, "objectClass"), h.dn);
    const mail = get(h.attrs, "mail")[0];
    return { dn: h.dn, name: nameOf(h), type, sub: type === "person" && mail ? mail : (get(h.attrs, "description")[0] ?? "") };
  });
  return out;
}
