import { Fragment, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { rdnParts, splitDn } from "@/lib/dn";

export type EntryType = "root" | "server" | "ou" | "person" | "group" | "entry";

const TYPE_ICON: Record<EntryType, IconName> = { root: "database", server: "server", ou: "folder", person: "user", group: "users", entry: "entry" };

export function asEntryType(t: string): EntryType {
  return (t in TYPE_ICON ? t : "entry") as EntryType;
}

/** The pastel tile that marks an entry's type, the same everywhere. */
export function TypeTile({ type, size = 18, className }: { type: string; size?: number; className?: string }) {
  const t = asEntryType(type);
  return (
    <span className={cx("kn-tile", `kn-tile--${t}`, className)} style={size !== 18 ? { width: size, height: size } : undefined} aria-hidden="true">
      <Icon name={TYPE_ICON[t]} size={Math.round(size * 0.66)} strokeWidth={1.6} />
    </span>
  );
}

/* ---------- Tabs: roving tabindex, arrows move between tabs ---------- */

export interface TabsProps {
  tabs: Array<{ id: string; label: string; count?: number }>;
  value: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
}

export function Tabs({ tabs, value, onChange, label, className }: TabsProps) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(e: KeyboardEvent, i: number) {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <div ref={ref} className={cx("kn-tabs", className)} role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const sel = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            className="kn-tab"
            aria-selected={sel}
            tabIndex={sel ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.count !== undefined && <span className="kn-tab__count">{t.count.toLocaleString("en-US")}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- DnBreadcrumb: the DN root → leaf, each segment opens that entry ---------- */

export function DnBreadcrumb({ dn, onNavigate, className }: { dn: string; onNavigate?: (dn: string) => void; className?: string }) {
  const rdns = splitDn(dn);
  const segs = rdns.map((rdn, i) => ({ rdn, dn: rdns.slice(i).join(",") })).reverse();
  return (
    <nav className={cx("kn-dn", className)} aria-label="Distinguished name">
      {segs.map((s, i) => {
        const last = i === segs.length - 1;
        const [attr, val] = rdnParts(s.rdn);
        return (
          <Fragment key={s.dn}>
            {i > 0 && <Icon name="chevron-right" size={12} className="kn-dn__sep" />}
            <button
              type="button"
              className={cx("kn-dn__seg", last && "kn-dn__seg--current")}
              aria-current={last ? "location" : undefined}
              title={s.dn}
              onClick={() => !last && onNavigate?.(s.dn)}
            >
              <span className="kn-dn__attr">{attr}</span>
              {val}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/* ---------- LdifView: read-only LDIF with line numbers and the syntax colours ---------- */

type Token = [kind: string, text: string];
const LDIF_KEYWORDS = /^(version|changetype|control|add|delete|replace|increment|newrdn|deleteoldrdn|newsuperior)$/i;

/** Colours one LDIF line; prev is the value class of the line it continues. */
export function tokenizeLdifLine(line: string, prev: string | null): Token[] {
  if (line.startsWith("#")) return [["comment", line]];
  if (line === "-") return [["operator", line]];
  if (line.startsWith(" ")) return [[prev === "dn" ? "dn" : prev === "encoded" ? "encoded" : "value", line]];
  const m = /^([^:\s]+)(::|:<|:)(\s?)(.*)$/.exec(line);
  if (!m) return line.trim() ? [["error", line]] : [];
  const [, attr, sep, space, val] = m;
  const isKw = LDIF_KEYWORDS.test(attr);
  const vc = sep !== ":" ? "encoded" : /^(dn|newsuperior)$/i.test(attr) ? "dn" : isKw && /^changetype$/i.test(attr) ? "keyword" : "value";
  return [[isKw ? "keyword" : "attr", attr], ["punct", sep + space], [vc, val]];
}

/** Colours every line of an LDIF text; folded lines take the colour of the value they continue. */
export function tokenizeLdif(text: string): Token[][] {
  const out: Token[][] = [];
  let prev: string | null = null;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const toks = tokenizeLdifLine(line, prev);
    if (!line.startsWith(" ") && toks.length) prev = toks.length === 3 ? toks[2][0] : null;
    out.push(toks);
  }
  return out;
}

export function LdifView({ value, label = "LDIF", className }: { value: string; label?: string; className?: string }) {
  const lines = tokenizeLdif(value);
  return (
    <div className={cx("kn-ldif kn-ldif--readonly", className)}>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard to scroll */}
      <div className="kn-ldif__scroll" role="region" aria-label={label} tabIndex={0}>
        <div className="kn-ldif__gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="kn-ldif__code">
          <div className="kn-ldif__hl">
            {lines.map((toks, i) => (
              <div key={i} className="kn-ldif__line">
                {toks.length ? toks.map((t, j) => <span key={j} className={`kn-syn-${t[0]}`}>{t[1]}</span>) : "​"}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- SplitPane: two panes and a draggable, keyboard-operable divider ---------- */

export interface SplitPaneProps {
  start: ReactNode;
  end: ReactNode;
  defaultSize?: number;
  min?: number;
  max?: number;
  label?: string;
  className?: string;
  startClassName?: string;
}

export function SplitPane({ start, end, defaultSize = 264, min = 200, max = 480, label = "Resize the sidebar", className, startClassName }: SplitPaneProps) {
  const [size, setSize] = useState(defaultSize);
  const ref = useRef<HTMLDivElement>(null);
  const set = (n: number) => setSize(Math.max(min, Math.min(max, Math.round(n))));
  function onPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => set(ev.clientX - box.left);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    const moves: Record<string, number> = { ArrowLeft: size - step, ArrowRight: size + step, Home: min, End: max };
    if (e.key in moves) {
      e.preventDefault();
      set(moves[e.key]);
    }
  }
  return (
    <div className={cx("kn-split", className)} ref={ref}>
      <div className={cx("kn-split__pane", startClassName)} style={{ width: size }}>
        {start}
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a focusable separator is the ARIA window splitter pattern */}
      <div
        className="kn-split__handle"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuenow={size}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={label}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => set(defaultSize)}
      />
      <div className="kn-split__pane kn-split__pane--fill">{end}</div>
    </div>
  );
}

/* ---------- StatusBar ---------- */

const NONE: ReactNode[] = [];

export function StatusBar({ start = NONE, end = NONE, className }: { start?: ReactNode[]; end?: ReactNode[]; className?: string }) {
  const seg = (list: ReactNode[]) =>
    list.map((n, i) => (
      <Fragment key={i}>
        {i > 0 && <span className="kn-statusbar__div" aria-hidden="true" />}
        {n}
      </Fragment>
    ));
  return (
    <footer className={cx("kn-statusbar", className)}>
      <div className="kn-statusbar__side">{seg(start)}</div>
      <div className="kn-statusbar__side">{seg(end)}</div>
    </footer>
  );
}

/* ---------- Skeleton: loading placeholders that do not jitter ---------- */

const W = [72, 56, 88, 64, 80, 48, 76, 60];

export function Skeleton({ variant = "text", rows = 4, label = "Loading" }: { variant?: "text" | "tree" | "table"; rows?: number; label?: string }) {
  const bar = (w: number | string, extra?: React.CSSProperties) => <span className="kn-skel" style={{ width: w, ...extra }} />;
  const tile = { height: 18, borderRadius: "var(--radius-xs)" };
  return (
    <div className="kn-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) =>
        variant === "tree" ? (
          <div key={i} className="kn-skel-row" style={{ paddingLeft: i === 0 ? 0 : 26 }}>
            {bar(18, tile)}
            {bar(`${W[i % 8]}%`, { maxWidth: 160 })}
          </div>
        ) : variant === "table" ? (
          <div key={i} className="kn-skel-row kn-skel-row--table">
            {bar(140)}
            {bar(W[i % 8] * 2)}
          </div>
        ) : (
          <div key={i} className="kn-skel-line">
            {bar(i === rows - 1 ? "55%" : `${W[i % 8] + 20}%`)}
          </div>
        ),
      )}
    </div>
  );
}
