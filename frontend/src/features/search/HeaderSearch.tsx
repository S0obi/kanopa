import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useBackend, type QuickHit, type QuickResult, type SessionInfo } from "@/api/backend";
import { detectPlatform, isMod } from "@/lib/platform";
import { Button, Icon, Kbd, Spinner, TypeTile, asEntryType, cx } from "@/ui";
import { useBrowser, type ConnectionState } from "@/features/browser/store";
import { countText, highlight, searchable, wordsOf } from "./quick";
import { useSettled } from "./useSettled";

/**
 * The search field in the header. A word or two finds entries by name and mail; text that starts
 * with "(", or reads attribute=value, is an LDAP filter. The dropdown lists the best ten, and a
 * click, or Enter, selects the entry in the tree and opens it.
 */
export function HeaderSearch({ session, connection }: { session: SessionInfo; connection: ConnectionState }) {
  const backend = useBackend();
  const platform = detectPlatform();
  const select = useBrowser((s) => s.select);
  const reveal = useBrowser((s) => s.reveal);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(-1);
  const connected = connection === "connected";

  const settled = useSettled(text, 180);
  const wanted = connected && searchable(settled);
  const query = useQuery({
    queryKey: ["quick", session.connectionId, settled.trim()],
    queryFn: ({ signal }) => backend.quick(session.connectionId, settled, signal),
    enabled: wanted,
    // The list stays while the next one is read, so it doesn't flash on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  const result = wanted ? query.data : undefined;
  const hits = result?.hits ?? [];
  const stale = query.isPlaceholderData || settled !== text;
  const open = focused && !closed && connected && searchable(text);
  const current = open && active >= 0 && active < hits.length ? active : -1;

  // Ctrl/⌘+F and Ctrl/⌘+K go to the field and select what is in it.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (isMod(e, platform) && !e.shiftKey && !e.altKey && (k === "f" || k === "k")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [platform]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!focused) return;
    function away(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setFocused(false);
    }
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [focused]);

  function pick(hit: QuickHit) {
    select(hit.dn);
    void reveal(backend, hit.dn);
    // The text stays, so focusing the field again shows the same results; the keyboard goes back to the entry.
    setClosed(true);
    input.current?.blur();
    setFocused(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setClosed(false);
      if (!hits.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[current >= 0 ? current : 0];
      if (open && hit && !stale) pick(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      setActive(-1);
      input.current?.blur();
    }
  }

  return (
    <div className="kn-hsearch" ref={root}>
      <div className="kn-hsearch__field">
        <Icon name="search" size={14} />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Search entries"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={!connected}
          placeholder={connected ? "Search by name or mail, or type an LDAP filter" : "Reconnect to search"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setClosed(false);
            setActive(-1);
          }}
          onFocus={() => {
            setFocused(true);
            setClosed(false);
            // Entries may have changed since the list was read.
            if (wanted && Date.now() - query.dataUpdatedAt > 5_000) void query.refetch();
          }}
          onKeyDown={onKeyDown}
        />
        {text ? (
          <Button variant="ghost" size="sm" icon="x" label="Clear search" className="!size-5 !min-w-0 !p-0" onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(""); input.current?.focus(); }} />
        ) : (
          <span className="kn-hsearch__hint">
            <Kbd keys={["mod", "f"]} platform={platform} />
          </span>
        )}
      </div>

      {open && (
        <div className="kn-hsearch__panel" id={listId} role="listbox" tabIndex={-1} aria-label="Matching entries" onMouseDown={(e) => e.preventDefault()}>
          <Panel result={result} text={text} settledText={settled} loading={query.isFetching && !result} stale={stale} listId={listId} current={current} onPick={pick} onHover={setActive} baseDn={session.baseDn} />
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  result: QuickResult | undefined;
  text: string;
  settledText: string;
  loading: boolean;
  stale: boolean;
  listId: string;
  current: number;
  baseDn: string;
  onPick: (h: QuickHit) => void;
  onHover: (i: number) => void;
}

function Panel({ result, text, settledText, loading, stale, listId, current, baseDn, onPick, onHover }: PanelProps) {
  if (!result || (loading && !result.hits?.length && !result.invalid))
    return (
      <div className="kn-hsearch__note" role="status">
        <Spinner size={14} /> Searching…
      </div>
    );
  if (result.failure)
    return (
      <div className="kn-hsearch__note text-danger-ink" role="alert">
        <Icon name="error" size={14} /> {result.failure.message}
      </div>
    );
  const mode = result.mode === "filter" ? "LDAP filter" : "Names and mail";
  if (result.invalid) {
    const at = Math.min(result.invalid.position, Array.from(settledText.trim()).length);
    return (
      <div>
        <div className="kn-hsearch__head">
          <span className="kn-hsearch__mode">{mode}</span>
        </div>
        <div className="flex flex-col gap-1 px-3 py-2" role="alert">
          <span className="flex items-start gap-1.5 text-danger-ink">
            <Icon name="error" size={14} className="mt-0.5 shrink-0" /> {result.invalid.message}
          </span>
          <code className="block overflow-x-auto whitespace-pre text-[12px] leading-4 text-ink-muted" aria-hidden="true">
            {settledText.trim()}
            {"\n"}
            {" ".repeat(at)}▲ character {at + 1}
          </code>
        </div>
      </div>
    );
  }
  const hits = result.hits ?? [];
  const words = result.mode === "names" ? wordsOf(settledText) : [];
  return (
    <div className={cx(stale && "opacity-60")}>
      <div className="kn-hsearch__head">
        <span className="kn-hsearch__mode">{mode}</span>
        {hits.length > 0 && <span className="text-ink-muted">{countText(result)}</span>}
      </div>
      {hits.length === 0 ? (
        <div className="kn-hsearch__note">
          {result.mode === "filter" ? (
            <>
              No entry matches <code>{result.filter}</code> under <code>{baseDn}</code>.
            </>
          ) : (
            <>No entry matches “{text.trim()}”.</>
          )}
        </div>
      ) : (
        hits.map((h, i) => (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the field keeps focus and handles the keyboard
          <div
            key={h.dn}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === current}
            className="kn-hsearch__row"
            onMouseMove={() => onHover(i)}
            onClick={() => onPick(h)}
          >
            <TypeTile type={asEntryType(h.type)} size={24} />
            <span className="flex min-w-0 flex-col">
              <span className="flex items-baseline gap-2">
                <span className="truncate font-semibold">
                  {highlight(h.name, words).map((s, k) => (s.hit ? <mark key={k}>{s.text}</mark> : s.text))}
                </span>
                {h.sub && <span className="truncate text-[12px] text-ink-muted">{h.sub}</span>}
              </span>
              <code className="truncate text-[11px] leading-4 text-ink-muted">{h.dn}</code>
            </span>
          </div>
        ))
      )}
      {result.serverLimit && (
        <div className="kn-hsearch__foot">The server stopped at {result.total.toLocaleString("en-US")} entries (its size limit){result.paged ? "" : " and doesn't page"}. Narrow the search to see the others.</div>
      )}
      {!result.serverLimit && result.more && hits.length > 0 && <div className="kn-hsearch__foot">More entries match. Keep typing to narrow the list.</div>}
    </div>
  );
}
