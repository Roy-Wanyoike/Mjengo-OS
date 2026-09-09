'use client'

// The supplier's catalog (W5-3) — their prices and stock exactly as the
// buyer's Finder comparisons see them. Inline per-row edit of unitPrice +
// stockQty → catalog.upsert { id, unitPrice, stockQty } (the server forces
// supplierId to the session pin and 404s-a-miss any id that is not theirs).

import { useState } from 'react'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Pencil, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { fmtQty, formatKes } from '@/frontend/mjengo/finder/sections/requests/bits'
import type { CatalogItem } from '@prisma/client'
import type { SupplierDispatch } from './supplier-portal'

export function SupplierCatalog({
  catalog, dispatch, busy, supplierId, projectId,
}: {
  catalog: CatalogItem[]
  dispatch: SupplierDispatch
  busy: boolean
  supplierId: string
  /** Catalog rows are network-global — the audit event just needs SOME
   *  project context; the first buyer project (or the server's default).
   *  The row pin is supplierId, never the project. */
  projectId: string | undefined
}) {
  const t = useT()
  const [editing, setEditing] = useState<string | null>(null)
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')

  function startEdit(item: CatalogItem) {
    setEditing(item.id)
    setPrice(String(item.unitPrice))
    setStock(String(item.stockQty))
  }

  async function save(item: CatalogItem, projectId: string | undefined) {
    const p = Number(price)
    const s = Number(stock)
    if (!Number.isFinite(p) || p < 0 || !Number.isFinite(s) || s < 0) {
      toast.error(t('supplier.catalog.invalid'))
      return
    }
    // The server pins supplierId to our session link — the copy here is the
    // payload shape the buyer-side catalog editor uses; either way the row
    // lands on OUR catalog (foreign ids answer like a miss).
    const ok = await dispatch(
      'catalog.upsert',
      { supplierId, id: item.id, name: item.name, unit: item.unit, unitPrice: p, stockQty: s },
      projectId,
      `Catalog updated: ${item.name}`,
    )
    if (ok) {
      toast.success(t('supplier.catalog.saved'))
      setEditing(null)
    }
  }

  return (
    <div className="overflow-x-auto rounded-md border border-stone-200">
      <table className="w-full min-w-[520px] text-sm">
        <caption className="sr-only">{t('supplier.catalog.title')}</caption>
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
            <th scope="col" className="px-3 py-2 font-medium">{t('supplier.catalog.name')}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{t('supplier.catalog.price')}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{t('supplier.catalog.stock')}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{t('supplier.catalog.unit')}</th>
            <th scope="col" className="px-3 py-2 font-medium" aria-label={t('supplier.catalog.save')} />
          </tr>
        </thead>
        <tbody>
          {catalog.map((item) => {
            const isEdit = editing === item.id
            return (
              <tr key={item.id} className="border-b border-stone-100 last:border-0">
                <td className="px-3 py-2 text-stone-700">
                  {item.name}
                  {item.category && (
                    <span className="block text-[10px] text-stone-400">
                      {item.category}
                      {item.brand ? ` · ${item.brand}` : ''}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-stone-900">
                  {isEdit ? (
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      className="h-9 w-28 ml-auto text-right tabular-nums"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      aria-label={`${item.name} — ${t('supplier.catalog.price')}`}
                    />
                  ) : (
                    formatKes(item.unitPrice)
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-stone-700">
                  {isEdit ? (
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      className="h-9 w-24 ml-auto text-right tabular-nums"
                      value={stock}
                      onChange={(e) => setStock(e.target.value)}
                      aria-label={`${item.name} — ${t('supplier.catalog.stock')}`}
                    />
                  ) : (
                    fmtQty(item.stockQty)
                  )}
                </td>
                <td className="px-2 py-2 text-right text-[11px] text-stone-400">{item.unit}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {isEdit ? (
                    <span className="inline-flex gap-1">
                      <Button
                        size="sm"
                        className="h-8 min-h-8 w-8 p-0 bg-emerald-600 text-white hover:bg-emerald-700"
                        disabled={busy}
                        onClick={() => void save(item, projectId)}
                        aria-label={`${t('supplier.catalog.save')} ${item.name}`}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 min-h-8 w-8 p-0 text-stone-500"
                        onClick={() => setEditing(null)}
                        aria-label={`${t('supplier.quotes.cancel')} ${item.name}`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 min-h-8 w-8 p-0 text-stone-500"
                      disabled={busy}
                      onClick={() => startEdit(item)}
                      aria-label={`${t('supplier.catalog.edit')} ${item.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
