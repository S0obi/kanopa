import { useLayoutEffect, useState } from "react";

interface Options {
  /** Rows drawn beyond the edges of the view, so a fast scroll does not show blanks. */
  overscan?: number;
  /** Lists this short are drawn whole: windowing buys nothing and costs a layout. */
  threshold?: number;
  /** The element that holds the rows is itself the scrolling box (else the nearest scrolling ancestor is). */
  self?: boolean;
}

interface Windowed<T extends HTMLElement> {
  /** Goes on the element that holds the rows (a callback ref). */
  attach: (el: T | null) => void;
  /** The rows to draw are [start, end). */
  start: number;
  end: number;
  /** The height of the rows not drawn above and below, for padding. */
  before: number;
  after: number;
  /** False when every row is drawn. */
  windowed: boolean;
}

/** The scrolling box around el: the nearest ancestor that scrolls vertically, else the page. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll" || o === "overlay") return p;
  }
  return null;
}

/**
 * Windows a list of fixed-height rows: only the ones in view (and a few more) are drawn, so a group
 * with 5,000 members opens as fast as one with five. The rows must all be `rowHeight` tall.
 * Without layout (jsdom) a view of 600px is assumed.
 */
export function useWindow<T extends HTMLElement>(count: number, rowHeight: number, { overscan = 12, threshold = 60, self = false }: Options = {}): Windowed<T> {
  const [el, setEl] = useState<T | null>(null);
  const windowed = count > threshold;
  const [range, setRange] = useState({ start: 0, end: Math.min(count, threshold) });

  useLayoutEffect(() => {
    if (!el || !windowed) return;
    const scroller = self ? el : scrollParent(el);
    const target: HTMLElement | Window = scroller ?? window;
    const measure = () => {
      const top = scroller ? scroller.scrollTop : window.scrollY;
      const height = (scroller ? scroller.clientHeight : window.innerHeight) || 600;
      // Where the rows begin inside the scrolling box.
      const offset = self ? 0 : el.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0) + top;
      const first = Math.max(0, Math.floor((top - offset) / rowHeight) - overscan);
      const last = Math.min(count, Math.ceil((top - offset + height) / rowHeight) + overscan);
      setRange((r) => (r.start === first && r.end === Math.max(last, first) ? r : { start: first, end: Math.max(last, first) }));
    };
    measure();
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (scroller) ro?.observe(scroller);
    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [el, count, rowHeight, overscan, windowed, self]);

  if (!windowed) return { attach: setEl, start: 0, end: count, before: 0, after: 0, windowed: false };
  const end = Math.min(range.end, count);
  const start = Math.min(range.start, end);
  return { attach: setEl, start, end, before: start * rowHeight, after: (count - end) * rowHeight, windowed: true };
}
