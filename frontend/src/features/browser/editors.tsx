import { useWindow } from "@/lib/useWindow";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AllowedAttribute, EntryAttribute, EntryView, SessionInfo } from "@/api/backend";
import { Banner, Button, Dialog, Icon, TextField, cx } from "@/ui";
import { cleanValues, diff, isChange, pendingOf, useChanges, valueErrors, type PendingAttr, type ValueKind } from "./changes";

/** The attribute an editor works on: one the entry has, or one the person is adding. */
export interface EditTarget {
  name: string;
  kind: ValueKind;
  singleValue: boolean;
  required: boolean;
  /** Values as read (descriptions for binary and password values). */
  values: string[];
  /** Ids of binary and password values. */
  ids: string[];
}

export function targetOf(a: EntryAttribute | AllowedAttribute): EditTarget {
  const read = "values" in a;
  return {
    name: a.name,
    kind: (a.kind as ValueKind) || "text",
    singleValue: a.singleValue,
    required: a.required,
    values: read ? (a.values ?? []) : [],
    ids: read ? (a.ids ?? []) : [],
  };
}

const hidden = (k: ValueKind) => k === "binary" || k === "password";

/** Why a typed password can't be staged yet: missing, or the confirmation differs. */
export function passwordErrors(password: string, confirm: string, required: boolean): string[] {
  if (!password) return required ? ["Constraint violation (19) — enter a password, or cancel to keep the current one."] : [];
  if (password !== confirm) return ["The passwords don't match. Type the same password in both fields."];
  return [];
}

interface PasswordPairProps {
  label?: ReactNode;
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
  hint?: ReactNode;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * A new password typed twice. The server hashes it with its own scheme (Password Modify when it
 * offers it), so there is no scheme to pick.
 */
export function PasswordPair({ label = "New password", value, confirm, onChange, onConfirm, hint, invalid, autoFocus, className }: PasswordPairProps) {
  const mismatch = !!confirm && value !== confirm;
  return (
    <div className={cx("grid grid-cols-2 gap-3", className)}>
      <TextField
        label={label}
        type="password"
        autoComplete="new-password"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        error={invalid ? " " : undefined}
        hint={hint}
      />
      <TextField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        error={mismatch || (invalid && value !== confirm) ? "Doesn't match the password." : undefined}
      />
    </div>
  );
}

/** What the hint under a password says about the link and the hashing. */
export function passwordHint(security: string): string {
  return /^(LDAPS|StartTLS)$/.test(security)
    ? `Sent over ${security}. The server hashes it with its own scheme and never shows it again.`
    : "The server hashes it with its own scheme and never shows it again.";
}

/** The PendingAttr for target with the given wanted values (ids for hidden kinds). */
function pendingFor(t: EditTarget, after: string[], password?: string): PendingAttr {
  if (!hidden(t.kind)) return { name: t.name, kind: t.kind, before: t.values, after };
  const shown: Record<string, string> = {};
  t.ids.forEach((id, i) => (shown[id] = t.values[i] ?? id));
  return { name: t.name, kind: t.kind, before: t.ids, after, shown, password: password || undefined };
}

interface EditorProps {
  connectionId: string;
  entry: EntryView;
  target: EditTarget;
  session: SessionInfo;
  onClose: () => void;
}

/** ValueEditor: every value of one attribute, the diff against the server, Add to changes. */
export function ValueEditor({ connectionId, entry, target: t, session, onClose }: EditorProps) {
  const stage = useChanges((s) => s.stage);
  const pending = useChanges((s) => pendingOf(s.byConnection[connectionId], entry.dn, t.name));
  const [values, setValues] = useState<string[]>(() => {
    const start = pending && !hidden(t.kind) ? pending.after : t.values;
    return start.length ? [...start] : [""];
  });
  const [kept, setKept] = useState<string[]>(() => (pending && hidden(t.kind) ? pending.after : t.ids));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);

  const isPassword = t.kind === "password";
  const isBinary = t.kind === "binary";
  const draft = isPassword || isBinary ? pendingFor(t, kept, password) : pendingFor(t, cleanValues(values));
  const errors = useMemo(() => {
    // Removing values needs no new password; setting one needs it twice.
    if (isPassword) return passwordErrors(password, confirm, kept.length === t.ids.length);
    if (isBinary) return [];
    return valueErrors({ name: t.name, kind: t.kind, singleValue: t.singleValue, baseDn: session.baseDn }, values);
  }, [isPassword, isBinary, password, confirm, kept, t, values, session.baseDn]);
  const rows = diff(draft);
  // Thousands of values (a group's members) draw only the rows in view, in boxes that scroll by themselves.
  const { attach: attachValues, start: valuesFrom, end: valuesTo, before: valuesBefore, after: valuesAfter, windowed: valuesWindowed } = useWindow<HTMLDivElement>(values.length, 38, { self: true });
  const { attach: attachDiff, start: diffFrom, end: diffTo, before: diffBefore, after: diffAfter, windowed: diffWindowed } = useWindow<HTMLDivElement>(rows.length, 25, { self: true, overscan: 20 });
  const canAdd = !isPassword && !isBinary && !(t.singleValue && values.length >= 1);
  const encrypted = session.security === "LDAPS" || session.security === "StartTLS";

