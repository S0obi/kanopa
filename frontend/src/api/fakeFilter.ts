import type { FilterCheck } from "./backend";

/**
 * A port of internal/ldapx/filter.go for the fake backend: the same checks, the same messages and
 * positions, plus an evaluator so the fake directory can answer searches. The real checks run in Go.
 */

type Node =
  | { op: "and" | "or"; items: Node[] }
  | { op: "not"; item: Node }
  | { op: "eq" | "ge" | "le" | "approx"; attr: string; value: string }
  | { op: "present"; attr: string }
  | { op: "substr"; attr: string; parts: string[] }
  | { op: "ext" };

interface Failure {
  pos: number;
  msg: string;
}

class Parser {
  i = 0;
  constructor(readonly r: string[]) {}
  peek() {
    return this.i < this.r.length ? this.r[this.i]! : "";
  }
  fail(msg: string): Failure {
    return { pos: this.i, msg };
  }
  space() {
    while (this.i < this.r.length && /\s/.test(this.r[this.i]!)) this.i++;
  }

  filter(): Node | Failure {
    const open = this.i;
    this.i++; // (
    let node: Node;
    const c = this.peek();
    if (c === "&" || c === "|") {
      this.i++;
      const items: Node[] = [];
      while (this.peek() === "(") {
        const n = this.filter();
        if ("msg" in n) return n;
        items.push(n);
      }
      if (!items.length) return this.fail(`${c} needs at least one filter after it, like (${c}(uid=ada)(uid=alan)).`);
      node = { op: c === "&" ? "and" : "or", items };
    } else if (c === "!") {
      this.i++;
      if (this.peek() !== "(") return this.fail("! needs one filter after it, like (!(uid=ada)).");
      const n = this.filter();
      if ("msg" in n) return n;
      node = { op: "not", item: n };
    } else {
      const n = this.item();
      if ("msg" in n) return n;
      node = n;
    }
    if (this.peek() !== ")" || this.i >= this.r.length) {
      if (this.i >= this.r.length) return this.fail(`Missing ) to close the ( at position ${open + 1}.`);
      return this.fail(`Expected ) to close the ( at position ${open + 1}.`);
    }
    this.i++; // )
    return node;
  }

  item(): Node | Failure {
    const start = this.i;
    while (this.i < this.r.length && /[A-Za-z0-9._;-]/.test(this.r[this.i]!)) this.i++;
    const attr = this.r.slice(start, this.i).join("");
    const c = this.peek();
    if (c === ":") return this.extensible();
    if (!attr) return this.i >= this.r.length ? this.fail("Expected an attribute name, like uid.") : this.fail(`Expected an attribute name here, like uid, not ${JSON.stringify(c)}.`);
    if (c === "=") {
      this.i++;
      return this.value(attr, "eq", true);
    }
    const next = this.r[this.i + 1];
    if ((c === "~" || c === ">" || c === "<") && next === "=") {
      this.i += 2;
      return this.value(attr, c === "~" ? "approx" : c === ">" ? "ge" : "le", false);
    }
    return this.i >= this.r.length ? this.fail("Expected = after the attribute name.") : this.fail("Expected = (or ~=, >=, <=) after the attribute name.");
  }

  extensible(): Node | Failure {
    while (this.peek() === ":") {
      this.i++;
      if (this.peek() === "=") {
        this.i++;
        const v = this.value("", "eq", false);
        return "msg" in v ? v : { op: "ext" };
      }
      const word = this.i;
      while (this.i < this.r.length && /[A-Za-z0-9._;-]/.test(this.r[this.i]!)) this.i++;
      if (this.i === word) return this.fail("Expected dn, a matching rule or := here.");
    }
    return this.fail("Expected := in an extensible match.");
  }

