import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { create } from "zustand";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { Button, Kbd, type ButtonProps } from "./controls";
import { detectPlatform, type Platform } from "@/lib/platform";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ---------- Modal: scrim, focus kept inside, Esc closes, focus restored ---------- */

export interface ModalProps {
  onClose?: () => void;
  labelledBy: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  children: ReactNode;
  /** Element to focus first; defaults to the first [autofocus] or focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Modal({ onClose, labelledBy, describedBy, role = "dialog", className, children, initialFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const first = initialFocus?.current ?? panel?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
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
      <div ref={ref} role={role} aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} className={className}>
        {children}
      </div>
    </div>
  );
}

/* ---------- Dialog: title, body, actions in the platform's order ---------- */

export interface DialogAction {
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

export interface DialogProps {
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
    <Modal onClose={onClose} labelledBy={titleId} describedBy={description ? descId : undefined} className={cx("kn-dialog", className)}>
      <div style={width ? { width } : undefined}>
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

export interface ConfirmDialogProps {
  tone: "warning" | "danger";
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  platform?: Platform;
}

export function ConfirmDialog({ tone, title, children, confirmLabel, onConfirm, onCancel, busy, platform = detectPlatform() }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = (
    <Button key="c" size="lg" onClick={onCancel} data-autofocus={tone === "danger" ? true : undefined}>
      Cancel
    </Button>
  );
  const confirm = (
    <Button key="o" size="lg" variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} busy={busy} data-autofocus={tone === "danger" ? undefined : true}>
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
  | { id: string; label: string; icon?: IconName; shortcut?: string[]; danger?: boolean; disabled?: boolean }
  | { separator: true };

export interface MenuProps {
  items: MenuItem[];
  onSelect?: (id: string) => void;
  onClose?: () => void;
  platform?: Platform;
  autoFocus?: boolean;
  label?: string;
  className?: string;
  id?: string;
}

export function Menu({ items, onSelect, onClose, platform, autoFocus, label, className, id }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  useEffect(() => {
    if (autoFocus) focusable()[0]?.focus();
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
    <div className={cx("kn-menu", className)} role="menu" ref={ref} onKeyDown={onKey} aria-label={label} id={id}>
      {items.map((it, i) =>
        "separator" in it ? (
          <div key={`s${i}`} className="kn-menu__sep" role="separator" />
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
            {it.shortcut && <Kbd keys={it.shortcut} platform={platform} />}
          </div>
        ),
      )}
    </div>
  );
}

/** An icon button that opens a menu below it; outside clicks and Esc close it and return focus. */
export function MenuButton({ label, items, onSelect, platform }: { label: string; items: MenuItem[]; onSelect: (id: string) => void; platform?: Platform }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
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
        icon="more"
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
      {open && <Menu id={menuId} items={items} label={label} platform={platform} autoFocus onClose={close} onSelect={onSelect} className="absolute top-8 right-0 z-20 min-w-[180px]" />}
    </div>
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

export interface EmptyStateProps {
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
