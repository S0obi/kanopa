/** Attribute-name completion for the filter and the attribute list. */

const NAME = /[A-Za-z0-9._;-]/;

export interface Token {
  /** The text typed so far. */
  text: string;
  start: number;
  end: number;
}

/**
 * The attribute name being typed at the caret: in a filter, the word right after a "("; in a
 * list, the word after the start, a comma or a space. Null when the caret is somewhere else
 * (after the "=", inside a value).
 */
export function tokenAt(value: string, caret: number, mode: "filter" | "list"): Token | null {
  let start = caret;
  while (start > 0 && NAME.test(value[start - 1]!)) start--;
  let end = caret;
  while (end < value.length && NAME.test(value[end]!)) end++;
  if (end === start) return null;
  const before = start > 0 ? value[start - 1]! : "";
  if (mode === "filter" ? before !== "(" : before !== "" && before !== "," && before !== " ") return null;
  return { text: value.slice(start, caret), start, end };
}

/** Names that start with what was typed, the shortest first, at most limit. */
export function suggest(names: string[], typed: string, limit = 8): string[] {
  const t = typed.toLowerCase();
  if (!t) return [];
  return names
    .filter((n) => n.toLowerCase().startsWith(t))
    .sort((a, b) => a.length - b.length || a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, limit);
}

/** The value with the token replaced by name (and "=" after it in a filter), and where the caret goes. */
export function accept(value: string, token: Token, name: string, mode: "filter" | "list"): { value: string; caret: number } {
  const tail = value.slice(token.end);
  const sep = mode === "filter" && !tail.startsWith("=") ? "=" : "";
  const next = value.slice(0, token.start) + name + sep + tail;
  return { value: next, caret: token.start + name.length + (mode === "filter" ? 1 : 0) };
}

/** The attribute names typed in the list field: commas or spaces between them, no duplicates. */
export function parseAttributes(text: string): string[] {
  const out: string[] = [];
  for (const a of text.split(/[\s,]+/)) if (a && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  return out;
}
