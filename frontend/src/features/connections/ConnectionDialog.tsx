import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { errorText, useBackend, type SavedConnection, type TestResult } from "@/api/backend";
import { credentialStoreName, detectPlatform, isMod, type Platform } from "@/lib/platform";
import { Banner, Button, Checkbox, Icon, Kbd, Modal, Segmented, Select, TextField, orderActions } from "@/ui";
import {
  advancedSummary, emptyConnectionForm, formFromSaved, saveFormSchema, toParams, toSaveRequest, type ConnectionForm as Form,
} from "./schema";
import { securityForUrl, urlForSecurity, type Security } from "./url";

type Status =
  | { kind: "idle" }
  | { kind: "testing"; url: string }
  | { kind: "fetching"; url: string }
  | { kind: "saving" }
  | { kind: "done"; result: TestResult; action: "test" | "fetch" }
  | { kind: "saveFailed"; message: string };

const SECURITY_OPTIONS: Array<{ value: Security; label: string }> = [
  { value: "ldaps", label: "LDAPS" },
  { value: "starttls", label: "StartTLS" },
  { value: "none", label: "None" },
];

// Fields checked before a test; the name only matters for saving.
const TEST_FIELDS = ["url", "bindDn", "baseDn", "timeoutSeconds", "pageSize"] as const;

export interface ConnectionDialogProps {
  mode: "new" | "edit";
  /** The connection being edited. */
  connection?: SavedConnection;
  /** Why the dialog opened: "badPassword" asks for the current password. */
  reason?: "badPassword" | "";
  platform?: Platform;
  onClose: () => void;
  /** `password` is the one typed when it was not to be saved, so connecting needs no second prompt. */
  onSaved: (saved: SavedConnection, connectNow: boolean, password: string) => void;
  /** Initial values for a new connection (tests). */
  defaultValues?: Partial<Form>;
}