  function save() {
    setTried(true);
    if (errors.length) return;
    stage(connectionId, entry, draft);
    onClose();
  }
  function deleteAttribute() {
    stage(connectionId, entry, pendingFor(t, []));
    onClose();
  }

  const setValue = (i: number, v: string) => setValues((vs) => vs.map((x, j) => (j === i ? v : x)));
  const metaText = t.singleValue ? "Single value" : `${values.length} ${values.length === 1 ? "value" : "values"}`;

  return (
    <Dialog
      title={
        <>
          Edit <code className="!text-[16px] !leading-6">{t.name}</code>
        </>
      }
      description={<code className="kn-changes__dn">{entry.dn}</code>}
      onClose={onClose}
      width={560}
      footerStart={
        t.values.length > 0 && !t.required ? (
          <Button variant="ghost" onClick={deleteAttribute}>
            Delete attribute
          </Button>
        ) : undefined
      }
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Add to changes", onClick: save }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          // Enter in a value adds the edit to the changes, as a form would.
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            save();
          }
        }}
      >
        {isPassword && (
          <PasswordPair
            value={password}
            confirm={confirm}
            onChange={setPassword}
            onConfirm={setConfirm}
            autoFocus
            invalid={tried && errors.length > 0}
            hint={passwordHint(session.security)}
          />
        )}
        {isPassword && !encrypted && (
          <Banner tone="warning" title="Not encrypted.">
            This connection uses neither LDAPS nor StartTLS: the new password crosses the network as plain text.
          </Banner>
        )}
        {isBinary && (
          <div className="flex flex-col gap-1.5">
            <span className="type-label">Values</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {t.ids.map((id, i) => {
                const on = kept.includes(id);
                return (
                  <li key={id} className="flex items-center gap-2">
                    <span className={cx("kn-attrs__binary grow", !on && "line-through")}>{t.values[i]}</span>
                    <Button size="sm" variant="ghost" onClick={() => setKept((k) => (on ? k.filter((x) => x !== id) : [...k, id]))}>
                      {on ? "Remove" : "Keep"}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <span className="text-[12px] leading-4 text-ink-muted">Kanopa removes binary values; replacing one from a file comes later.</span>
          </div>
        )}
        {!isPassword && !isBinary && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="type-label" id="ve-values">
                Values
              </span>
              <span className="text-[12px] leading-4 text-ink-muted">{metaText}</span>
            </div>
            <div
              role="group"
              aria-labelledby="ve-values"
              ref={attachValues}
              className={cx("flex flex-col", valuesWindowed ? "max-h-[320px] overflow-auto" : "gap-1.5")}
              style={valuesWindowed ? { paddingTop: valuesBefore, paddingBottom: valuesAfter } : undefined}
            >
              {values.slice(valuesFrom, valuesTo).map((v, k) => {
                const i = valuesFrom + k;
                return (
                <div key={i} className={cx("flex items-center gap-1.5", valuesWindowed && "h-[38px] shrink-0")}>
                  <div className={cx("kn-input kn-input--mono grow", tried && errors.length > 0 && "kn-input--attention")}>
                    <input
                      ref={i === 0 ? firstInput : undefined}
                      autoFocus={i === 0}
                      value={v}
                      aria-label={`${t.name} value ${i + 1}`}
                      aria-invalid={tried && errors.length > 0 ? true : undefined}
                      placeholder={t.kind === "dn" ? `uid=…,ou=people,${session.baseDn}` : undefined}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setValue(i, e.target.value)}
                    />
                  </div>
                  {values.length > 1 && (
                    <Button variant="ghost" size="sm" icon="x" label={`Remove value ${i + 1}`} onClick={() => setValues((vs) => vs.filter((_, j) => j !== i))} />
                  )}
                </div>
                );
              })}
            </div>
            {canAdd && (
              <button type="button" className="kn-add-value" onClick={() => setValues((vs) => [...vs, ""])}>
                <Icon name="plus" size={12} strokeWidth={1.75} />
                Add value
              </button>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="type-label">Change against the server</span>
          <div
            className={cx("kn-diff", diffWindowed && "max-h-[240px] overflow-auto")}
            aria-label="Change against the server"
            ref={attachDiff}
            style={diffWindowed ? { paddingTop: diffBefore, paddingBottom: diffAfter } : undefined}
          >
            {rows.slice(diffFrom, diffTo).map((r, k) => (
              <div key={diffFrom + k} className="kn-diff__row" data-sign={r.sign} style={diffWindowed ? { height: 25, flex: "none" } : undefined}>
                <span className="kn-diff__sign" aria-hidden="true">
                  {r.sign}
                </span>
                <span className="kn-diff__value">
                  <span className="kn-sr">{r.sign === "+" ? "added: " : r.sign === "−" ? "removed: " : "unchanged: "}</span>
                  {r.value}
                </span>
              </div>
            ))}
            {!isChange(draft) && <div className="kn-diff__empty">No change yet — the values match the server.</div>}
          </div>
        </div>
        {tried && errors.length > 0 && (
          <Banner tone="danger" title="Check the values.">
            {errors.join(" ")}
          </Banner>
        )}
      </form>
    </Dialog>
  );
}

interface AddProps {
  connectionId: string;
  entry: EntryView;
  session: SessionInfo;
  onClose: () => void;
}

/** AttributeSuggest: attributes the object classes allow and the entry lacks, with a first value. */
export function AddAttributeDialog({ connectionId, entry, session, onClose }: AddProps) {
  const stage = useChanges((s) => s.stage);
  const pendingSet = useChanges((s) => s.byConnection[connectionId]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<AllowedAttribute | null>(null);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);

  // Picking an attribute moves on to its value.
  useEffect(() => {
    if (picked) valueRef.current?.focus();
  }, [picked]);

  const options = (entry.allowed ?? []).filter(
    (a) => !pendingOf(pendingSet, entry.dn, a.name) && (!q.trim() || a.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const rdn = entry.dn.split(",")[0];
  const kind = (picked?.kind as ValueKind) || "text";
  const errors: string[] = !picked
    ? ["Choose an attribute from the list."]
    : kind === "password"
      ? passwordErrors(value, confirm, true)
      : !value.trim()
      ? [`Enter a value for ${picked.name}.`]
      : valueErrors({ name: picked.name, kind, singleValue: picked.singleValue, baseDn: session.baseDn }, [value]);

  function save() {
    setTried(true);
    if (errors.length || !picked) return;
    const t = targetOf(picked);
    stage(connectionId, entry, kind === "password" ? pendingFor(t, [], value) : pendingFor(t, [value.trim()]));
    onClose();
  }

  const tag = (a: AllowedAttribute) => (a.required ? "required" : a.kind === "dn" ? "optional · DN" : a.kind === "password" ? "optional · password" : "optional");

  return (
    <Dialog
      title="Add attribute"
      description={
        <>
          Attributes the object classes of <code>{rdn}</code> allow and it does not have yet.
        </>
      }
      onClose={onClose}
      width={560}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Add to changes", onClick: save }}
    >
      <TextField icon="search" type="search" aria-label="Find an attribute" placeholder="Find an attribute" value={q} autoFocus mono onChange={(e) => setQ(e.target.value)} />
      <div role="listbox" aria-label="Allowed attributes" className="kn-options">
        {options.map((a) => (
          <button
            key={a.name}
            type="button"
            role="option"
            aria-selected={picked?.name === a.name}
            className="kn-option"
            onClick={() => {
              setPicked(a);
              setTried(false);
            }}
          >
            <code>{a.name}</code>
            <span className="kn-option__tag">{tag(a)}</span>
          </button>
        ))}
        {options.length === 0 && (
          <div className="kn-diff__empty">{q.trim() ? `No allowed attribute matches “${q.trim()}”.` : "The object classes allow no other attribute."}</div>
        )}
      </div>
      {picked && kind === "password" && (
        <div
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        >
          <PasswordPair
            label={
              <>
                Value for <code>{picked.name}</code>
              </>
            }
            value={value}
            confirm={confirm}
            onChange={setValue}
            onConfirm={setConfirm}
            autoFocus
            invalid={tried && errors.length > 0}
            hint={passwordHint(session.security)}
          />
        </div>
      )}
      {picked && kind !== "password" && (
        <TextField
          ref={valueRef}
          label={
            <>
              Value for <code>{picked.name}</code>
            </>
          }
          mono
          placeholder={kind === "dn" ? `uid=…,ou=people,${session.baseDn}` : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
      )}
      {tried && errors.length > 0 && (
        <Banner tone="danger" title="Not added yet.">
          {errors.join(" ")}
        </Banner>
      )}
    </Dialog>
  );
}
