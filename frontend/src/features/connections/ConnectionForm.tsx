import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useBackend, type TestResult } from "@/api/backend";
import { detectPlatform, isMod, type Platform } from "@/lib/platform";
import { Banner, Button, Checkbox, Icon, Kbd, Segmented, Select, TextField } from "@/ui";
import { advancedSummary, connectionFormSchema, emptyConnectionForm, toParams, type ConnectionForm as Form } from "./schema";
import { securityForUrl, urlForSecurity, type Security } from "./url";

type Status =
  | { kind: "idle" }
  | { kind: "testing"; url: string }
  | { kind: "fetching"; url: string }
  | { kind: "done"; result: TestResult; action: "test" | "fetch" };

const SECURITY_OPTIONS: Array<{ value: Security; label: string }> = [
  { value: "ldaps", label: "LDAPS" },
  { value: "starttls", label: "StartTLS" },
  { value: "none", label: "None" },
];

export interface ConnectionFormProps {
  platform?: Platform;
  defaultValues?: Partial<Form>;
}

/** The connection form from the design (ConnectionDialog), with Test connection. */
export function ConnectionForm({ platform = detectPlatform(), defaultValues }: ConnectionFormProps) {
  const backend = useBackend();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showPassword, setShowPassword] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const { control, register, handleSubmit, watch, setValue, getValues, trigger, formState } = useForm<Form>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: { ...emptyConnectionForm, ...defaultValues },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const errors = formState.errors;
  const [bind, security, timeoutSeconds, pageSize, referrals] = watch(["bind", "security", "timeoutSeconds", "pageSize", "referrals"]);

  // A result describes the settings it was made with: any edit clears it, and stops a running test.
  useEffect(() => {
    const sub = watch((_, { name }) => {
      if (name === undefined) return;
      abort.current?.abort();
      setStatus((s) => (s.kind === "idle" ? s : { kind: "idle" }));
    });
    return () => sub.unsubscribe();
  }, [watch]);
  useEffect(() => () => abort.current?.abort(), []);

  async function run(action: "test" | "fetch", values: Form) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const params = toParams(values);
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
        result: { ok: false, title: "Kanopa could not run the test.", message: String(e instanceof Error ? e.message : e), code: 0, elapsedMs: 0, namingContexts: null, baseDn: "", vendor: "" },
      });
    }
  }

  const onTest = handleSubmit((values) => run("test", values));

  async function onFetchBase() {
    const fields = getValues("bind") === "simple" ? (["url", "bindDn"] as const) : (["url"] as const);
    if (await trigger([...fields])) await run("fetch", getValues());
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && isMod(e, platform)) {
      e.preventDefault();
      void onTest();
    }
  }

  const busy = status.kind === "testing" || status.kind === "fetching";
  const urlField = register("url", {
    onChange: (e) => setValue("security", securityForUrl(e.target.value, getValues("security"))),
  });

  return (
    <form
      className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-lg"
      aria-labelledby="cf-title"
      noValidate
      onSubmit={onTest}
      onKeyDown={onKeyDown}
    >
      <header className="flex flex-col gap-1 px-6 pt-6 pb-4">
        <h1 id="cf-title" className="type-title m-0 text-ink">
          Test a connection
        </h1>
        <p className="m-0 text-ink-muted">Kanopa checks the server, the encryption and your bind, then reads the server's naming contexts. Nothing is saved.</p>
      </header>

      <div className="flex flex-col gap-6 px-6 pb-6">
        {/* Server */}
        <section className="flex flex-col gap-3" aria-labelledby="cf-server">
          <h2 id="cf-server" className="type-heading m-0">
            Server
          </h2>
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
        <section className="flex flex-col gap-3" aria-labelledby="cf-auth">
          <h2 id="cf-auth" className="type-heading m-0">
            Authentication
          </h2>
          <Select
            fieldClassName="max-w-[320px]"
            label="Bind method"
            options={[
              { value: "simple", label: "Simple bind" },
              { value: "anonymous", label: "Anonymous" },
            ]}
            {...register("bind")}
          />
          {bind === "simple" ? (
            <div className="flex flex-wrap items-start gap-3">
              <TextField
                fieldClassName="min-w-0 flex-[999_1_300px]"
                label="Bind DN"
                mono
                placeholder="cn=admin,dc=example,dc=org"
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
                {...register("password")}
              />
            </div>
          ) : (
            <p className="m-0 text-ink-muted">Kanopa connects without a bind. Most servers then show only public entries and refuse every change.</p>
          )}
        </section>

        <div className="h-px bg-line" aria-hidden="true" />

        {/* Advanced */}
        <section className="flex flex-col gap-3">
          <button type="button" className="kn-disclosure" aria-expanded={advanced} aria-controls="cf-advanced" onClick={() => setAdvanced((v) => !v)}>
            <Icon name="chevron-right" size={14} />
            Advanced
            {!advanced && <span className="type-body text-ink-muted">· {advancedSummary({ timeoutSeconds, pageSize, referrals })}</span>}
          </button>
          {advanced && (
            <div id="cf-advanced" className="grid grid-cols-3 gap-3">
              <TextField
                label="Connect timeout (seconds)"
                type="number"
                min={1}
                max={300}
                error={errors.timeoutSeconds?.message}
                {...register("timeoutSeconds", { valueAsNumber: true })}
              />
              <TextField label="Page size" type="number" min={1} error={errors.pageSize?.message} {...register("pageSize", { valueAsNumber: true })} />
              <Select
                label="Referrals"
                options={[
                  { value: "show", label: "Show as entries" },
                  { value: "ignore", label: "Ignore" },
                  { value: "follow", label: "Follow (coming later)", disabled: true },
                ]}
                {...register("referrals")}
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

      <footer className="flex items-center gap-2 border-t border-line bg-surface px-6 py-4">
        <span className="type-label text-ink-muted">
          <Kbd keys={["mod", "enter"]} platform={platform} /> tests the connection
        </span>
        <span className="grow" />
        <Button type="submit" variant="primary" size="lg" icon="plug" busy={status.kind === "testing"} disabled={busy}>
          Test connection
        </Button>
      </footer>
    </form>
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
  if (status.kind !== "done") return null;
  const r = status.result;
  if (r.ok)
    return (
      <Banner tone="success" title={r.title}>
        {r.message}
      </Banner>
    );
  return (
    <Banner tone="danger" title={status.action === "fetch" ? "Could not read the base DN." : "Connection failed."}>
      {r.message}
    </Banner>
  );
}
