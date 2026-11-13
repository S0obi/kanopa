import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { detectPlatform, type Platform } from "@/lib/platform";

/* ---------- Button ---------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "secondary" | "primary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  /** Required when the button has an icon and no children. */
  label?: string;
  ref?: Ref<HTMLButtonElement>;
  /**
   * Shows a spinner in place of the icon and ignores clicks. A busy button stays focusable
   * (aria-disabled, not disabled), so keyboard focus is not lost while the work runs.
   */
  busy?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, label, busy, className, children, type, disabled, onClick, ...rest }: ButtonProps) {
  const iconOnly = !!icon && (children === null || children === undefined);
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type ?? "button"}
      {...rest}
      disabled={busy ? undefined : disabled}
      aria-disabled={busy || undefined}
      onClick={busy ? (e) => e.preventDefault() : onClick}
      className={cx("kn-btn", `kn-btn--${variant}`, `kn-btn--${size}`, iconOnly && "kn-btn--icon", busy && "is-busy", className)}
      aria-label={iconOnly ? label : rest["aria-label"]}
      title={iconOnly ? label : rest.title}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={iconSize} /> : icon && <Icon name={icon} size={iconSize} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx("kn-icon kn-spin", className)} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M8 2a6 6 0 1 0 6 6" />
    </svg>
  );
}

/* ---------- Kbd: platform-aware shortcut ---------- */

