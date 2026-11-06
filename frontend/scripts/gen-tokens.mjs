// Generates src/theme/tokens.css from src/theme/tokens.json (the Kanopa design system).
//   npm run tokens
// The CSS variables keep the design system's names (--surface, --space-4, --radius-sm…),
// which the ported component CSS uses, and Tailwind gets matching utilities
// (bg-surface, text-ink-muted, rounded-sm, shadow-md, font-mono…).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const tokens = JSON.parse(readFileSync(here("../src/theme/tokens.json"), "utf8"));
const THEME = "light"; // Night forest (dark) is parked until after v0.1.0.

const colors = tokens.color.tokens;
const byName = Object.fromEntries(colors.map((t) => [t.name, t]));
function colorValue(name, seen = new Set()) {
  const t = byName[name];
  if (!t) throw new Error(`Unknown colour token ${name}`);
  const v = typeof t.value === "string" ? t.value : t.value[THEME] ?? Object.values(t.value)[0];
  const alias = /^\{(.+)\}$/.exec(v);
  if (!alias) return v;
  if (seen.has(name)) throw new Error(`Alias loop at ${name}`);
  seen.add(name);
  return colorValue(alias[1], seen);
}
const themed = (t) => (typeof t.value === "string" ? t.value : t.value[THEME] ?? Object.values(t.value)[0]);

const root = [];
const theme = ["  --color-*: initial;"];
const themeInline = [];

for (const t of colors) {
  root.push(`  --${t.name}: ${colorValue(t.name)};`);
  themeInline.push(`  --color-${t.name}: var(--${t.name});`);
}
for (const t of tokens.spacing.tokens) root.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.size.tokens) root.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.radius.tokens) theme.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.shadow.tokens) {
  // focus-ring is used as a box-shadow by the components, not as a Tailwind shadow size.
  if (t.name === "focus-ring") root.push(`  --focus-ring: ${themed(t)};`);
  else theme.push(`  --${t.name}: ${themed(t)};`);
}
theme.push(`  --font-sans: ${tokens.type.families.sans};`);
theme.push(`  --font-mono: ${tokens.type.families.mono};`);

// Type styles become CSS classes: .text-body, .text-label, .text-code…
const styles = [];
for (const group of tokens.type.groups) {
  for (const s of group.styles) {
    const decl = [
      `font-family: var(--font-${group.family});`,
      `font-size: ${s.fontSize};`,
      `line-height: ${s.lineHeight};`,
      `font-weight: ${s.fontWeight};`,
      s.letterSpacing ? `letter-spacing: ${s.letterSpacing};` : "",
      s.name === "overline" ? "text-transform: uppercase;" : "",
    ].filter(Boolean);
    styles.push(`@utility type-${s.name} {\n  ${decl.join("\n  ")}\n}`);
  }
}

const out = `/* Kanopa — generated from tokens.json by scripts/gen-tokens.mjs. Do not edit. */

:root {
${root.join("\n")}
}

@theme static {
${theme.join("\n")}
}

@theme inline {
${themeInline.join("\n")}
}

${styles.join("\n\n")}
`;
writeFileSync(here("../src/theme/tokens.css"), out);
console.log(`Wrote src/theme/tokens.css (${colors.length} colours, theme ${THEME}).`);
