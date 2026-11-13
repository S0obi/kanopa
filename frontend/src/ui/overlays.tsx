import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { Button, Kbd, type ButtonProps } from "./controls";
import { detectPlatform, type Platform } from "@/lib/platform";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ---------- Modal: scrim, focus kept inside, Esc closes, focus restored ---------- */

interface ModalProps {
  onClose?: () => void;
  labelledBy: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  children: ReactNode;
  /** Element to focus first; defaults to the first [autofocus] or focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  style?: CSSProperties;
}

export function Modal({ onClose, labelledBy, describedBy, role = "dialog", className, children, initialFocus, style }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  // What had focus before the dialog opened, read on the first render: by the time effects run,
  // a field with autoFocus inside the dialog already has it.
  const [before] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    const panel = ref.current;
    // A field rendered with autoFocus already has focus (React sets it, without the attribute): keep it.
    const now = document.activeElement;
    const focused = !initialFocus && now && panel?.contains(now);
    // An explicit choice, else the first field (where the person types), else the first control.
    const first =
      initialFocus?.current ??
      panel?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ??
      panel?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    if (!focused) first?.focus();
    return () => before?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="kn-scrim z-30" onKeyDown={onKeyDown}>
      <div ref={ref} role={role} aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} className={className} style={style}>
        {children}
      </div>
    </div>
  );
}

/* ---------- Dialog: title, body, actions in the platform's order ---------- */

interface DialogAction {
  label: ReactNode;
  onClick?: () => void;
  variant?: ButtonProps["variant"];
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
}

/** macOS: Cancel then the primary action (rightmost). Windows: the primary action first. */
export function orderActions<T>(primary: T | undefined, secondary: T | undefined, platform: Platform): T[] {
  const list = platform === "mac" ? [secondary, primary] : [primary, secondary];
  return list.filter((x): x is T => x !== undefined);
}

interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
  footerStart?: ReactNode;
  onClose?: () => void;
  width?: number | string;
  platform?: Platform;
  className?: string;
}

