// Lists the words Kanopa shows people, from the interface source: JSX text, label-like props and toasts.
// A regex scan, not a parser: good enough to hold the voice rules, and it needs no compiler API.
//   node scripts/copy-strings.mjs            prints "file:line  text"
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";


function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const PROP = /\b(label|title|aria-label|placeholder|hint|error|description|confirmLabel|summary|tooltip|content)=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
const TOAST = /\btoast\(\s*(?:`([^`]*)`|"([^"]*)")/g;
const FAIL = /\b(?:title|message)\s*:\s*(?:`([^`]*)`|"([^"]*)")/g;

/** srcDir is the interface source folder; the command line uses ../src. */
export function strings(srcDir) {
  const root = srcDir;
  const found = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const rel = relative(root, file).replace(/\\/g, "/");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.includes("oxlint-disable")) return;
      for (const m of line.matchAll(PROP)) found.push({ file: rel, line: i + 1, text: m[2] ?? m[3] ?? m[4] });
      for (const m of line.matchAll(TOAST)) found.push({ file: rel, line: i + 1, text: m[1] ?? m[2] });
      for (const m of line.matchAll(FAIL)) found.push({ file: rel, line: i + 1, text: m[1] ?? m[2] });
      // JSX text between tags on one line, and text alone on a line inside an element.
      for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) found.push({ file: rel, line: i + 1, text: m[1].trim() });
      const alone = /^\s*([A-Z][^<>{}=;()]*[A-Za-z.…?:,])\s*$/.exec(line);
      if (alone && !/^\s*(import|export|return|const|let|if|else|case|type|interface)\b/.test(line)) found.push({ file: rel, line: i + 1, text: alone[1].trim() });
    });
  }
  return found.filter((s) => s.text && /[A-Za-z]{2}/.test(s.text));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const s of strings(fileURLToPath(new URL("../src", import.meta.url)))) console.log(`${s.file}:${s.line}  ${s.text}`);
}
