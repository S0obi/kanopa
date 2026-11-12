import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { strings } from "../scripts/copy-strings.mjs";

// The design system's voice rules, held by a test: what the interface says is sentence case, plain, in
// contractions, and never shouts. The scan is a regex over the source (scripts/copy-strings.mjs).

const BANNED: Array<[RegExp, string]> = [
  [/\bsuccessfully\b/i, 'Say what happened, not that it "successfully" did ("File uploaded")'],
  [/\bplease\b/i, 'The UI is not asking a favor ("Enter a name")'],
  [/click here|tap to/i, "Link text names the destination"],
  [/\b(simply|easy|easily)\b/i, "Presumes, and condescends"],
  [/\b(leverage|seamless|empower)\b/i, "Corporate filler: say what it does"],
  [/\bcould not\b|\bcannot\b|\bdid not\b|\bdoes not\b|\bis not\b|\bwill not\b|\bdo not\b|\bhas not\b/i, "Use contractions (couldn't, can't, doesn't)"],
  [/!(\s|$)/, "No exclamation marks in system copy"],
  [/^Error:/i, 'No "Error:" prefix: say what happened'],
  [/ & |&amp;/, 'Spell out "and"'],
  [/^e\.g\./i, 'A placeholder is a real example, without "e.g."'],
  [/\.\.\.(?!\w)/, "A real ellipsis (…), and only for something in progress"],
  [/\bI\b(?! (?:am|'m)\b)(?=[ ,.'])/, 'The UI speaks as the product, never as "I"'],
  [/\bmy (connections|projects|entries|settings)\b/i, 'The person\'s things are "your", not "my"'],
];

// Words the rule would catch that are not copy: a field named in a sentence, a filter shown as an example.
const ALLOWED = [/^\(.*\)$/, /ldap:\/\//];

describe("the interface's copy", () => {
  // Vitest runs in the frontend folder.
  const all = strings(join(process.cwd(), "src"));

  it("finds the copy (the scan is not silently empty)", () => {
    expect(all.length).toBeGreaterThan(150);
    expect(all.some((s) => s.text === "Something went wrong")).toBe(true);
  });

  it("breaks none of the voice rules", () => {
    const problems: string[] = [];
    for (const s of all) {
      if (ALLOWED.some((a) => a.test(s.text))) continue;
      for (const [re, why] of BANNED) if (re.test(s.text)) problems.push(`${s.file}:${s.line} "${s.text}": ${why}`);
    }
    expect(problems).toEqual([]);
  });

  it("writes buttons and menu items in sentence case", () => {
    // "Open log folder", not "Open Log Folder": a capital on the second word means Title Case.
    // A few proper nouns and design names are capitalised on purpose.
    const ok = new Set(["Night forest", "Credential Manager", "About Kanopa"]);
    const titleCase = all.filter((s) => /^[A-Z][a-z]+( [A-Z][a-z]+)+$/.test(s.text) && !ok.has(s.text));
    expect(titleCase.map((s) => `${s.file}:${s.line} "${s.text}"`)).toEqual([]);
  });

  it("would catch what it is there to catch", () => {
    const caught = (text: string) => BANNED.some(([re]) => re.test(text));
    for (const bad of ["Settings saved successfully", "Please enter a name", "Kanopa could not connect", "Done!", "Error: it broke", "Tom & Jerry", "e.g. Production", "Reading...", "My projects"])
      expect(caught(bad)).toBe(true);
    for (const good of ["Saved 2 changes to localhost.", "Kanopa couldn't connect.", "Reading…", "Your connections", "Enter a name"]) expect(caught(good)).toBe(false);
  });
});
