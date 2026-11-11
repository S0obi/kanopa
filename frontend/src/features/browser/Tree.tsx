import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useBackend } from "@/api/backend";
import { rdnParts } from "@/lib/dn";
import { Button, Icon, Spinner, TypeTile, cx } from "@/ui";
import { marks as marksOf, newChildren, useChanges, type Mark } from "./changes";
import { dnKey, useBrowser, visibleRows, type TreeRow } from "./store";

const ROW = 28; // --size-row
const OVERSCAN = 12;

/** The visible height; a page without layout (tests) gets a sensible default. */
const heightOf = (el: HTMLElement) => el.clientHeight || 600;

/** A DOM id for a row, stable across renders. */
function rowId(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return `tree-${(h >>> 0).toString(36)}`;
}

/**
 * The directory tree. Only the rows in view are rendered, so a parent with thousands of
 * children scrolls smoothly. Focus stays on the tree; the active row is aria-activedescendant.
 */
export function DirectoryTree() {
  const backend = useBackend();
  const { nodes, roots, expanded, selected, select, toggle, expand, collapse, loadMore, session } = useBrowser();
  const pending = useChanges((s) => (session ? s.byConnection[session.connectionId] : undefined));
  const added = useMemo(() => newChildren(pending), [pending]);
  const marks = useMemo(() => marksOf(pending), [pending]);
  const rows = useMemo(() => visibleRows(nodes, roots, expanded, added), [nodes, roots, expanded, added]);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [active, setActive] = useState<string | null>(null);

  const selectedKey = selected ? dnKey(selected) : null;
  // The keyboard follows the selection when it changes elsewhere (breadcrumb, DN links).
  const [followed, setFollowed] = useState(selectedKey);
  if (followed !== selectedKey) {
    setFollowed(selectedKey);
    setActive(selectedKey);
  }
  const activeIndex = Math.max(0, rows.findIndex((r) => r.key === (active ?? selectedKey)));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: heightOf(el) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the active row in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !rows.length) return;
    const top = activeIndex * ROW;
    const h = heightOf(el);
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + h) el.scrollTop = top + ROW - h;
    // Programmatic scrolling fires no scroll event everywhere: follow it here too.
    setView({ top: el.scrollTop, height: h });
  }, [activeIndex, rows.length]);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);

  function activate(row: TreeRow | undefined) {
    // "Reading…" and error lines are not stops for the keyboard.
    if (!row || row.kind === "loading" || row.kind === "error") return;
    setActive(row.key);
    if (row.kind === "node") select(row.state.node.dn);
  }

  function onKeyDown(e: KeyboardEvent) {
    const row = rows[activeIndex];
    if (!row) return;
    const go = (i: number) => {
      e.preventDefault();
      activate(rows[Math.max(0, Math.min(rows.length - 1, i))]);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(activeIndex + 1);
      case "ArrowUp":
        return go(activeIndex - 1);
      case "Home":
        return go(0);
      case "End":
        return go(rows.length - 1);
      case "PageDown":
        return go(activeIndex + Math.floor(view.height / ROW));
      case "PageUp":
        return go(activeIndex - Math.floor(view.height / ROW));
      case "ArrowRight":
        if (row.kind !== "node" || !row.state.node.hasChildren) return;
        e.preventDefault();
        if (row.open) activate(rows[activeIndex + 1]);
        else void expand(backend, row.state.node.dn);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (row.kind === "node" && row.open) collapse(row.state.node.dn);
        else {
          const parent = row.kind === "node" ? row.parent : row.kind === "more" ? row.parent : null;
          const i = rows.findIndex((r) => r.key === parent);
          if (i >= 0) activate(rows[i]);
        }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (row.kind === "more") void loadMore(backend, nodes[row.parent].node.dn);
        else if (row.kind === "node" && row.state.node.hasChildren) void toggle(backend, row.state.node.dn);
        return;
    }
  }

  const activeRow = rows[activeIndex];
  return (
    <div
      ref={scroller}
      className="kn-tree kn-tree--virtual"
      role="tree"
      aria-label="Directory tree"
      tabIndex={0}
      aria-activedescendant={activeRow ? rowId(activeRow.key) : undefined}
      onKeyDown={onKeyDown}
      // Rows come and go as the tree scrolls: focus stays on the tree, never on a row.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        scroller.current?.focus();
      }}
      onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: heightOf(e.currentTarget) })}
    >
      <div style={{ height: rows.length * ROW, position: "relative" }}>
        {rows.slice(first, last).map((row, i) => (
          <Row
            key={row.key}
            row={row}
            top={(first + i) * ROW}
            selected={row.key === selectedKey}
            active={row.key === activeRow?.key}
            mark={marks[row.key]}
            onSelect={() => activate(row)}
            onToggle={() => row.kind === "node" && void toggle(backend, row.state.node.dn)}
            onMore={() => row.kind === "more" && void loadMore(backend, nodes[row.parent].node.dn)}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  row: TreeRow;
  mark?: Mark;
  top: number;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMore: () => void;
}

const MARKS: Record<Mark, string> = { new: "new", deleted: "delete", renamed: "rename" };

function Row({ row, mark, top, selected, active, onSelect, onToggle, onMore }: RowProps) {
  const style = { position: "absolute" as const, top, left: 0, right: 0, paddingLeft: `calc(var(--space-5) * ${row.depth} + var(--space-1))` };
  if (row.kind === "loading")
    return (
      <div className="kn-tree__row kn-tree__row--note" style={style} role="none">
        <span className="kn-tree__twisty" />
        <Spinner size={14} />
        <span className="kn-tree__label text-ink-muted">Reading…</span>
      </div>
    );
  if (row.kind === "error")
    return (
      <div className="kn-tree__row kn-tree__row--note" style={style} role="none" title={row.message}>
        <span className="kn-tree__twisty" />
        <Icon name="error" size={14} className="text-danger-ink" />
        <span className="kn-tree__label text-danger-ink">{row.message}</span>
      </div>
    );
  if (row.kind === "more")
    return (
      <div id={rowId(row.key)} className={cx("kn-tree__row kn-tree__row--more", active && "is-active")} style={style} role="treeitem" tabIndex={-1} aria-level={row.depth + 1} aria-selected={false}>
        <span className="kn-tree__twisty" />
        <Button variant="ghost" size="sm" tabIndex={-1} busy={row.loading} onClick={onMore} className="kn-tree__more">
          {row.remaining !== null ? `Show ${row.remaining.toLocaleString("en-US")} more` : "Show more"}
        </Button>
      </div>
    );

  const n = row.state.node;
  const [attr, value] = rdnParts(n.rdn);
  const total = row.state.total;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the tree handles the keyboard for its rows
    <div
      id={rowId(row.key)}
      className={cx("kn-tree__row", active && "is-active", mark && `is-${mark}`)}
      style={style}
      role="treeitem"
      tabIndex={-1}
      aria-level={row.depth + 1}
      aria-expanded={n.hasChildren ? row.open : undefined}
      aria-selected={selected}
      aria-label={`${n.sub ? `${n.rdn}, ${n.sub}` : n.rdn}${mark ? `, pending ${MARKS[mark]}` : ""}`}
      title={n.dn}
      onClick={onSelect}
      onDoubleClick={() => n.hasChildren && onToggle()}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- ArrowRight / ArrowLeft open and close */}
      <span
        className="kn-tree__twisty"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          if (n.hasChildren) onToggle();
        }}
      >
        {n.hasChildren && <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.75} />}
      </span>
      <TypeTile type={n.type} />
      <span className="kn-tree__label">
        <code className="kn-tree__rdn">
          <span className="kn-tree__attr">{attr}</span>
          {value}
        </code>
        {n.sub && <span className="kn-tree__sub">{n.sub}</span>}
      </span>
      {n.referral && <span className="kn-tree__badge">referral</span>}
      {mark && <span className={cx("kn-tree__badge", `kn-tree__badge--${mark}`)}>{MARKS[mark]}</span>}
      {row.open && total !== undefined && <span className="kn-tree__count">{total.toLocaleString("en-US")}</span>}
    </div>
  );
}
