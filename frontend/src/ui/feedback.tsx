import { Children, cloneElement, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { Button, Kbd, Spinner } from "./controls";
import type { Platform } from "@/lib/platform";

const TONE_ICON: Record<string, IconName> = { success: "success", warning: "warning", danger: "error", info: "info" };

/* ---------- Banner ---------- */

export interface BannerProps {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  /** Shows a spinner instead of the tone icon (for work in progress). */
  busy?: boolean;
  className?: string;
}

export function Banner({ tone = "info", title, children, actions, onDismiss, busy, className }: BannerProps) {
  return (
    <div className={cx("kn-banner", `kn-banner--${tone}`, className)} role={tone === "danger" ? "alert" : "status"}>
      {busy ? <Spinner /> : <Icon name={TONE_ICON[tone] ?? "info"} />}
      <div className="kn-banner__text">
        {title && <div className="kn-banner__title">{title}</div>}
        {children && <div className="kn-banner__body">{children}</div>}
      </div>
      {(actions || onDismiss) && (
        <div className="kn-banner__actions">
          {actions}
          {onDismiss && <Button variant="ghost" size="sm" icon="x" label="Dismiss" onClick={onDismiss} />}
        </div>
      )}
    </div>
  );
}

/* ---------- Badge ---------- */

export interface BadgeProps {
  tone?: "neutral" | "moss" | "success" | "warning" | "danger" | "info" | "heather" | "lichen" | "bark";
  mono?: boolean;
  icon?: IconName | false;
  children?: ReactNode;
  title?: string;
  className?: string;
}

export function Badge({ tone = "neutral", mono, icon, children, title, className }: BadgeProps) {
  const glyph = icon === false ? null : icon ?? TONE_ICON[tone];
  return (
    <span className={cx("kn-badge", `kn-badge--${tone}`, mono && "kn-badge--mono", className)} title={title}>
      {glyph && <Icon name={glyph} size={12} strokeWidth={1.75} />}
      {children}
    </span>
  );
}

/* ---------- StatusIndicator: connection state as shape + word + colour ---------- */

const STATUS = { connected: "Connected", connecting: "Connecting…", disconnected: "Disconnected", error: "Bind failed" };

export interface StatusIndicatorProps {
  status: keyof typeof STATUS;
  label?: string;
  detail?: string;
  className?: string;
}

export function StatusIndicator({ status, label, detail, className }: StatusIndicatorProps) {
  return (
    <span className={cx("kn-status", `kn-status--${status}`, className)} role="status">
      {status === "error" ? <Icon name="error" size={12} strokeWidth={1.75} /> : <span className="kn-status__dot" aria-hidden="true" />}
      <span className="kn-status__label">{label ?? STATUS[status]}</span>
      {detail && <span className="kn-status__detail">{detail}</span>}
    </span>
  );
}

/* ---------- Tooltip ---------- */

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  shortcut?: string[];
  placement?: "top" | "bottom";
  delay?: number;
  platform?: Platform;
}

export function Tooltip({ content, children, shortcut, placement = "top", delay = 500, platform }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (now: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), now ? 0 : delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const child = Children.only(children);
  return (
    <span
      className={cx("kn-tip", `kn-tip--${placement}`)}
      onPointerEnter={() => show(false)}
      onPointerLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
      onKeyDown={(e) => e.key === "Escape" && hide()}
    >
      {cloneElement(child, { "aria-describedby": open ? id : undefined })}
      {open && (
        <span className="kn-tip__bubble" role="tooltip" id={id}>
          {content}
          {shortcut && <Kbd keys={shortcut} platform={platform} />}
        </span>
      )}
    </span>
  );
}
