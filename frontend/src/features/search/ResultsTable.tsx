import type { ReactNode } from "react";
import type { SearchRow } from "@/api/backend";
import { Button, TypeTile, asEntryType } from "@/ui";

interface Props {
  rows: SearchRow[];
  columns: string[];
  onOpen: (dn: string) => void;
}

/** Search results: the entry (type, name, description), its DN, then the attributes that were asked for. */
export function ResultsTable({ rows, columns, onOpen }: Props) {
  return (
    <div>
      <table className="kn-attrs kn-results" aria-label="Search results">
        <thead>
          <tr>
            <th scope="col">Entry</th>
            <th scope="col">DN</th>
            {columns.map((c) => (
              <th key={c} scope="col" className="font-mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dn} onDoubleClick={() => onOpen(r.dn)}>
              <td className="min-w-[200px]">
                <div className="flex items-center gap-2">
                  <TypeTile type={asEntryType(r.type)} size={22} />
                  <Button variant="ghost" size="sm" className="!h-auto !max-w-[260px] !justify-start !px-1 !py-0.5 !font-semibold" aria-label={`Open ${r.dn}`} onClick={() => onOpen(r.dn)}>
                    <span className="truncate">{r.name}</span>
                  </Button>
                  {r.sub && <span className="truncate text-[12px] text-ink-muted">{r.sub}</span>}
                </div>
              </td>
              <td className="max-w-[360px]">
                <code className="block truncate text-[12px] text-ink-muted" title={r.dn}>
                  {r.dn}
                </code>
              </td>
              {columns.map((c, i) => (
                <td key={c} className="max-w-[240px]">
                  <Cell values={r.cells?.[i] ?? []} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ values }: { values: string[] }): ReactNode {
  if (values.length === 0) return <span className="text-ink-faint">—</span>;
  const [first, ...rest] = values;
  return (
    <span className="flex items-baseline gap-1.5" title={values.join("\n")}>
      <code className="truncate text-[12px]">{first}</code>
      {rest.length > 0 && <span className="shrink-0 text-[11px] text-ink-muted">+{rest.length}</span>}
    </span>
  );
}
