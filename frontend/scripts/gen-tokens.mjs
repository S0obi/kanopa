// Generates src/theme/tokens.css from src/theme/tokens.json (the Kanopa design system).
//   npm run tokens
// The CSS variables keep the design system's names (--surface, --space-4, --radius-sm…),
// which the ported component CSS uses, and Tailwind gets matching utilities
// (bg-surface, text-ink-muted, rounded-sm, shadow-md, font-mono…).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const tokens = JSON.parse(readFileSync(here("../src/theme/tokens.json"), "utf8"));
// Clearing is "light", Night forest is "dark". :root holds Clearing; [data-theme="dark"] overrides it.
const THEMES = ["light", "dark"];

const colors = tokens.color.tokens;
const byName = Object.fromEntries(colors.map((t) => [t.name, t]));
function colorValue(name, theme, seen = new Set()) {
  const t = byName[name];
  if (!t) throw new Error(`Unknown colour token ${name}`);
  const v = typeof t.value === "string" ? t.value : t.value[theme] ?? Object.values(t.value)[0];
  const alias = /^\{(.+)\}$/.exec(v);
  if (!alias) return v;
  if (seen.has(name)) throw new Error(`Alias loop at ${name}`);
  seen.add(name);
  return colorValue(alias[1], theme, seen);
}
const themed = (t, theme) => (typeof t.value === "string" ? t.value : t.value[theme] ?? Object.values(t.value)[0]);
// A token that has a value for every theme must not silently fall back to another theme's value.
for (const t of colors) {
  if (typeof t.value !== "string") for (const th of THEMES) if (!(th in t.value)) throw new Error(`Colour token ${t.name} has no ${th} value`);
}

const root = [];
const dark = [];
const theme = ["  --color-*: initial;"];
const themeInline = [];

for (const t of colors) {
  root.push(`  --${t.name}: ${colorValue(t.name, "light")};`);
  const night = colorValue(t.name, "dark");
  if (night !== colorValue(t.name, "light")) dark.push(`  --${t.name}: ${night};`);
  themeInline.push(`  --color-${t.name}: var(--${t.name});`);
}
for (const t of tokens.spacing.tokens) root.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.size.tokens) root.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.radius.tokens) theme.push(`  --${t.name}: ${t.value};`);
for (const t of tokens.shadow.tokens) {
  // focus-ring is used as a box-shadow by the components, not as a Tailwind shadow size.
  if (t.name === "focus-ring") root.push(`  --focus-ring: ${themed(t, "light")};`);
  else theme.push(`  --${t.name}: ${themed(t, "light")};`);
  if (themed(t, "dark") !== themed(t, "light")) dark.push(`  --${t.name}: ${themed(t, "dark")};`);
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

[data-theme="dark"] {
${dark.join("\n")}
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
console.log(`Wrote src/theme/tokens.css (${colors.length} colours, themes ${THEMES.join(" and ")}).`);