type KeyName = "mod" | "shift" | "alt" | "ctrl" | "enter" | "esc" | "tab" | "backspace" | "delete";
const KEYS: Record<Platform, Record<KeyName, string>> = {
  mac: { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↩", backspace: "⌫", delete: "⌦", esc: "esc", tab: "⇥" },
  windows: { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", backspace: "Backspace", delete: "Del", esc: "Esc", tab: "Tab" },
};
const MAC_ORDER: Record<string, number> = { ctrl: 0, alt: 1, shift: 2, mod: 3 };

interface KbdProps {
  keys: string[];
  platform?: Platform;
  className?: string;
}

/** Writes a shortcut the platform's way: ⌘⇧F on macOS, Ctrl+Shift+F on Windows. */
export function Kbd({ keys, platform = detectPlatform(), className }: KbdProps) {
  const list = [...keys];
  if (platform === "mac") list.sort((a, b) => (MAC_ORDER[a.toLowerCase()] ?? 9) - (MAC_ORDER[b.toLowerCase()] ?? 9));
  return (
    <span className={cx("kn-kbd", className)} data-platform={platform}>
      {list.map((k, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && platform === "windows" && <span className="kn-kbd__plus">+</span>}
          <kbd>{KEYS[platform][k.toLowerCase() as KeyName] ?? k.toUpperCase()}</kbd>
        </span>
      ))}
    </span>
  );
}

/* ---------- Field, TextField, Select ---------- */

interface FieldProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

function Field({ id, label, hint, error, className, children }: FieldProps) {
  return (
    <div className={cx("kn-field", !!error && "kn-field--error", className)}>
      {label && (
        <label className="kn-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <div className="kn-field__error" id={`${id}-msg`}>
          <Icon name="error" size={14} />
          {error}
        </div>
      ) : (
        hint && (
          <div className="kn-field__hint" id={`${id}-msg`}>
            {hint}
          </div>
        )
      )}
    </div>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  icon?: IconName;
  trailing?: ReactNode;
  fieldClassName?: string;
}

export function TextField({ label, hint, error, mono, icon, trailing, className, fieldClassName, id, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <Field id={fid} label={label} hint={hint} error={error} className={fieldClassName}>
      <div className={cx("kn-input", mono && "kn-input--mono", className)}>
        {icon && <Icon name={icon} />}
        <input
          id={fid}
          spellCheck={mono ? false : undefined}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${fid}-msg` : undefined}
          {...rest}
        />
        {trailing}
      </div>
    </Field>
  );
}

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "defaultValue" | "children"> {
  ref?: Ref<HTMLButtonElement>;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  options: Array<string | SelectOption>;
  /** The chosen value. Leave it out to let the field keep its own (starting at defaultValue, else the first option). */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  fieldClassName?: string;
}

/** Where the list sits: below the field, or above it when the window is too short. */
type ListPlace = { left: number; minWidth: number; top?: number; bottom?: number };

/**
 * A dropdown drawn in Kanopa's own style (the browser's list could not be themed). It follows the
 * select-only combobox pattern: the button keeps focus, the list is a listbox of options chosen with
 * the arrow keys, Home, End, Enter or a click, and typing a letter jumps to an option. The list is
 * drawn in a layer of its own, so a dialog never clips it. Esc closes the list, not the dialog.
 */
export function Select({ label, hint, error, mono, options, className, fieldClassName, id, value, defaultValue, onChange, disabled, onKeyDown, onBlur, ref, ...rest }: SelectProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  const listId = `${fid}-list`;
  const opts: SelectOption[] = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const [inner, setInner] = useState(defaultValue ?? opts[0]?.value ?? "");
  const current = value ?? inner;
  const selected = opts.findIndex((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<ListPlace | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const enabled = (i: number) => i >= 0 && i < opts.length && !opts[i].disabled;
  /** The next enabled option from i in a direction, staying put at either end. */
  const step = (i: number, dir: 1 | -1) => {
    for (let k = i + dir; k >= 0 && k < opts.length; k += dir) if (enabled(k)) return k;
    return i;
  };
  const firstEnabled = () => step(-1, 1);
  const lastEnabled = () => step(opts.length, -1);

  function openList() {
    setActive(enabled(selected) ? selected : firstEnabled());
    setOpen(true);
  }
  function choose(i: number) {
    if (!enabled(i)) return;
    if (value === undefined) setInner(opts[i].value);
    onChange?.(opts[i].value);
    setOpen(false);
  }

  // Below the field, as wide as it; flipped above when the window is too short.
  useLayoutEffect(() => {
    if (!open || !field.current) return setPlace(null);
    const r = field.current.getBoundingClientRect();
    const height = layer.current?.offsetHeight ?? 0;
    const below = r.bottom + 4;
    const flip = height > 0 && below + height > window.innerHeight - 8 && r.top - 4 - height > 8;
    setPlace({ left: r.left, minWidth: r.width, ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: below }) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!field.current?.contains(t) && !layer.current?.contains(t)) setOpen(false);
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

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented || disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "Tab") return setOpen(false);
    const printable = k.length === 1 && k !== " ";
    if (printable) {
      // Typing "an" jumps to the first option that starts with it.
      const now = Date.now();
      const text = now - typed.current.at > 600 ? k.toLowerCase() : typed.current.text + k.toLowerCase();
      typed.current = { text, at: now };
      const from = open ? active : selected;
      const order = [...opts.keys()].map((i) => (i + Math.max(from, 0) + (text.length === 1 ? 1 : 0)) % opts.length);
      const hit = order.find((i) => enabled(i) && opts[i].label.toLowerCase().startsWith(text));
      if (hit === undefined) return;
      if (!open) setOpen(true);
      setActive(hit);
      return;
    }
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (k) {
      case "ArrowDown":
        e.preventDefault();
        setActive(step(active, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(step(active, -1));
        break;
      case "Home":
        e.preventDefault();
        setActive(firstEnabled());
        break;
      case "End":
        e.preventDefault();
        setActive(lastEnabled());
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (enabled(active)) choose(active);
        else setOpen(false);
        break;
      case "Escape":
        // Closes the list and nothing else: a dialog around the field stays open.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
    }
  }

  return (
    <Field id={fid} label={label} hint={hint} error={error} className={fieldClassName}>
      <div ref={field} className={cx("kn-input", "kn-select", mono && "kn-input--mono", open && "is-open", className)} style={{ position: "relative" }}>
        <button
          {...rest}
          ref={(el) => {
            button.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          type="button"
          id={fid}
          role="combobox"
          className="kn-select__trigger"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={error || hint ? `${fid}-msg` : undefined}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onKey}
          onBlur={(e) => {
            setOpen(false);
            onBlur?.(e);
          }}
        >
          {opts[selected]?.label ?? ""}
        </button>
        <Icon name="chevron-down" size={14} />
      </div>
      {open &&
        createPortal(
          <div ref={layer} className="fixed z-40" style={place ?? { top: 0, left: 0, visibility: "hidden" }}>
            <div role="listbox" id={listId} aria-label={typeof label === "string" ? label : undefined} className={cx("kn-listbox", mono && "kn-listbox--mono")}>
              {opts.map((o, i) => (
                <div
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  aria-disabled={o.disabled || undefined}
                  data-active={i === active || undefined}
                  className="kn-listbox__option"
                  // The option the arrow keys are on stays in view.
                  ref={(el) => {
                    if (i === active) el?.scrollIntoView?.({ block: "nearest" });
                  }}
                  // Focus stays on the button (the list names the active option), so a mouse press must not move it.
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => enabled(i) && setActive(i)}
                  onClick={() => choose(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      choose(i);
                    }
                  }}
                >
                  <span>{o.label}</span>
                  {i === selected && <Icon name="check" size={14} />}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </Field>
  );
}

/* ---------- Checkbox & Switch ---------- */

interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

export function Checkbox({ label, className, disabled, ...rest }: CheckProps) {
  return (
    <label className={cx("kn-check", disabled && "is-disabled", className)}>
      <input type="checkbox" disabled={disabled} {...rest} />
      <span className="kn-check__box" aria-hidden="true">
        <Icon name="check" size={12} strokeWidth={2} />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Switch({ label, className, disabled, ...rest }: CheckProps) {
  return (
    <label className={cx("kn-switch", disabled && "is-disabled", className)}>
      {/* oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a native checkbox exposes its checked state */}
      <input type="checkbox" role="switch" disabled={disabled} {...rest} />
      <span className="kn-switch__track" aria-hidden="true">
        <span className="kn-switch__thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

/* ---------- Segmented: a small set of exclusive choices drawn as one control ---------- */

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, id }: SegmentedProps<T>) {
  const autoId = useId();
  const lid = `${id ?? autoId}-label`;
  return (
    <div className="kn-field">
      <span className="kn-field__label" id={lid}>
        {label}
      </span>
      <div role="group" aria-labelledby={lid} className="kn-segmented">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
