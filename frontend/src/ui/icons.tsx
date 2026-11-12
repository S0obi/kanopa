import { cx } from "./cx";

export type IconName =
  | "chevron-right" | "chevron-down" | "folder" | "user" | "users" | "server" | "database" | "entry"
  | "search" | "filter" | "plus" | "minus" | "x" | "check" | "warning" | "info" | "error" | "success"
  | "key" | "lock" | "unlock" | "refresh" | "copy" | "pencil" | "trash" | "more" | "square"
  | "eye" | "eye-off" | "plug" | "download" | "sun" | "moon" | "clock" | "chevron-left";

type Part = [tag: "path" | "circle" | "rect" | "ellipse", attrs: Record<string, string | number>];

// 16px grid, 1.5px stroke, round caps — the Kanopa glyph set.
const P: Record<IconName, Part[]> = {
  "chevron-right": [["path", { d: "M6 4l4 4-4 4" }]],
  "chevron-down": [["path", { d: "M4 6l4 4 4-4" }]],
  folder: [["path", { d: "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" }]],
  user: [["circle", { cx: 8, cy: 5.5, r: 2.5 }], ["path", { d: "M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" }]],
  users: [["circle", { cx: 6, cy: 5.5, r: 2.2 }], ["path", { d: "M1.8 13c.5-2.3 2-3.5 4.2-3.5s3.7 1.2 4.2 3.5" }], ["path", { d: "M10.4 3.6a2 2 0 0 1 0 3.8M11.6 9.6c1.4.3 2.3 1.4 2.6 3.1" }]],
  server: [["rect", { x: 2.5, y: 2.5, width: 11, height: 4.5, rx: 1.5 }], ["rect", { x: 2.5, y: 9, width: 11, height: 4.5, rx: 1.5 }], ["path", { d: "M5 4.75h.01M5 11.25h.01" }]],
  database: [["ellipse", { cx: 8, cy: 4, rx: 5, ry: 2 }], ["path", { d: "M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" }]],
  entry: [["path", { d: "M4.5 2h4.5l3 3v7.5A1.5 1.5 0 0 1 10.5 14h-6A1.5 1.5 0 0 1 3 12.5v-9A1.5 1.5 0 0 1 4.5 2zM9 2v3h3" }]],
  search: [["circle", { cx: 7, cy: 7, r: 4.5 }], ["path", { d: "M10.5 10.5L14 14" }]],
  filter: [["path", { d: "M2.5 3.5h11l-4.2 5v4.5l-2.6-1.3V8.5z" }]],
  plus: [["path", { d: "M8 3v10M3 8h10" }]],
  minus: [["path", { d: "M3 8h10" }]],
  x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
  check: [["path", { d: "M3.5 8.5l3 3 6-7" }]],
  warning: [["path", { d: "M8 2.5l6 10.5H2z" }], ["path", { d: "M8 6.5v3M8 11.3h.01" }]],
  info: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 7.5v4M8 5h.01" }]],
  error: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M6 6l4 4M10 6l-4 4" }]],
  success: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M5.5 8.2l1.8 1.8 3.2-3.6" }]],
  key: [["circle", { cx: 5.5, cy: 10.5, r: 3 }], ["path", { d: "M7.6 8.4L13 3M11 5l1.5 1.5" }]],
  lock: [["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }], ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" }]],
  unlock: [["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }], ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 4.8-1" }]],
  refresh: [["path", { d: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" }]],
  copy: [["rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }], ["path", { d: "M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" }]],
  pencil: [["path", { d: "M10.5 2.8l2.7 2.7-7.7 7.7H2.8v-2.7z" }]],
  trash: [["path", { d: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" }]],
  more: [["path", { d: "M3.5 8h.01M8 8h.01M12.5 8h.01" }]],
  square: [["rect", { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1 }]],
  // Drawn for Kanopa in the same style (show/hide password, test connection, fetch).
  eye: [["path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  "eye-off": [["path", { d: "M6.6 3.7c.4-.1.9-.2 1.4-.2 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.3M4.2 4.9C2.5 6.1 1.5 8 1.5 8S4 12.5 8 12.5c1.2 0 2.3-.4 3.2-1M2.5 2.5l11 11" }], ["path", { d: "M6.6 6.6a2 2 0 0 0 2.8 2.8" }]],
  plug: [["path", { d: "M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v2.5" }]],
  download: [["path", { d: "M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13.5h10" }]],
  sun: [["circle", { cx: 8, cy: 8, r: 2.8 }], ["path", { d: "M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" }]],
  "chevron-left": [["path", { d: "M10 4l-4 4 4 4" }]],
  clock: [["circle", { cx: 8, cy: 8, r: 5.5 }], ["path", { d: "M8 5v3.2l2 1.3" }]],
  moon: [["path", { d: "M13 9.4A5.3 5.3 0 0 1 6.6 3 5.3 5.3 0 1 0 13 9.4z" }]],
};

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, label, className }: IconProps) {
  const parts = P[name] ?? P.entry;
  return (
    <svg
      className={cx("kn-icon", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {parts.map(([Tag, attrs], i) => (
        <Tag key={i} {...attrs} />
      ))}
    </svg>
  );
}

export interface LogoProps {
  /** Mark height in px (default 20). The wordmark scales with it. */
  size?: number;
  variant?: "color" | "mono";
  wordmark?: boolean;
  className?: string;
}

/** The Branch K: a K whose arms are directory branches ending in fern and pine nodes. */
export function Logo({ size = 20, variant = "color", wordmark, className }: LogoProps) {
  const mono = variant === "mono";
  const mark = (
    <svg
      className={cx("kn-logo__mark", mono && "kn-logo__mark--mono", !wordmark && className)}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden={wordmark ? true : undefined}
      role={wordmark ? undefined : "img"}
      aria-label={wordmark ? undefined : "Kanopa"}
    >
      <path className="kn-logo__stem" d="M19 10v44 M19 35L41 16 M27 28L41 49" fill="none" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
      <circle className="kn-logo__top" cx={43} cy={14} r={8} />
      <circle className="kn-logo__bottom" cx={43} cy={51} r={7.5} />
    </svg>
  );
  if (!wordmark) return mark;
  return (
    <span
      className={cx("kn-logo", mono && "kn-logo--mono", className)}
      role="img"
      aria-label="Kanopa"
      style={{ gap: `${Math.round(size * 0.2)}px`, fontSize: `${Math.round(size * 0.68)}px` }}
    >
      {mark}
      <span className="kn-wordmark" aria-hidden="true">Kanopa</span>
    </span>
  );
}
