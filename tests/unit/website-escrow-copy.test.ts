/**
 * Escrow-language alignment (issue #138 / audit WD-3). The website marketed
 * "Escrow-style milestone releases" in three spots while /wallet's honesty
 * band says "There is no escrow custody and no regulatory licence behind the
 * wallet." — the sharpest copy-level contradiction in the funnel: the hedge
 * ("style") borrowed the trust language of a regulated product the platform
 * explicitly says it is not. The app actually implements an ESCROW ledger
 * account plus client approval gates — record-keeping, not custody — so the
 * metaphor everywhere is now APPROVAL-GATED. This file pins the issue's four
 * acceptance criteria against the REAL source files:
 *
 *  · AC 1 — the three marketing spots (/solutions/client gains, /platform
 *    wallet-module-card description + cap chip, /platform approvals
 *    deep-dive bullet) carry "Approval-gated" phrasing and ZERO "escrow";
 *  · AC 2 — the demo-data decision: sections/wallet.tsx's "Escrow top-up —
 *    client M-Pesa" ledger row KEEPS its name (it sits inside a
 *    DemoChip-labelled mockup and names the ESCROW ledger account that
 *    genuinely exists in the app), and that keep is pinned together with the
 *    DemoChip usage so it can never silently lose its demo labelling;
 *  · AC 3 — the website-wide `rg -i escrow mjengoos-website/` sweep returns
 *    ONLY the honesty/negation contexts (/wallet honesty band, /terms) and
 *    the deliberate demo datum; any NEW "escrow" anywhere else in the site
 *    fails here until it is reworded or deliberately allowlisted;
 *  · AC 4 — no meaning lost: every replacement still conveys "money waits
 *    for your approval" (approve-before-money-moves, committed-until-
 *    approved, approved-against-evidence).
 *
 * The app side is pinned too (the issue's "both surfaces" reading): the two
 * wallet strings that asserted escrow BEHAVIOR (money.wallet.note
 * "Milestone-based escrow", money.topup.desc "held in escrow") now use
 * approval-gated/committed language in BOTH dictionaries (en + sw), while the
 * internal-account-name labels ("MjengoPay escrow wallet" — the wallet the
 * e2e suite pins) and the simulated-rails disclosure (money.posture.note,
 * the app's anchor of truth) keep their escrow wording deliberately.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const SITE_ROOT = fileURLToPath(new URL('../../mjengoos-website', import.meta.url))
const readSite = (rel: string) => readFileSync(`${SITE_ROOT}/${rel}`, 'utf8')

const ROLES_TS = readSite('data/roles.ts')
const MODULE_GRID_TSX = readSite('app/platform/components/module-grid.tsx')
const APPROVALS_TSX = readSite('app/platform/components/approvals-deep-dive.tsx')
const WALLET_SECTION_TSX = readSite('sections/wallet.tsx')
const HONESTY_BAND_TSX = readSite('app/wallet/components/honesty-band.tsx')
const TERMS_TSX = readSite('app/terms/page.tsx')

// ------------------------------------------- AC 1 — the three marketing spots

describe('website escrow copy — the three marketing spots say approval-gated (#138)', () => {
  it('/solutions/client gains: "Approval-gated milestone releases — you approve before money moves."', () => {
    expect(ROLES_TS).toContain('"Approval-gated milestone releases — you approve before money moves."')
    expect(ROLES_TS).not.toMatch(/escrow/i)
  })

  it('/platform wallet module card: description + cap chip approval-gated, evidence + ledger intact', () => {
    // AC 4 — the replacement keeps the meaning: releases wait for approval,
    // are approved against evidence, and sit on the append-only audit ledger.
    expect(MODULE_GRID_TSX).toContain(
      'Approval-gated milestone releases, approved against evidence, with an append-only audit ledger behind every movement.',
    )
    expect(MODULE_GRID_TSX).toContain('"Approval-gated releases"')
    expect(MODULE_GRID_TSX).not.toMatch(/escrow/i)
  })

  it('/platform approvals deep-dive: bullet titled "Approval-gated release", meaning intact', () => {
    expect(APPROVALS_TSX).toContain('title: "Approval-gated release"')
    // AC 4 — the honest mechanism sentence already was approval language;
    // it must survive the title change untouched.
    expect(APPROVALS_TSX).toContain('Funds stay committed to the milestone until the client approves.')
    expect(APPROVALS_TSX).not.toMatch(/escrow/i)
  })
})

// ------------------------------------------- AC 2 — the deliberate demo datum

describe('website escrow copy — the demo ledger row keeps its ESCROW name deliberately (#138)', () => {
  it('sections/wallet.tsx "Escrow top-up — client M-Pesa" stays, inside a DemoChip-labelled mockup', () => {
    // Decision (issue AC 2): KEEP. The row is demo data inside a
    // DemoChip-labelled mockup and names the ESCROW ledger account that
    // genuinely exists in the app — renaming it would make the mockup LESS
    // faithful to the real ledger it depicts.
    expect(WALLET_SECTION_TSX).toContain('"Escrow top-up — client M-Pesa"')
    // The keep is only honest while the demo labelling is rendered with it.
    expect(WALLET_SECTION_TSX).toMatch(/import \{[^}]*DemoChip[^}]*\} from/)
    expect(WALLET_SECTION_TSX).toMatch(/<DemoChip/)
  })
})

// ------------------------- AC 3 — website-wide sweep (rg -i escrow, codified)

describe('website escrow copy — case-insensitive sweep returns only negations + the demo datum (#138)', () => {
  // Walk every text file under mjengoos-website/ (source, docs, config;
  // node_modules/.next/build artifacts excluded) and collect every file that
  // mentions "escrow". The allowlist IS the acceptance criterion:
  //   · honesty-band.tsx — the /wallet negation ("no escrow custody")
  //   · terms/page.tsx   — the /terms negation ("does not … hold client
  //                        money in escrow")
  //   · sections/wallet.tsx — the deliberate DemoChip demo datum (AC 2)
  // Anything else — a new marketing spot, a stray README mention — fails
  // here until it is either reworded or deliberately added to this list.
  const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|txt|html|ya?ml|toml)$/
  const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage'])

  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) out.push(...walk(full))
      } else if (TEXT_EXT.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  const ALLOWED = [
    'app/wallet/components/honesty-band.tsx',
    'app/terms/page.tsx',
    'sections/wallet.tsx',
  ]

  it('every "escrow" under mjengoos-website/ lives in exactly the three allowlisted files', () => {
    const hits = walk(SITE_ROOT)
      .filter((f) => /escrow/i.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SITE_ROOT, f))
      .sort()
    expect(hits).toEqual([...ALLOWED].sort())
  })

  it('the two negation anchors still negate escrow (the honesty copy is untouched)', () => {
    // /wallet — the anchor of truth the issue says to keep as-is.
    expect(HONESTY_BAND_TSX).toContain(
      'There is no escrow custody and no regulatory licence behind the wallet.',
    )
    // /terms — the denial sentence, in its denying context.
    expect(TERMS_TSX).toMatch(/does not take deposits, hold client money in escrow/)
  })
})

// ------------------------------------- app wallet copy — en + sw dictionaries

describe('app wallet copy — approval-gated in BOTH dictionaries (#138)', () => {
  it('money.wallet.note (MjengoPay wallet card) drops the escrow metaphor, keeps the approval gate', () => {
    expect(enDict['money.wallet.note']).toBe(
      'Approval-gated milestones — money moves only on client-approved, photo-proven work',
    )
    expect(swDict['money.wallet.note']).toBe(
      'Hatua zenye lango la uidhinishaji — pesa husogea tu kwa kazi aliyoiidhinisha mteja, iliyo na uthibitisho wa picha',
    )
    expect(enDict['money.wallet.note']).not.toMatch(/escrow/i)
    expect(swDict['money.wallet.note']).not.toMatch(/escrow/i)
  })

  it('money.topup.desc (top-up dialog) says committed-until-approved, not "held in escrow"', () => {
    expect(enDict['money.topup.desc']).toBe(
      'Funds stay committed to the milestone and are released only when the client approves.',
    )
    expect(swDict['money.topup.desc']).toBe(
      'Pesa zinabakia zimepangwa kwa ajili ya hatua na hutolewa tu baada ya mteja kuidhinisha.',
    )
    expect(enDict['money.topup.desc']).not.toMatch(/escrow/i)
    expect(swDict['money.topup.desc']).not.toMatch(/escrow/i)
  })

  it('deliberate keeps: the internal account NAME and the simulated-rails disclosure still say escrow', () => {
    // The app genuinely implements an ESCROW ledger account — naming it is
    // record-keeping, not a trust claim. The e2e suite pins this title, and
    // money.posture.note is the app-side anchor of truth (pinned in detail
    // by i18n.test.ts): it must keep DISCLOSING the escrow rails as simulated.
    expect(enDict['money.wallet.title']).toBe('MjengoPay escrow wallet')
    expect(swDict['money.wallet.title']).toBe('Pochi ya escrow ya MjengoPay')
    expect(enDict['money.posture.note']).toContain('escrow')
    expect(enDict['money.posture.note']).toContain('simulated')
    expect(swDict['money.posture.note']).toContain('escrow')
    expect(swDict['money.posture.note']).toContain('mfano')
  })
})
