import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TextField, cx, type IconName } from "@/ui";
import { accept, suggest, tokenAt } from "./complete";

interface Props {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  /** Attribute names of the server's schema. */
  names: string[];
  mode: "filter" | "list";
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  icon?: IconName;
  trailing?: ReactNode;
  autoFocus?: boolean;
  /** Called on Enter when no suggestion is being chosen. */
  onEnter?: () => void;
  fieldClassName?: string;
}

/**
 * A text field that suggests attribute names from the schema at the caret: ArrowDown / ArrowUp
 * choose, Tab or Enter (after choosing) accept, Esc closes. Enter with nothing chosen submits.
 */
export function Completing({ label, value, onChange, names, mode, hint, error, placeholder, icon, trailing, autoFocus, onEnter, fieldClassName }: Props) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(-1);

  const token = tokenAt(value, caret, mode);
  const options = token ? suggest(names, token.text) : [];
  // An exact, lone match has nothing more to offer.
  const open = options.length > 0 && !(options.length === 1 && options[0] === token?.text) && dismissed !== `${value}|${caret}`;
  const current = open && active >= 0 && active < options.length ? active : -1;
  // The suggestions sit right under the input, not under the hint or message that follows it.
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const box = input.current?.parentElement;
    if (open && box) setTop(box.offsetTop + box.offsetHeight + 4);
  }, [open]);

  function choose(name: string) {
    if (!token) return;
    const next = accept(value, token, name, mode);
    onChange(next.value);
    setActive(-1);
    // The caret moves once React has put the new text in the field.
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (open && e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (open && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      choose(options[Math.max(current, 0)]!);
    } else if (open && e.key === "Enter" && current >= 0) {
      e.preventDefault();
      choose(options[current]!);
    } else if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(`${value}|${caret}`);
    } else if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onEnter();
    }
  }

  return (
    <div className="relative">
      <TextField
        ref={input}
        label={label}
        mono
        icon={icon}
        trailing={trailing}
        value={value}
        placeholder={placeholder}
        hint={hint}
        error={error}
        autoFocus={autoFocus}
        fieldClassName={fieldClassName}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(-1);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div id={listId} role="listbox" aria-label="Attribute names" className="kn-options absolute inset-x-0 z-20 shadow-md" style={{ top }}>
          {options.map((name, i) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the field keeps focus and handles the keyboard
            <div
              key={name}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === current}
              className={cx("kn-option font-mono text-[12px]", i === current && "bg-surface-hover")}
              // The field keeps focus: a click on an option must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(name)}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
