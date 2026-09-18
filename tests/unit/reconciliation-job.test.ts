/**
 * Scheduled reconciliation job (issue #212) — the A-1-lite check plus the
 * escrow projection drift alarm folded into ONE job
 * (src/backend/modules/jobs/handlers.ts runReconciliation + the periodic
 * seed in src/backend/modules/jobs/service.ts ensureReconciliationScheduled,
 * wired into POST /api/jobs/run in src/backend/api/jobs.ts).
 *
 * No DB, no network: the Prisma client is swapped for an in-memory stub
 * (daraja-reconcile.test.ts pattern, extended with the escrowWallet /
 * ledgerAccount / ledgerEntry-groupBy / domainEvent tables the handler
 * reads) and notify is mocked at its module boundary so the REAL §59 event
 * bus (emit → policy → notify) runs. Drift is injected purely via stub
 * state — the check itself is read-only, which the tests pin by comparing
 * wallet / account / entry state before and after a drifted run.
 *
 * Pins:
 *  · drift ≥ threshold (default 1 cent) → per-project entry records
 *    derived/projected/driftCents + consistent=false, ONE 'escrow.drift'
 *    DomainEvent on the drifted project, finance AND contractor
 *    notification rows (the multi-audience policy fan-out), zero wallet /
 *    ledger mutation;
 *  · consistent state → honest no-op: entry recorded, no event, no
 *    notification, quiet note (the job is scheduled now — a healthy run
 *    must not ring bells; the JobRecord result is the all-clear record);
 *  · A-1-lite drift still emits 'ledger.reconciled' (contractor), and a
 *    consistent A-1-lite run no longer does (drift-gated emission);
 *  · cross-project sweep: EVERY escrow wallet is checked regardless of the
 *    job's projectId — one drifted + one healthy wallet → one alert;
 *  · sub-threshold drift is recorded in the payload but not alerted;
 *  · a wallet whose ESCROW ledger account does not exist (bypassing writer
 *    / seed script) derives 0 and alerts on any stored balance;
 *  · the drain cycle persists the full result JSON (cents as decimal
 *    strings — BigInts do not survive JSON.stringify);
 *  · the periodic seed never stacks rows (queued/retrying dedupe covers the
 *    manual POST racing it), respects the interval env, skips empty
 *    installs, and swallows storage errors (best-effort schedule keeping).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub — daraja-reconcile.test.ts pattern, extended with the
// reconciliation read set (project / escrowWallet / ledgerAccount /
// ledgerEntry.groupBy / transaction / milestone / invoice / domainEvent).
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    projects: new Map<string, Record<string, unknown>>(),
    escrowWallets: new Map<string, Record<string, unknown>>(),
    accounts: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    milestones: new Map<string, Record<string, unknown>>(),
    invoices: new Map<string, Record<string, unknown>>(),
    events: new Map<string, Record<string, unknown>>(),
    jobs: new Map<string, Record<string, unknown>>(),
    /** Test injection: make the NEXT jobRecord.findFirst throw (seed error path). */
    failNextJobFindFirst: false as boolean,
    reset() {
      state.projects.clear(); state.escrowWallets.clear(); state.accounts.clear()
      state.entries.clear(); state.transactions.clear(); state.milestones.clear()
      state.invoices.clear(); state.events.clear(); state.jobs.clear()
      state.seq = 0; state.failNextJobFindFirst = false
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`

  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      const p = state.projects.get(where.id)
      return p ? { ...p } : null
    },
    async findFirst({ orderBy }: { orderBy?: { createdAt?: 'asc' | 'desc' } } = {}) {
      let rows = [...state.projects.values()]
      rows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
      if (orderBy?.createdAt === 'desc') rows.reverse()
      return rows[0] ? { ...rows[0] } : null
    },
  }

  const escrowWallet = {
    async findUnique({ where }: { where: { projectId: string } }) {
      const w = state.escrowWallets.get(where.projectId)
      return w ? { ...w } : null
    },
    async findMany({ orderBy }: { orderBy?: { projectId?: 'asc' | 'desc' } } = {}) {
      let rows = [...state.escrowWallets.values()]
      rows.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)))
      if (orderBy?.projectId === 'desc') rows.reverse()
      return rows.map((w) => ({ ...w }))
    },
  }

  const ledgerAccount = {
    async findUnique({ where, select }: { where: { code?: string; id?: string }; select?: Record<string, boolean> }) {
      let a: Record<string, unknown> | undefined
      if (where.id) a = state.accounts.get(where.id)
      else if (where.code) a = [...state.accounts.values()].find((x) => x.code === where.code)
      if (!a) return null
      if (!select) return { ...a }
      const picked: Record<string, unknown> = {}
      for (const k of Object.keys(select)) picked[k] = (a as Record<string, unknown>)[k]
      return picked
    },
  }

  const ledgerEntry = {
    // The exact aggregate shape derivedBalance → accountSideSums issues
    // (issue #144): group by side, SQL SUM amount, where accountId.
    async groupBy({
      by,
      _sum,
      where,
    }: {
      by: string[]
      _sum: Record<string, boolean>
      where: { accountId: string }
    }) {
      void _sum
      if (!by.includes('side')) throw new Error('stub: groupBy expects by: ["side"]')
      const sums = new Map<string, bigint>()
      for (const e of state.entries.values()) {
        if (e.accountId !== where.accountId) continue
        sums.set(e.side as string, (sums.get(e.side as string) ?? 0n) + (e.amount as bigint))
      }
      return [...sums.entries()].map(([side, amount]) => ({ side, _sum: { amount } }))
    },
  }

  const transaction = {
    async findMany({ where, orderBy }: { where: { projectId: string }; orderBy?: { date?: 'asc' | 'desc' } }) {
      let rows = [...state.transactions.values()].filter((t) => t.projectId === where.projectId)
      rows.sort((a, b) => (a.date as Date).getTime() - (b.date as Date).getTime())
      if (orderBy?.date === 'desc') rows.reverse()
      return rows.map((t) => ({ ...t }))
    },
  }

  const milestone = {
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.milestones.values()].filter((m) => m.projectId === where.projectId).map((m) => ({ ...m }))
    },
  }

  const invoice = {
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.invoices.values()].filter((i) => i.projectId === where.projectId).map((i) => ({ ...i }))
    },
  }

  const domainEvent = {
    async create({ data }: { data: Record<string, unknown> }) {
      const row: Record<string, unknown> = { id: nid('evt'), occurredAt: new Date(), processedAt: null, ...data }
      state.events.set(row.id as string, row)
      return { ...row }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.events.get(where.id)
      if (!row) throw new Error(`stub: domainEvent ${where.id} not found`)
      Object.assign(row, data)
      return { ...row }
    },
  }

  const jobRecord = {
    async create({ data }: { data: Record<string, unknown> }) {
      const j: Record<string, unknown> = {
        id: nid('job'), type: 'unknown', projectId: null, status: 'queued',
        payload: '{}', result: null, attempts: 0, lastError: null,
        runAt: new Date(), startedAt: null, finishedAt: null,
        createdAt: new Date(), maxAttempts: 3, lastAttemptAt: null,
        ...data,
      }
      state.jobs.set(j.id as string, j)
      return { ...j }
    },
    async findFirst({
      where,
      orderBy,
    }: {
      where?: { type?: string; status?: { in: string[] } }
      orderBy?: { runAt?: 'asc' | 'desc' }
    } = {}) {
      if (state.failNextJobFindFirst) {
        state.failNextJobFindFirst = false
        throw new Error('stub: injected jobRecord.findFirst failure')
      }
      let rows = [...state.jobs.values()]
      if (where?.type) rows = rows.filter((j) => j.type === where.type)
      if (where?.status?.in) rows = rows.filter((j) => where.status!.in!.includes(j.status as string))
      rows.sort((a, b) => (a.runAt as Date).getTime() - (b.runAt as Date).getTime())
      if (orderBy?.runAt === 'desc') rows.reverse()
      return rows[0] ? { ...rows[0] } : null
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where?: { status?: { in: string[] }; runAt?: { lte?: Date } }
      orderBy?: { runAt?: 'asc' | 'desc' }
      take?: number
    } = {}) {
      let rows = [...state.jobs.values()]
      if (where?.status?.in) rows = rows.filter((j) => where.status!.in!.includes(j.status as string))
      if (where?.runAt?.lte) rows = rows.filter((j) => (j.runAt as Date) <= (where.runAt!.lte as Date))
      rows.sort((a, b) => (a.runAt as Date).getTime() - (b.runAt as Date).getTime())
      if (orderBy?.runAt === 'desc') rows.reverse()
      if (take) rows = rows.slice(0, take)
      return rows.map((r) => ({ ...r }))
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const j = state.jobs.get(where.id)
      if (!j) throw new Error(`stub: jobRecord ${where.id} not found`)
      const applied = { ...data }
      if (
        applied.attempts !== undefined &&
        typeof applied.attempts === 'object' &&
        applied.attempts !== null &&
        'increment' in (applied.attempts as Record<string, unknown>)
      ) {
        applied.attempts = (j.attempts as number) + (applied.attempts as { increment: number }).increment
      }
      Object.assign(j, applied)
      return { ...j }
    },
  }

  const db = {
    project, escrowWallet, ledgerAccount, ledgerEntry, transaction, milestone, invoice,
    domainEvent, jobRecord,
    __state: state,
  }
  return { db }
})

vi.mock('@/backend/modules/notify/service', () => ({ notify: vi.fn() }))

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'
import {
  DEFAULT_ESCROW_DRIFT_ALERT_CENTS,
  JOB_HANDLERS,
  escrowDriftThresholdCentsFromEnv,
  runReconciliation,
} from '@/backend/modules/jobs/handlers'
import {
  DEFAULT_RECONCILIATION_CHECK_INTERVAL_MIN,
  ensureReconciliationScheduled,
  enqueue,
  reconciliationCheckIntervalMinFromEnv,
  runDueJobs,
} from '@/backend/modules/jobs/service'

const state = (db as unknown as {
  __state: {
    projects: Map<string, Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    accounts: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    invoices: Map<string, Record<string, unknown>>
    events: Map<string, Record<string, unknown>>
    jobs: Map<string, Record<string, unknown>>
    failNextJobFindFirst: boolean
    reset: () => void
  }
}).__state

// ---------------------------------------------------------------- fixtures

const ENV_KEYS = ['ESCROW_DRIFT_ALERT_CENTS', 'RECONCILIATION_CHECK_INTERVAL_MIN']
const savedEnv: Record<string, string | undefined> = {}

function seedProject(id: string, createdAtDaysAgo = 10) {
  const row = { id, createdAt: new Date(Date.now() - createdAtDaysAgo * 86_400_000) }
  state.projects.set(id, { ...row })
  return row
}

function seedEscrowWallet(projectId: string, balanceCents: bigint) {
  const row = { id: `wallet_${projectId}`, projectId, balance: balanceCents, ledgerAccountId: null }
  state.escrowWallets.set(projectId, { ...row })
  return row
}

/**
 * Seed the ESCROW:<projectId> ledger account (liability — the real
 * ensureAccountTx kind) plus credit/debit entries summing to the given
 * cents, exactly the rows a derived ESCROW balance is computed from.
 */
function seedEscrowLedger(projectId: string, creditCents: bigint, debitCents = 0n) {
  const account = { id: `acct_escrow_${projectId}`, code: `ESCROW:${projectId}`, kind: 'liability' }
  state.accounts.set(account.id, { ...account })
  let n = 0
  const put = (side: 'debit' | 'credit', amount: bigint) => {
    if (amount <= 0n) return
    state.entries.set(`entry_${projectId}_${side}_${++n}`, { id: `entry_${projectId}_${side}_${n}`, accountId: account.id, side, amount })
  }
  put('credit', creditCents)
  put('debit', debitCents)
  return account
}

/** Deep snapshot of every table the check must NEVER write to (BigInt-safe). */
function readOnlySnapshot() {
  return JSON.stringify(
    {
      wallets: [...state.escrowWallets.entries()],
      accounts: [...state.accounts.entries()],
      entries: [...state.entries.entries()],
      transactions: [...state.transactions.entries()],
      milestones: [...state.milestones.entries()],
      invoices: [...state.invoices.entries()],
    },
    (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
  )
}

function eventsOf(type: string) {
  return [...state.events.values()].filter((e) => e.type === type)
}

function notifyCalls() {
  return (notify as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<
    [string, string, string, Record<string, unknown>]
  >
}

function reconciliationJobRows() {
  return [...state.jobs.values()].filter((j) => j.type === 'reconciliation')
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.reset()
  vi.clearAllMocks()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ------------------------------------------------- the escrow drift check

describe('runReconciliation — escrow projection drift (issue #212)', () => {
  beforeEach(() => {
    seedProject('p-1')
  })

  it('drift injected via stub state → inconsistent entry, escrow.drift event, finance+contractor notified, ZERO mutation', async () => {
    seedEscrowWallet('p-1', 500_000n) // stored projection says KSh 5,000
    seedEscrowLedger('p-1', 400_000n) // ledger-derived says KSh 4,000
    const before = readOnlySnapshot()

    const result = await runReconciliation('p-1')

    expect(result.projectId).toBe('p-1')
    expect(result.escrowDrift.checked).toBe(1)
    expect(result.escrowDrift.drifted).toBe(1)
    expect(result.escrowDrift.alerted).toBe(1)
    expect(result.escrowDrift.thresholdCents).toBe(DEFAULT_ESCROW_DRIFT_ALERT_CENTS)
    expect(result.escrowDrift.projects).toEqual([
      {
        projectId: 'p-1',
        derivedCents: '400000',
        projectedCents: '500000',
        driftCents: '-100000',
        consistent: false,
      },
    ])
    expect(result.escrowDrift.note).toContain('1 of 1')

    // ONE domain event on the drifted project, carrying the evidence
    const events = eventsOf('escrow.drift')
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBe('p-1')
    const payload = JSON.parse(events[0].payload as string) as Record<string, unknown>
    expect(payload.driftCents).toBe('-100000')
    expect(payload.thresholdCents).toBe(1)
    expect(payload.driftKes).toBe(1000)

    // the §59 policy fan-out: finance AND contractor each get a row
    const calls = notifyCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => (c[3] as { audienceRole: string }).audienceRole).sort()).toEqual(['contractor', 'finance'])
    for (const c of calls) {
      expect(c[0]).toBe('p-1')
      expect(c[1]).toContain('Escrow projection drift')
      expect((c[3] as { kind: string }).kind).toBe('escrow.drift')
      expect(String(c[2])).toContain('source of truth')
    }

    // A-1-lite is consistent here (no transactions, non-negative wallet) —
    // its event is drift-gated, so it must NOT fire (issue #212: a
    // scheduled healthy run stays quiet)
    expect(eventsOf('ledger.reconciled')).toHaveLength(0)

    // READ-ONLY invariant: nothing about the wallets/ledger moved
    expect(readOnlySnapshot()).toBe(before)
    expect(state.escrowWallets.get('p-1')?.balance).toBe(500_000n)
    expect(state.accounts.size).toBe(1)
    expect(state.entries.size).toBe(1)
  })

  it('consistent state → honest no-op: entry recorded, no event, no notification', async () => {
    seedEscrowWallet('p-1', 250_000n)
    seedEscrowLedger('p-1', 250_000n)
    const before = readOnlySnapshot()

    const result = await runReconciliation('p-1')

    expect(result.escrowDrift).toMatchObject({ checked: 1, drifted: 0, alerted: 0 })
    expect(result.escrowDrift.projects[0]).toMatchObject({ consistent: true, driftCents: '0' })
    expect(result.escrowDrift.note).toContain('consistent')
    expect(state.events.size).toBe(0)
    expect(notify).not.toHaveBeenCalled()
    expect(readOnlySnapshot()).toBe(before)
  })

  it('cross-project sweep: EVERY wallet is checked; only the drifted one alerts (event lands on ITS project)', async () => {
    seedProject('p-2', 5)
    seedEscrowWallet('p-1', 100_000n)
    seedEscrowLedger('p-1', 100_000n) // healthy
    seedEscrowWallet('p-2', 60_000n)
    seedEscrowLedger('p-2', 40_000n) // drifted by 20_000 cents

    const result = await runReconciliation('p-1') // the job's own projectId is p-1…

    expect(result.escrowDrift.checked).toBe(2)
    expect(result.escrowDrift.drifted).toBe(1)
    expect(result.escrowDrift.alerted).toBe(1)
    expect(result.escrowDrift.projectsOmitted).toBe(0)
    // drifted entries persist FIRST (the actionable rows survive any cap)
    expect(result.escrowDrift.projects.map((p) => p.projectId)).toEqual(['p-2', 'p-1'])
    expect(result.escrowDrift.projects[0]).toMatchObject({ driftCents: '-20000', consistent: false })
    // …but the alert still lands on the drifted project, not the job's
    const events = eventsOf('escrow.drift')
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBe('p-2')
  })

  it('wallet with a stored balance but NO escrow ledger account (bypassing writer / seed script) → derived 0, alerts', async () => {
    seedEscrowWallet('p-1', 75_000n) // projection says money…

    const result = await runReconciliation('p-1')

    expect(result.escrowDrift.projects[0]).toEqual({
      projectId: 'p-1',
      derivedCents: '0',
      projectedCents: '75000',
      driftCents: '-75000',
      consistent: false,
    })
    expect(result.escrowDrift.alerted).toBe(1)
    expect(eventsOf('escrow.drift')).toHaveLength(1)
  })

  it('sub-threshold drift is recorded in the payload but NOT alerted', async () => {
    process.env.ESCROW_DRIFT_ALERT_CENTS = '100000' // KSh 1,000 tolerance
    seedEscrowWallet('p-1', 50_000n)
    seedEscrowLedger('p-1', 45_000n) // 5_000 cents = KSh 50 drift — under

    const result = await runReconciliation('p-1')

    expect(result.escrowDrift.thresholdCents).toBe(100000)
    expect(result.escrowDrift.drifted).toBe(1)
    expect(result.escrowDrift.alerted).toBe(0)
    expect(result.escrowDrift.projects[0]).toMatchObject({ driftCents: '-5000', consistent: false })
    expect(state.events.size).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('no escrow wallets at all → honest nothing-to-check', async () => {
    const result = await runReconciliation('p-1')
    expect(result.escrowDrift).toMatchObject({ checked: 0, drifted: 0, alerted: 0 })
    expect(result.escrowDrift.note).toContain('No escrow wallets')
    expect(state.events.size).toBe(0)
  })

  it('persistence cap: >10 wallets → 10 entries (drifted first), projectsOmitted counts the rest — but EVERY drifted wallet still alerts', async () => {
    seedProject('p-1', 20) // oldest — the A-1-lite resolve target
    seedEscrowWallet('p-1', 100_000n)
    seedEscrowLedger('p-1', 100_000n)
    for (let i = 2; i <= 12; i++) {
      const pid = `p-${String(i).padStart(2, '0')}`
      seedProject(pid, 20 - i)
      seedEscrowWallet(pid, 10_000n)
      seedEscrowLedger(pid, i % 3 === 0 ? 9_000n : 10_000n) // p-03, p-06, p-09, p-12 drift
    }

    const result = await runReconciliation('p-1')

    expect(result.escrowDrift.checked).toBe(12)
    expect(result.escrowDrift.drifted).toBe(4)
    expect(result.escrowDrift.alerted).toBe(4)
    expect(result.escrowDrift.projects).toHaveLength(10)
    expect(result.escrowDrift.projectsOmitted).toBe(2)
    // the four drifted entries are all inside the persisted prefix
    expect(result.escrowDrift.projects.filter((p) => !p.consistent).map((p) => p.projectId)).toEqual([
      'p-03', 'p-06', 'p-09', 'p-12',
    ])
    // the cap never bounds ALERTING — all four drifted wallets got their event
    expect(eventsOf('escrow.drift')).toHaveLength(4)
  })
})

// ------------------------------------------- A-1-lite half (still intact)

describe('runReconciliation — the A-1-lite half (issue #212 regression pins)', () => {
  beforeEach(() => {
    seedProject('p-1')
    seedEscrowWallet('p-1', 100_000n)
    seedEscrowLedger('p-1', 100_000n)
  })

  it('A-1-lite drift → ledger.reconciled still fires and notifies the contractor', async () => {
    // a milestone ledger row whose MJP- reference matches no released milestone
    state.transactions.set('tx-1', {
      id: 'tx-1', projectId: 'p-1', type: 'milestone', method: 'escrow',
      amount: 30_000n, reference: 'MJP-zzzzzz', date: new Date(),
    })

    const result = await runReconciliation('p-1')

    expect(result.consistent).toBe(false)
    expect(result.drift).toBe(300)
    const events = eventsOf('ledger.reconciled')
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBe('p-1')
    const calls = notifyCalls()
    expect(calls).toHaveLength(1)
    expect((calls[0][3] as { audienceRole: string }).audienceRole).toBe('contractor')
    expect((calls[0][3] as { kind: string }).kind).toBe('ledger.reconciled')
    expect(calls[0][1]).toContain('drift')
  })

  it('consistent A-1-lite run → no ledger.reconciled event (drift-gated emission — the scheduled job stays quiet when healthy)', async () => {
    const result = await runReconciliation('p-1')
    expect(result.consistent).toBe(true)
    expect(eventsOf('ledger.reconciled')).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------- the JobRecord payload

describe('runReconciliation — drain cycle persists the full result JSON', () => {
  it('the jobs drainer runs a queued reconciliation row to done with the escrowDrift payload (cents as strings)', async () => {
    seedProject('p-1')
    seedEscrowWallet('p-1', 90_000n)
    seedEscrowLedger('p-1', 80_000n)

    expect(typeof JOB_HANDLERS.reconciliation).toBe('function')
    const row = await enqueue('reconciliation', 'p-1', {})
    const { ran, results } = await runDueJobs(10)

    expect(ran).toBe(1)
    const first = results[0] as { id: string; type: string; status: string; result: string | null }
    expect(first.id).toBe(row.id)
    expect(first.type).toBe('reconciliation')
    expect(first.status).toBe('done')
    const parsed = JSON.parse(first.result ?? '{}') as Record<string, unknown>
    expect(parsed.projectId).toBe('p-1')
    expect(parsed.consistent).toBe(true)
    expect(typeof parsed.drift).toBe('number')
    expect(parsed.note).toContain('backed')
    expect(parsed.breakdown).toMatchObject({ releases: 0, unreconciledCount: 0 })
    const escrow = parsed.escrowDrift as Record<string, unknown>
    expect(escrow.checked).toBe(1)
    expect(escrow.drifted).toBe(1)
    expect(escrow.alerted).toBe(1)
    expect(escrow.thresholdCents).toBe(1)
    const entry = (escrow.projects as Array<Record<string, unknown>>)[0]
    expect(entry.driftCents).toBe('-10000') // decimal STRING — BigInts don't survive JSON
    expect(entry.consistent).toBe(false)
    // the alert fired through the drain cycle too
    expect(eventsOf('escrow.drift')).toHaveLength(1)
    // done rows never re-run
    const second = await runDueJobs(10)
    expect(second.ran).toBe(0)
  })
})

// ------------------------------------------------- the periodic seed

describe('ensureReconciliationScheduled — the schedule keeper (issue #212)', () => {
  beforeEach(() => {
    seedProject('p-1')
  })

  it('fresh install state (a project, no reconciliation rows) → seeds ONE due row; a second call right after dedupes', async () => {
    const seededAt = await ensureReconciliationScheduled()
    expect(seededAt).not.toBeNull()
    const rows = reconciliationJobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('queued')
    expect(rows[0].projectId).toBeNull() // cross-project check
    expect((rows[0].runAt as Date).getTime()).toBeLessThanOrEqual(Date.now()) // due now — same-drain pickup

    const again = await ensureReconciliationScheduled()
    expect(again).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(1)
  })

  it('a queued manual POST row is the row the dedupe sees — the seed never stacks a second one', async () => {
    await enqueue('reconciliation', 'p-1', {}) // exactly what POST /api/jobs/run {type} does
    const seededAt = await ensureReconciliationScheduled()
    expect(seededAt).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(1)
    expect(reconciliationJobRows()[0].projectId).toBe('p-1')
  })

  it('a retrying row also blocks the seed (a failing check must not double-book)', async () => {
    await enqueue('reconciliation', null, {})
    const row = reconciliationJobRows()[0]
    row.status = 'retrying'
    row.runAt = new Date(Date.now() + 8 * 60_000)
    expect(await ensureReconciliationScheduled()).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(1)
  })

  it('a done row younger than the interval (default daily) → skip; older → seed a fresh one', async () => {
    const recent = await enqueue('reconciliation', null, {})
    state.jobs.get(recent.id)!.status = 'done'
    state.jobs.get(recent.id)!.runAt = new Date(Date.now() - 5 * 60_000)
    expect(await ensureReconciliationScheduled()).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(1)

    state.jobs.get(recent.id)!.runAt = new Date(Date.now() - 3 * 86_400_000) // 3 days ago
    const seededAt = await ensureReconciliationScheduled()
    expect(seededAt).not.toBeNull()
    expect(reconciliationJobRows()).toHaveLength(2)
  })

  it('RECONCILIATION_CHECK_INTERVAL_MIN is honored (a 2h-old done row seeds on a 60-min interval)', async () => {
    process.env.RECONCILIATION_CHECK_INTERVAL_MIN = '60'
    const row = await enqueue('reconciliation', null, {})
    state.jobs.get(row.id)!.status = 'done'
    state.jobs.get(row.id)!.runAt = new Date(Date.now() - 2 * 3_600_000)
    expect(await ensureReconciliationScheduled()).not.toBeNull()
    expect(reconciliationJobRows()).toHaveLength(2)
  })

  it('no projects at all → nothing to reconcile, no row (the handler would only throw "No project found")', async () => {
    state.projects.clear()
    expect(await ensureReconciliationScheduled()).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(0)
  })

  it('storage errors are swallowed — a broken seed never fails the drain it lives in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.failNextJobFindFirst = true
    expect(await ensureReconciliationScheduled()).toBeNull()
    expect(reconciliationJobRows()).toHaveLength(0)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('scheduled reconciliation')
    error.mockRestore()
  })
})

// ---------------------------------------------------------------- env parsing

describe('env parsing — ignore-invalid, honest defaults', () => {
  it('escrowDriftThresholdCentsFromEnv: unset → 1 cent (the chip exact-equality convention, #122)', () => {
    expect(escrowDriftThresholdCentsFromEnv({})).toBe(DEFAULT_ESCROW_DRIFT_ALERT_CENTS)
    expect(DEFAULT_ESCROW_DRIFT_ALERT_CENTS).toBe(1)
  })

  it('escrowDriftThresholdCentsFromEnv: invalid (non-integer / < 1) warns once and falls back; valid integers pass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['banana', '0', '-3', '2.5', '']) {
      expect(escrowDriftThresholdCentsFromEnv({ ESCROW_DRIFT_ALERT_CENTS: bad })).toBe(1)
    }
    expect(warn).toHaveBeenCalledTimes(4) // '' is just unset — no warn
    expect(String(warn.mock.calls[0][0])).toContain('ESCROW_DRIFT_ALERT_CENTS')
    expect(escrowDriftThresholdCentsFromEnv({ ESCROW_DRIFT_ALERT_CENTS: '250' })).toBe(250)
    warn.mockRestore()
  })

  it('reconciliationCheckIntervalMinFromEnv: unset → daily; invalid → warn + daily; fractional minutes pass', () => {
    expect(reconciliationCheckIntervalMinFromEnv({})).toBe(DEFAULT_RECONCILIATION_CHECK_INTERVAL_MIN)
    expect(DEFAULT_RECONCILIATION_CHECK_INTERVAL_MIN).toBe(1440)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(reconciliationCheckIntervalMinFromEnv({ RECONCILIATION_CHECK_INTERVAL_MIN: '-5' })).toBe(1440)
    expect(reconciliationCheckIntervalMinFromEnv({ RECONCILIATION_CHECK_INTERVAL_MIN: 'abc' })).toBe(1440)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain('RECONCILIATION_CHECK_INTERVAL_MIN')
    expect(reconciliationCheckIntervalMinFromEnv({ RECONCILIATION_CHECK_INTERVAL_MIN: '60' })).toBe(60)
    expect(reconciliationCheckIntervalMinFromEnv({ RECONCILIATION_CHECK_INTERVAL_MIN: '0.5' })).toBe(0.5)
    warn.mockRestore()
  })
})
