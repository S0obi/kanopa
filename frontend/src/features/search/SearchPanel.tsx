import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackend, type FilterCheck, type SessionInfo } from "@/api/backend";
import { plural } from "@/lib/time";
import { Banner, Button, EmptyState, MenuButton, Segmented, Skeleton, TextField, cx, useToasts, type MenuItem } from "@/ui";
import { useBrowser, type ConnectionState } from "@/features/browser/store";
import { Completing } from "./Completing";
import { ResultsTable } from "./ResultsTable";
import { SCOPES, STEP, useSearch, type Scope } from "./store";
import { useSettled } from "./useSettled";

const trimTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The Search view: base, scope, filter and columns above, the results below. It takes the entry view's place; the tree stays. */
export function SearchPanel({ session, connection }: { session: SessionInfo; connection: ConnectionState }) {
  const backend = useBackend();
  const qc = useQueryClient();
  const toast = useToasts((s) => s.show);
  const id = session.connectionId;
  const { base, scope, filter, attrs, status, result, failure, shown } = useSearch();
  const setField = useSearch((s) => s.setField);
  const run = useSearch((s) => s.run);
  const stop = useSearch((s) => s.stop);
  const more = useSearch((s) => s.more);
  const hide = useSearch((s) => s.hide);
  const load = useSearch((s) => s.load);
  const opened = useSearch((s) => s.opened);
  const select = useBrowser((s) => s.select);
  const reveal = useBrowser((s) => s.reveal);
  // A filter Enter refused before the check had settled: its verdict stays until the text changes.
  const [refused, setRefused] = useState<{ filter: string; v: FilterCheck } | null>(null);
  const connected = connection === "connected";
  const running = status === "running";

  const names = useQuery({ queryKey: ["attributeNames", id], queryFn: () => backend.attributeNames(id), staleTime: Infinity });
  const recent = useQuery({ queryKey: ["recent", id], queryFn: () => backend.recentSearches(id) });

  // The filter is checked a moment after typing stops: half-typed text is not an error yet.
  const settled = useSettled(filter, 450);
  const check = useQuery({
    queryKey: ["filter", settled],
    queryFn: () => backend.checkFilter(settled),
    enabled: settled.trim().length > 0,
    staleTime: Infinity,
  });
  const verdict = settled === filter && filter.trim() ? check.data : undefined;
  // A filter that is only unfinished (the problem is at its very end) is not flagged while it is being typed;
  // pressing Enter flags it.
  const unfinished = !!verdict && !verdict.ok && verdict.position >= Array.from(filter.trim()).length;
  const bad = refused?.filter === filter ? refused.v : verdict && !verdict.ok && !unfinished ? verdict : undefined;

  async function go() {
    if (!connected || running) return;
    if (filter.trim()) {
      const v = await backend.checkFilter(filter);
      if (!v.ok) {
        setRefused({ filter, v }); // nothing is sent; the message says why
        return;
      }
    }
    if (await run(backend, id)) {
      const r = useSearch.getState().result;
      if (r) void backend.addRecentSearch(id, { base: r.base, scope: r.scope, filter: r.filter, attrs: r.columns ?? [] }).catch(() => {});
      void qc.invalidateQueries({ queryKey: ["recent", id] });
    }
  }

  function open(dn: string) {
    opened(dn);
    select(dn);
    void reveal(backend, dn);
    hide();
  }

  async function copyDns() {
    const text = (result?.rows ?? []).slice(0, shown).map((r) => r.dn).join("\n");
    try {
      await backend.copyText(text);
      toast(`Copied ${plural(Math.min(shown, result?.rows?.length ?? 0), "DN")}.`);
    } catch {
      toast("Kanopa could not copy the DNs.", "danger");
    }
  }

  const recents = useMemo(() => recent.data ?? [], [recent.data]);
  const recentItems: MenuItem[] = useMemo(
    () => [
      ...recents.map((r, i) => ({ id: String(i), label: trimTo(r.filter || "(objectClass=*)", 44), icon: "search" as const, hint: SCOPES.find((s) => s.value === r.scope)?.label })),
      { separator: true as const },
      { id: "clear", label: "Clear recent searches", icon: "trash" as const, danger: true },
    ],
    [recents],
  );

  // Esc closes the panel, unless a menu or the suggestions were using it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')) hide();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  const rows = result?.rows ?? [];
  const columns = result?.columns ?? [];
  const visible = rows.slice(0, shown);
  const where = result?.base ?? base;

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Search">
      <form
        className="flex flex-col gap-3 border-b border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h1 className="type-title m-0">Search</h1>
          <Button type="button" variant="ghost" size="sm" icon="x" onClick={hide}>
            Close
          </Button>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <TextField
            label="Start at"
            mono
            value={base}
            placeholder={session.baseDn}
            onChange={(e) => setField({ base: e.target.value })}
          />
          <Segmented<Scope> label="Look in" value={scope} options={SCOPES} onChange={(v) => setField({ scope: v })} />
        </div>

        <Completing
          label="Filter"
          mode="filter"
          icon="filter"
          autoFocus
          value={filter}
          names={names.data ?? []}
          placeholder="(objectClass=*)"
          onChange={(v) => setField({ filter: v })}
          onEnter={() => void go()}
          hint={bad ? undefined : "An LDAP filter, like (&(objectClass=inetOrgPerson)(mail=*@example.org)). Empty finds everything."}
          error={bad ? <FilterProblem filter={filter} problem={bad} onUse={(f) => setField({ filter: f })} /> : undefined}
          trailing={verdict?.ok ? <span className="kn-filter__ok" role="img" aria-label="The filter is valid">✓</span> : undefined}
        />

        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Completing
            label="Also show"
            mode="list"
            value={attrs}
            names={names.data ?? []}
            placeholder="Attributes as columns, like mail, title"
            onChange={(v) => setField({ attrs: v })}
            onEnter={() => void go()}
          />
          <div className="flex items-center gap-2">
            {recents.length > 0 && (
              <MenuButton
                label="Recent searches"
                icon="clock"
                items={recentItems}
                onSelect={(item) => {
                  if (item === "clear") {
                    void backend.clearRecentSearches(id).then(() => qc.invalidateQueries({ queryKey: ["recent", id] }));
                    return;
                  }
                  const r = recents[Number(item)];
                  if (r) load(r);
                }}
              />
            )}
            {running ? (
              <Button type="button" icon="x" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" icon="search" disabled={!connected}>
                Search
              </Button>
            )}
          </div>
        </div>
        {!connected && <p className="m-0 text-ink-muted">The connection is lost. The results below are from before; reconnect, then search again.</p>}
      </form>

      <div className="min-h-0 flex-1 overflow-auto p-4" aria-live="polite">
        {failure && (
          <Banner tone={failure.lost ? "warning" : "danger"} title={failure.title}>
            {failure.message}
          </Banner>
        )}
        {running && <p className="m-0 mb-3 text-ink-muted" role="status">Searching…</p>}
        {running && !result && <Skeleton variant="table" rows={6} label="Searching" />}
        {!result && status === "idle" && !failure && (
          <EmptyState icon="search" title="Search the directory">
            Type a filter and press Enter. Results are read 100 at a time, up to 500, and open in the tree.
          </EmptyState>
        )}
        {result && (
          <div className={cx("flex flex-col gap-3", running && "opacity-60")}>
            {rows.length === 0 ? (
              <EmptyState icon="search" title="Nothing matches">
                <code>{result.filter}</code> finds no entry {result.scope === "base" ? "at" : result.scope === "one" ? "directly under" : "under"} <code>{where}</code>.
              </EmptyState>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="type-heading m-0">
                    {plural(rows.length, "entry", "entries")}
                    {result.truncated && !result.serverLimit && "+"}
                    <span className="ml-2 font-normal text-ink-muted">
                      {result.scope === "base" ? "at" : result.scope === "one" ? "directly under" : "under"} <code>{where}</code> · {result.elapsedMs} ms
                    </span>
                  </h2>
                  <Button size="sm" icon="copy" onClick={() => void copyDns()}>
                    Copy DNs
                  </Button>
                </div>
                {result.truncated && (
                  <Banner tone="info" title={result.serverLimit ? `The server stopped at ${rows.length.toLocaleString("en-US")} entries.` : `These are the first ${result.limit.toLocaleString("en-US")} entries.`}>
                    {result.serverLimit
                      ? `Its size limit ended the search${result.paged ? "" : ", and it doesn't page, so Kanopa can't ask for the rest"}. Narrow the filter to see the others.`
                      : "More entries match. Narrow the filter or start lower in the tree to see the others."}
                  </Banner>
                )}
                <ResultsTable rows={visible} columns={columns} onOpen={open} />
                {visible.length < rows.length && (
                  <div className="flex items-center gap-3">
                    <Button onClick={more}>Show {Math.min(STEP, rows.length - visible.length)} more</Button>
                    <span className="text-ink-muted">{visible.length.toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")} shown</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Says what is wrong with the filter and where, with a pointer under the text. */
function FilterProblem({ filter, problem, onUse }: { filter: string; problem: { message: string; position: number; suggestion: string }; onUse: (f: string) => void }) {
  const chars = Array.from(filter);
  const at = Math.min(problem.position, chars.length);
  return (
    <span className="flex flex-col gap-1">
      <span>{problem.message}</span>
      {problem.suggestion ? (
        <Button type="button" size="sm" className="self-start" onClick={() => onUse(problem.suggestion)}>
          Use {problem.suggestion}
        </Button>
      ) : (
        <code className="block overflow-x-auto whitespace-pre text-[12px] leading-4 text-ink-muted" aria-hidden="true">
          {filter}
          {"\n"}
          {" ".repeat(at)}▲ character {at + 1}
        </code>
      )}
    </span>
  );
}
