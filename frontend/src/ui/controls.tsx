import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
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

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  options: Array<string | { value: string; label: string; disabled?: boolean }>;
  fieldClassName?: string;
}

export function Select({ label, hint, error, mono, options, className, fieldClassName, id, ...rest }: SelectProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o, disabled: false } : o));
  return (
    <Field id={fid} label={label} hint={hint} error={error} className={fieldClassName}>
      <div className={cx("kn-input", "kn-select", mono && "kn-input--mono", className)} style={{ position: "relative" }}>
        <select id={fid} aria-describedby={error || hint ? `${fid}-msg` : undefined} {...rest}>
          {opts.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={14} />
      </div>
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