  value(attr: string, op: "eq" | "ge" | "le" | "approx", wildcards: boolean): Node | Failure {
    const raw: string[] = []; // pieces between unescaped *, escapes decoded
    let piece = "";
    let star = false;
    while (this.i < this.r.length) {
      const c = this.r[this.i]!;
      if (c === ")") break;
      if (c === "(") return this.fail("A ( inside a value is written \\28.");
      if (c === "*") {
        if (!wildcards) return this.fail("* works only after =. Write a literal * as \\2a.");
        star = true;
        raw.push(piece);
        piece = "";
      } else if (c === "\\") {
        const hex = this.r.slice(this.i + 1, this.i + 3).join("");
        if (this.i + 2 >= this.r.length || !/^[0-9a-fA-F]{2}$/.test(hex)) return this.fail("A \\ is followed by two hex digits, like \\28 for (. Write a literal \\ as \\5c.");
        piece += String.fromCharCode(parseInt(hex, 16));
        this.i += 2;
      } else piece += c;
      this.i++;
    }
    if (!star) return { op, attr, value: piece };
    raw.push(piece);
    if (raw.length === 2 && raw[0] === "" && raw[1] === "") return { op: "present", attr };
    return { op: "substr", attr, parts: raw };
  }
}

function parse(text: string): { node: Node } | { failure: Failure } {
  const p = new Parser(Array.from(text));
  p.space();
  if (p.i >= p.r.length) return { failure: { pos: 0, msg: "Type a filter, such as (objectClass=*)." } };
  if (p.peek() !== "(") return { failure: { pos: p.i, msg: "A filter is wrapped in parentheses, like (uid=ada)." } };
  const n = p.filter();
  if ("msg" in n) return { failure: n };
  p.space();
  if (p.i < p.r.length) return { failure: p.fail("Unexpected text after the filter. Combine filters with (&…) or (|…).") };
  return { node: n };
}

/** The problem with a filter, and where; null when it is valid. */
export function fakeCheckFilter(text: string): FilterCheck | null {
  const r = parse(text);
  if ("node" in r) return null;
  return { message: r.failure.msg, position: r.failure.pos };
}

/** Compiles a valid filter into a test over an entry's attributes (case-insensitive names and values); null when invalid. */
export function fakeFilterMatcher(text: string): ((attrs: Record<string, string[]>) => boolean) | null {
  const r = parse(text);
  if (!("node" in r)) return null;
  const get = (attrs: Record<string, string[]>, name: string): string[] => {
    const k = Object.keys(attrs).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? attrs[k]! : [];
  };
  const run = (n: Node, attrs: Record<string, string[]>): boolean => {
    switch (n.op) {
      case "and":
        return n.items.every((x) => run(x, attrs));
      case "or":
        return n.items.some((x) => run(x, attrs));
      case "not":
        return !run(n.item, attrs);
      case "present":
        return /^objectclass$/i.test(n.attr) || get(attrs, n.attr).length > 0;
      case "eq":
      case "approx":
        return get(attrs, n.attr).some((v) => v.toLowerCase() === n.value.toLowerCase());
      case "ge":
        return get(attrs, n.attr).some((v) => v.toLowerCase() >= n.value.toLowerCase());
      case "le":
        return get(attrs, n.attr).some((v) => v.toLowerCase() <= n.value.toLowerCase());
      case "substr":
        return get(attrs, n.attr).some((v) => {
          let rest = v.toLowerCase();
          const parts = n.parts.map((x) => x.toLowerCase());
          const first = parts[0]!;
          if (!rest.startsWith(first)) return false;
          rest = rest.slice(first.length);
          for (const mid of parts.slice(1, -1)) {
            const at = rest.indexOf(mid);
            if (at < 0) return false;
            rest = rest.slice(at + mid.length);
          }
          return rest.endsWith(parts[parts.length - 1]!) && rest.length >= parts[parts.length - 1]!.length;
        });
      case "ext":
        return false;
    }
  };
  return (attrs) => run(r.node, attrs);
}
