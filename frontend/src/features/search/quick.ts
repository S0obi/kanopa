import type { QuickResult } from "@/api/backend";

/** A piece of a name, and whether it is what the person typed. */
export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits text so the places the words match (case-insensitively) can be marked. */
export function highlight(text: string, words: string[]): Segment[] {
  const found = words.filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!found.length) return [{ text, hit: false }];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(found.join("|"), "gi"))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

/** The words of a plain search, for marking them in the results. */
export const wordsOf = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Whether the field has anything worth sending: two characters, or the start of a filter. */
export const searchable = (text: string): boolean => {
  const t = text.trim();
  return [...t].length >= 2 || t.startsWith("(");
};

/** "10 of 83", "10 of 200+", or just the number when everything is shown. */
export function countText(r: Pick<QuickResult, "total" | "more" | "hits">): string {
  const shown = r.hits?.length ?? 0;
  const total = `${r.total.toLocaleString("en-US")}${r.more ? "+" : ""}`;
  return r.total > shown || r.more ? `${shown} of ${total}` : total;
}