export function Dialog({ title, description, children, primaryAction, secondaryAction, footerStart, onClose, width, platform = detectPlatform(), className }: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const btn = (a: DialogAction | undefined, primary: boolean) =>
    a && (
      <Button key={primary ? "p" : "s"} size="lg" variant={a.variant ?? (primary ? "primary" : "secondary")} onClick={a.onClick} disabled={a.disabled} busy={a.busy} type={a.type}>
        {a.label}
      </Button>
    );
  return (
    <Modal onClose={onClose} labelledBy={titleId} describedBy={description ? descId : undefined} className={cx("kn-dialog", className)} style={width ? { width } : undefined}>
      <div>
        <div className="kn-dialog__head">
          <h2 className="kn-dialog__title" id={titleId}>
            {title}
          </h2>
          {onClose && <Button variant="ghost" size="sm" icon="x" label="Close" onClick={onClose} />}
        </div>
        {description && (
          <p className="kn-dialog__desc" id={descId}>
            {description}
          </p>
        )}
        {children && <div className="kn-dialog__body">{children}</div>}
        {(primaryAction || secondaryAction || footerStart) && (
          <div className="kn-dialog__foot">
            {footerStart && <div className="kn-dialog__start">{footerStart}</div>}
            {orderActions(btn(primaryAction, true), btn(secondaryAction, false), platform)}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------- ConfirmDialog: the design's question with a tinted icon tile ---------- */

interface ConfirmDialogProps {
  tone: "warning" | "danger";
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** The action can't be taken (the dialog says why); Cancel stays. */
  confirmDisabled?: boolean;
  platform?: Platform;
}

export function ConfirmDialog({ tone, title, children, confirmLabel, onConfirm, onCancel, busy, confirmDisabled, platform = detectPlatform() }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = (
    <Button key="c" size="lg" onClick={onCancel} data-autofocus={tone === "danger" ? true : undefined}>
      Cancel
    </Button>
  );
  const confirm = (
    <Button key="o" size="lg" variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} busy={busy} disabled={confirmDisabled} data-autofocus={tone === "danger" ? undefined : true}>
      {confirmLabel}
    </Button>
  );
  return (
    <Modal role="alertdialog" onClose={onCancel} labelledBy={titleId} describedBy={bodyId} className="kn-dialog w-[500px]">
      <div className="flex gap-3 p-6">
        <span className={cx("grid size-8 shrink-0 place-items-center rounded-xs", tone === "danger" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")} aria-hidden="true">
          <Icon name={tone === "danger" ? "trash" : "warning"} />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 id={titleId} className="type-title m-0">
            {title}
          </h2>
          <div id={bodyId}>{children}</div>
        </div>
      </div>
      <div className="kn-dialog__foot">{orderActions(confirm, cancel, platform)}</div>
    </Modal>
  );
}

/* ---------- Menu and MenuButton ---------- */

export type MenuItem =
  | { id: string; label: string; icon?: IconName; shortcut?: string[]; danger?: boolean; disabled?: boolean; /** Why a disabled item is off. */ hint?: string }
  | { separator: true }
  /** A title over the items that follow, not something to pick. */
  | { heading: string };

interface MenuProps {
  items: MenuItem[];
  onSelect?: (id: string) => void;
  onClose?: () => void;
  platform?: Platform;
  autoFocus?: boolean;
  label?: string;
  className?: string;
  id?: string;
}

function Menu({ items, onSelect, onClose, platform, autoFocus, label, className, id }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [autoFocus]);
  function onKey(e: KeyboardEvent) {
    const list = focusable();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (list[i + 1] ?? list[0])?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (list[i - 1] ?? list[list.length - 1])?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      onClose?.();
    }
  }
  const pick = (it: Extract<MenuItem, { id: string }>) => {
    if (it.disabled) return;
    onClose?.();
    onSelect?.(it.id);
  };
  return (
    <div className={cx("kn-menu", className)} role="menu" tabIndex={-1} ref={ref} onKeyDown={onKey} aria-label={label} id={id}>
      {items.map((it, i) =>
        "separator" in it ? (
          <hr key={`s${i}`} className="kn-menu__sep" />
        ) : "heading" in it ? (
          <div key={`h${i}`} className="kn-menu__heading" role="presentation">
            {it.heading}
          </div>
        ) : (
          <div
            key={it.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={it.disabled || undefined}
            className={cx("kn-menu__item", it.danger && "is-danger")}
            onClick={() => pick(it)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick(it);
              }
            }}
          >
            <span className="kn-menu__icon">{it.icon && <Icon name={it.icon} size={14} />}</span>
            <span className="kn-menu__label">{it.label}</span>
            {it.hint && <span className="kn-menu__hint">{it.hint}</span>}
            {it.shortcut && !it.hint && <Kbd keys={it.shortcut} platform={platform} />}
          </div>
        ),
      )}
    </div>
  );
}

type MenuPlacement = { top?: number; bottom?: number; right: number };

/**
 * An icon button that opens a menu below it (above it when there is no room).
 * The menu is drawn in a layer of its own, so a scrolling container (a table) never clips it
 * or grows a scrollbar for it. Outside clicks, Esc, scrolling and resizing close it.
 */
export function MenuButton({ label, items, onSelect, platform, icon = "more", size }: { label: string; items: MenuItem[]; onSelect: (id: string) => void; platform?: Platform; icon?: IconName; size?: ButtonProps["size"] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Below the button, right edges aligned; flipped above when the window is too short.
  useLayoutEffect(() => {
    if (!open || !button.current) return setPlace(null);
    const r = button.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    const height = layer.current?.offsetHeight ?? 0;
    const below = r.bottom + 4;
    setPlace(height && below + height > window.innerHeight - 8 && r.top - 4 - height > 8 ? { bottom: window.innerHeight - r.top + 4, right } : { top: below, right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !layer.current?.contains(t)) setOpen(false);
    };
    const dismiss = (e: Event) => {
      if (e.type === "scroll" && layer.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="relative" ref={wrap}>
      <Button
        ref={button}
        variant="ghost"
        size={size}
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open &&
        createPortal(
          <div ref={layer} className="fixed z-40" style={place ?? { top: 0, right: 0, visibility: "hidden" }}>
            <Menu id={menuId} items={items} label={label} platform={platform} autoFocus={!!place} onClose={close} onSelect={onSelect} className="min-w-[180px]" />
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * A menu at a point: a right-click, or beside a row for Shift+F10. It stays inside the window,
 * and outside clicks, Esc, scrolling and resizing close it.
 */
export function ContextMenu({ x, y, items, label, onSelect, onClose, platform }: { x: number; y: number; items: MenuItem[]; label: string; onSelect: (id: string) => void; onClose: () => void; platform?: Platform }) {
  const layer = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = layer.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const left = x + w > window.innerWidth - 8 ? Math.max(8, x - w) : x;
    const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    setPlace({ left, top });
  }, [x, y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!layer.current?.contains(e.target as Node)) onClose();
    };
    const dismiss = (e: Event) => {
      if (e.type === "scroll" && layer.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={layer}
      className="fixed z-40"
      style={place ?? { left: x, top: y, visibility: "hidden" }}
      // A right-click on the menu itself opens nothing else.
      onContextMenu={(e) => e.preventDefault()}
    >
      <Menu items={items} label={label} platform={platform} autoFocus={!!place} onClose={onClose} onSelect={onSelect} className="min-w-[220px]" />
    </div>,
    document.body,
  );
}

/* ---------- Toasts ---------- */

type ToastTone = "neutral" | "success" | "warning" | "info" | "danger";
interface ToastItem {
  id: number;
  message: ReactNode;
  tone?: ToastTone;
}

interface ToastState {
  toasts: ToastItem[];
  show: (message: ReactNode, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

let nextToast = 1;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (message, tone = "success") => set((s) => ({ toasts: [...s.toasts, { id: nextToast++, message, tone }].slice(-3) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const TOAST_ICON: Record<ToastTone, IconName> = { neutral: "check", success: "success", warning: "warning", info: "info", danger: "error" };

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = item.tone ?? "neutral";
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={cx("kn-toast", `kn-toast--${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={TOAST_ICON[tone]} />
      <span className="kn-toast__text">{item.message}</span>
      <button type="button" className="kn-toast__close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/** Renders the toasts shown with useToasts().show(…). Mount once. */
export function ToastRegion() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="kn-toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

/* ---------- EmptyState ---------- */

interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  icon?: IconName;
  tone?: "root" | "server" | "ou" | "person" | "group" | "entry" | "neutral";
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ title, children, icon, tone = "neutral", actions, compact, className }: EmptyStateProps) {
  return (
    <div className={cx("kn-empty", compact && "kn-empty--compact", className)}>
      {icon && (
        <span className={cx("kn-empty__tile", `kn-tile--${tone}`)} aria-hidden="true">
          <Icon name={icon} size={compact ? 20 : 24} />
        </span>
      )}
      <h3 className="kn-empty__title">{title}</h3>
      {children && <p className="kn-empty__body">{children}</p>}
      {actions && <div className="kn-empty__actions">{actions}</div>}
    </div>
  );
}
