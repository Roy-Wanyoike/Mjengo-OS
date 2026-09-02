'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'

/**
 * Shared generic table primitive (W3-F2 · MjengoOS UI kit).
 *
 * Renders a typed column set over a row array with:
 *  · desktop (md+) — a real <table> (thead + th scope="col") built on the
 *    shadcn/ui Table primitives;
 *  · mobile (<md) — the same rows as stacked cards (label: value pairs,
 *    header = label, render output = value) so 360px phones never meet a
 *    horizontal-scroll table (hidden md:block table / md:hidden cards);
 *  · optional row interaction — rows become focusable buttons (Enter/Space)
 *    only when `onRowClick` is set, mirroring the audit-tab row pattern;
 *  · `loading` — 5 skeleton rows in whichever layout is active;
 *  · `emptyState` — rendered when rows are empty and not loading;
 *  · `maxHeight` — vertical scroll container (default max-h-96) with the
 *    app's thin custom scrollbar and a role="region" aria-label.
 *
 * Purely presentational: it never fetches, sorts or transforms rows.
 * `key` is a keyof T so simple columns can fall back to `String(row[key])`
 * when no `render` is given; React keys are index-suffixed so two columns
 * may legally share a key.
 */
export interface DataTableColumn<T> {
  /** Field of T used for the default cell value (render overrides it). */
  key: keyof T & string
  header: string
  /** Cell content; omit to render String(row[key]) (null/undefined → '—'). */
  render?: (row: T) => ReactNode
  /** Extra classes for this column's th AND td (e.g. 'whitespace-normal'). */
  className?: string
  align?: 'left' | 'right'
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Show 5 skeleton rows instead of data. */
  loading?: boolean
  /** Rendered when rows is empty and not loading. */
  emptyState?: ReactNode
  /** Vertical cap for the scroll container (Tailwind max-h-* class). */
  maxHeight?: string
}

const SKELETON_ROWS = 5

/** The app's established thin scrollbar styling (see header.tsx / fundis-tab). */
const THIN_SCROLLBAR =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

function cellValue<T>(col: DataTableColumn<T>, row: T): ReactNode {
  if (col.render) return col.render(row)
  const raw = row[col.key]
  if (raw === null || raw === undefined) return '—'
  return String(raw)
}

function clickableRowProps<T>(
  row: T,
  onRowClick: (row: T) => void,
): {
  tabIndex: number
  role: 'button'
  onClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
} {
  return {
    tabIndex: 0,
    role: 'button',
    onClick: () => onRowClick(row),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRowClick(row)
      }
    },
  }
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  emptyState,
  maxHeight = 'max-h-96',
}: DataTableProps<T>) {
  // Empty (and not loading) → the caller's empty state, or a sane default.
  if (!loading && rows.length === 0) {
    return (
      <div className="w-full">
        {emptyState ?? (
          <EmptyState icon={Inbox} title="No rows to show" compact />
        )}
      </div>
    )
  }

  const regionLabel = `${columns.map((c) => c.header).join(', ')} — scrollable rows`
  const clickable = onRowClick !== undefined

  return (
    <div
      className={cn('relative w-full overflow-y-auto pr-1', maxHeight, THIN_SCROLLBAR)}
      role="region"
      aria-label={regionLabel}
    >
      {/* ------------------------------ desktop / tablet: real table ------------------------------ */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((col, i) => (
                <TableHead
                  key={`${col.key}-${i}`}
                  scope="col"
                  className={cn(
                    'text-xs font-medium text-muted-foreground',
                    i === 0 && 'pl-4',
                    i === columns.length - 1 && 'pr-4',
                    col.align === 'right' && 'text-right',
                    col.className,
                  )}
                >
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? [...Array(SKELETON_ROWS)].map((_, r) => (
                  <TableRow key={`skeleton-${r}`}>
                    {columns.map((col, i) => (
                      <TableCell
                        key={`${col.key}-${i}`}
                        className={cn(
                          i === 0 && 'pl-4',
                          i === columns.length - 1 && 'pr-4',
                          col.align === 'right' && 'text-right',
                          col.className,
                        )}
                      >
                        <Skeleton className="h-4 w-full max-w-32" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row) => (
                  <TableRow
                    key={rowKey(row)}
                    {...(clickable ? clickableRowProps(row, onRowClick) : {})}
                    className={clickable ? 'cursor-pointer' : undefined}
                  >
                    {columns.map((col, i) => (
                      <TableCell
                        key={`${col.key}-${i}`}
                        className={cn(
                          i === 0 && 'pl-4',
                          i === columns.length - 1 && 'pr-4',
                          col.align === 'right' && 'text-right',
                          col.className,
                        )}
                      >
                        {cellValue(col, row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {/* ------------------------------ mobile: stacked label:value cards ------------------------------ */}
      <div className="space-y-2 md:hidden">
        {loading
          ? [...Array(SKELETON_ROWS)].map((_, r) => (
              <div
                key={`skeleton-card-${r}`}
                className="space-y-2 rounded-lg border border-border bg-card p-3"
                aria-hidden
              >
                {[...Array(Math.min(columns.length, 4))].map((_, l) => (
                  <div key={l} className="flex items-baseline justify-between gap-3">
                    <Skeleton className="h-3 w-20 shrink-0" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ))}
              </div>
            ))
          : rows.map((row) => (
              <div
                key={rowKey(row)}
                {...(clickable ? clickableRowProps(row, onRowClick) : {})}
                className={cn(
                  'rounded-lg border border-border bg-card p-3',
                  clickable &&
                    'cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
                )}
              >
                {columns.map((col, i) => (
                  <div
                    key={`${col.key}-${i}`}
                    className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0"
                  >
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {col.header}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 text-right text-sm text-foreground',
                        col.align === 'right' && 'tabular-nums',
                        col.className,
                      )}
                    >
                      {cellValue(col, row)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
      </div>
    </div>
  )
}