/** The connection form from the design (ConnectionDialog): new and edit, with Test connection. */
export function ConnectionDialog({ mode, connection, reason = "", platform = detectPlatform(), onClose, onSaved, defaultValues }: ConnectionDialogProps) {
  const backend = useBackend();
  const isEdit = mode === "edit" && !!connection;
  const badPassword = isEdit && reason === "badPassword";
  const store = credentialStoreName(platform);
  const titleId = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showPassword, setShowPassword] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const { control, register, handleSubmit, watch, setValue, getValues, trigger, formState } = useForm<Form>({
    resolver: zodResolver(saveFormSchema),
    defaultValues: isEdit ? formFromSaved(connection) : { ...emptyConnectionForm, ...defaultValues },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const errors = formState.errors;
  const [bind, security, timeoutSeconds, pageSize, referrals, savePassword] = watch(["bind", "security", "timeoutSeconds", "pageSize", "referrals", "savePassword"]);

  // A result describes the settings it was made with: any edit clears it, and stops a running test.
  useEffect(() => {
    const sub = watch((_, { name }) => {
      if (name === undefined) return;
      abort.current?.abort();
      setStatus((s) => (s.kind === "idle" || s.kind === "saving" ? s : { kind: "idle" }));
    });
    return () => sub.unsubscribe();
  }, [watch]);
  useEffect(() => () => abort.current?.abort(), []);

  async function run(action: "test" | "fetch", values: Form) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const params = toParams(values, isEdit ? connection.id : "");
    setStatus({ kind: action === "test" ? "testing" : "fetching", url: params.url });
    try {
      const result = action === "test" ? await backend.testConnection(params, ctrl.signal) : await backend.fetchBaseDn(params, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (action === "fetch" && result.ok) {
        setValue("baseDn", result.baseDn, { shouldValidate: true });
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "done", result, action });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setStatus({
        kind: "done",
        action,
        result: { ok: false, title: "Kanopa couldn't run the test.", message: errorText(e), code: 0, elapsedMs: 0, namingContexts: null, baseDn: "", vendor: "" },
      });
    }
  }

  async function onTest() {
    const fields = getValues("bind") === "simple" ? TEST_FIELDS : TEST_FIELDS.filter((f) => f !== "bindDn");
    if (await trigger([...fields])) await run("test", getValues());
  }

  async function onFetchBase() {
    const fields = getValues("bind") === "simple" ? (["url", "bindDn"] as const) : (["url"] as const);
    if (await trigger([...fields])) await run("fetch", getValues());
  }

  // One save at a time, whatever starts it (buttons, Enter, Ctrl+Enter, a repeating key),
  // and none after a successful one: the dialog is closing.
  const saving = useRef<"idle" | "saving" | "saved">("idle");
  const save = async (connectNow: boolean) => {
    if (saving.current !== "idle") return;
    saving.current = "saving";
    let ok = false;
    try {
      await handleSubmit(async (values) => {
        abort.current?.abort();
        setStatus({ kind: "saving" });
        try {
          const saved = await backend.saveConnection(toSaveRequest(values, isEdit ? connection.id : ""));
          ok = true;
          // A password typed but not saved is still the one to connect with.
          const typed = values.bind === "simple" && !values.savePassword ? values.password : "";
          onSaved(saved, connectNow, typed);
        } catch (e) {
          setStatus({ kind: "saveFailed", message: errorText(e) });
        }
      })();
    } finally {
      saving.current = ok ? "saved" : "idle";
    }
  };

  // Ctrl+Enter / ⌘↩ saves, and connects a new connection. Busy buttons keep focus, so the form always hears it.
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && isMod(e, platform)) {
      e.preventDefault();
      void save(!isEdit);
    }
  }

  const busy = status.kind === "testing" || status.kind === "fetching" || status.kind === "saving";
  const urlField = register("url", {
    onChange: (e) => setValue("security", securityForUrl(e.target.value, getValues("security"))),
  });
  const nameField = register("name");
  const passwordField = register("password");

  const cancel = (
    <Button key="cancel" size="lg" onClick={onClose}>
      Cancel
    </Button>
  );
  const actions = isEdit
    ? orderActions(
        <Button key="save" size="lg" variant="primary" type="submit" busy={status.kind === "saving"} disabled={busy}>
          Save changes
        </Button>,
        cancel,
        platform,
      )
    : orderActions(
        <Button key="connect" size="lg" variant="primary" onClick={() => void save(true)} busy={status.kind === "saving"} disabled={busy}>
          Save and connect
          <Kbd keys={["mod", "enter"]} platform={platform} className="kn-kbd--on-moss" />
        </Button>,
        <span key="pair" className="contents">
          {orderActions(
            <Button key="save" size="lg" type="submit" disabled={busy}>
              Save
            </Button>,
            cancel,
            platform,
          )}
        </span>,
        platform,
      );

  return (
    <Modal onClose={onClose} labelledBy={titleId} className="w-full max-w-[680px]" initialFocus={badPassword ? passwordRef : nameRef}>
      <form
        className="flex max-h-[calc(100vh-48px)] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised text-ink shadow-lg"
        noValidate
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <header className="flex items-start gap-3 px-6 pt-6 pb-4">
          <div className="flex grow flex-col gap-1">
            <h2 id={titleId} className="type-title m-0">
              {isEdit ? "Edit connection" : "New connection"}
            </h2>
            <p className="m-0 text-ink-muted">
              {isEdit
                ? `Changes apply the next time you connect to ${connection.name}.`
                : `Kanopa saves this connection on this computer. The password goes to the ${store}, never to the settings file.`}
            </p>
          </div>
          <Button variant="ghost" size="sm" icon="x" label="Close" onClick={onClose} />
        </header>

        <div className="flex min-h-0 grow flex-col gap-6 overflow-y-auto px-6 pb-6">
          {badPassword && (
            <Banner tone="danger">
              The server refused the saved password for <code>{connection.bindDn}</code>. Enter the current password below. Invalid credentials (49)
            </Banner>
          )}

          {/* Server */}
          <section className="flex flex-col gap-3" aria-labelledby={`${titleId}-server`}>
            <h3 id={`${titleId}-server`} className="type-heading m-0">
              Server
            </h3>
            <TextField
              label="Connection name"
              placeholder="Production directory"
              error={errors.name?.message}
              {...nameField}
              ref={(el) => {
                nameField.ref(el);
                nameRef.current = el;
              }}
            />
            <div className="flex flex-wrap items-start gap-3">
              <TextField
                fieldClassName="min-w-0 flex-[999_1_300px]"
                label="LDAP URL"
                mono
                placeholder="ldaps://ldap.example.org:636"
                hint="Port defaults to 636 for ldaps:// and 389 for ldap://."
                error={errors.url?.message}
                {...urlField}
              />
              <Controller
                control={control}
                name="security"
                render={({ field }) => (
                  <Segmented
                    label="Encryption"
                    value={field.value}
                    options={SECURITY_OPTIONS}
                    onChange={(sec) => {
                      field.onChange(sec);
                      setValue("url", urlForSecurity(getValues("url"), sec));
                    }}
                  />
                )}
              />
            </div>
            {security === "none" && (
              <Banner tone="warning" title="Unencrypted.">
                The bind password crosses the network in clear text. Use LDAPS or StartTLS unless the server runs on this computer.
              </Banner>
            )}
            <div className="flex items-start gap-2">
              <TextField
                fieldClassName="min-w-0 flex-1"
                label="Base DN"
                mono
                placeholder="dc=example,dc=org"
                hint="Leave empty to open the server's first naming context."
                error={errors.baseDn?.message}
                {...register("baseDn")}
              />
              <Button className="mt-[22px] shrink-0" icon="download" onClick={onFetchBase} busy={status.kind === "fetching"} disabled={busy}>
                Fetch from server
              </Button>
            </div>
          </section>

          <div className="h-px bg-line" aria-hidden="true" />

          {/* Authentication */}
          <section className="flex flex-col gap-3" aria-labelledby={`${titleId}-auth`}>
            <h3 id={`${titleId}-auth`} className="type-heading m-0">
              Authentication
            </h3>
            <Controller
              control={control}
              name="bind"
              render={({ field }) => (
                <Select
                  fieldClassName="max-w-[320px]"
                  label="Bind method"
                  options={[
                    { value: "simple", label: "Simple bind" },
                    { value: "anonymous", label: "Anonymous" },
                  ]}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
            {bind === "simple" ? (
              <>
                <div className="flex flex-wrap items-start gap-3">
                  <TextField
                    fieldClassName="min-w-0 flex-[999_1_300px]"
                    label="Bind DN"
                    mono
                    placeholder="cn=admin,dc=example,dc=org"
                    hint={String.raw`A DN. Active Directory also takes DOMAIN\user or user@example.org.`}
                    autoComplete="username"
                    error={errors.bindDn?.message}
                    {...register("bindDn")}
                  />
                  <TextField
                    fieldClassName="min-w-0 flex-[1_1_200px]"
                    label="Password"
                    mono
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder={isEdit && connection.hasPassword ? `Saved in the ${platform === "mac" ? "Keychain" : "Credential Manager"}` : ""}
                    hint={isEdit && connection.hasPassword && savePassword ? "Leave empty to keep the saved password." : undefined}
                    className={badPassword ? "kn-input--attention" : undefined}
                    trailing={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={showPassword ? "eye-off" : "eye"}
                        label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword((v) => !v)}
                      />
                    }
                    {...passwordField}
                    ref={(el) => {
                      passwordField.ref(el);
                      passwordRef.current = el;
                    }}
                  />
                </div>
                <Checkbox className="self-start" label={`Save the password in the ${store}`} {...register("savePassword")} />
              </>
            ) : (
              <p className="m-0 text-ink-muted">Kanopa connects without a bind. Most servers then show only public entries and refuse every change.</p>
            )}
          </section>

          <div className="h-px bg-line" aria-hidden="true" />

          {/* Advanced */}
          <section className="flex flex-col gap-3">
            <button type="button" className="kn-disclosure" aria-expanded={advanced} aria-controls={`${titleId}-adv`} onClick={() => setAdvanced((v) => !v)}>
              <Icon name="chevron-right" size={14} />
              Advanced
              {!advanced && <span className="type-body text-ink-muted">· {advancedSummary({ timeoutSeconds, pageSize, referrals })}</span>}
            </button>
            {advanced && (
              <div id={`${titleId}-adv`} className="grid grid-cols-3 gap-3">
                <TextField
                  label="Connect timeout (seconds)"
                  type="number"
                  min={1}
                  max={300}
                  error={errors.timeoutSeconds?.message}
                  {...register("timeoutSeconds", { valueAsNumber: true })}
                />
                <TextField label="Page size" type="number" min={1} error={errors.pageSize?.message} {...register("pageSize", { valueAsNumber: true })} />
                <Controller
                  control={control}
                  name="referrals"
                  render={({ field }) => (
                    <Select
                      label="Referrals"
                      options={[
                        { value: "show", label: "Show as entries" },
                        { value: "ignore", label: "Ignore" },
                        { value: "follow", label: "Follow (coming later)", disabled: true },
                      ]}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      ref={field.ref}
                    />
                  )}
                />
                <Checkbox className="col-span-3" label="Open read-only — Kanopa never sends changes over this connection" {...register("readOnly")} />
                <Checkbox className="col-span-3" label="Verify the server certificate against the system trust store" {...register("verifyCert")} />
              </div>
            )}
          </section>

          <div aria-live="polite" className="contents">
            <StatusBanner status={status} />
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-6 py-4">
          <Button size="lg" icon="plug" onClick={() => void onTest()} busy={status.kind === "testing"} disabled={busy}>
            Test connection
          </Button>
          <span className="grow" />
          <div className="flex gap-2">{actions}</div>
        </footer>
      </form>
    </Modal>
  );
}

function StatusBanner({ status }: { status: Status }) {
  if (status.kind === "testing" || status.kind === "fetching")
    return (
      <Banner tone="info" busy>
        {status.kind === "testing" ? "Testing " : "Reading the naming contexts of "}
        <code>{status.url}</code>…
      </Banner>
    );
  if (status.kind === "saveFailed")
    return (
      <Banner tone="danger" title="Not saved.">
        {status.message}
      </Banner>
    );
  if (status.kind !== "done") return null;
  const r = status.result;
  if (r.ok)
    return (
      <Banner tone="success" title={r.title}>
        {r.message}
      </Banner>
    );
  return (
    <Banner tone="danger" title={status.action === "fetch" ? "Couldn't read the base DN." : "Connection failed."}>
      {r.message}
    </Banner>
  );
}
