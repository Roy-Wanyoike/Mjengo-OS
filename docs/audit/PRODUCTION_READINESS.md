# MjengoOS — Production Readiness (2026-09-16 wave)

**Verdict: READY WITH APPROVED RISKS — and measurably harder than yesterday.**
Production-ready for customer onboarding in its documented posture
(single-operator, Kenya sandbox rails, honest seams), with the register below.
Real-money operation additionally requires the P1 register items (integer-cents
money, E2E automation, membership authz) — by design, not by accident.

## Gate status (this wave)

| Gate | main @ 8b0003a | fix/audit2-security | fix/audit2-data |
|---|---|---|---|
| vitest | 71 / 1,811 ✅ | 73 / 1,852 ✅ | 74 / 1,847 ✅ |
| eslint | 0 ✅ | 0 ✅ | 0 ✅ |
| tsc --noEmit | 0 ✅ | 0 ✅ | 0 ✅ |
| migration drift | zero ✅ | n/a | zero ✅ |
| seeds vs new constraints | n/a | n/a | ✅ re-validated |

## The 2026-09-16 production checklist

- **Build**: green (all surfaces compile; standalone Docker verified in code).
- **Tests**: 1,811 baseline re-verified + 77 wave tests added; E2E automation still missing (TEST-1, P1).
- **APIs**: 60 paths inventoried; OpenAPI 29/29; no stubs; CSRF gate now default-on (SEC-1 fixed).
- **Database**: zero drift; unique constraints + hot-path indexes added (DB-6/7/8); inventory atomicity fixed (DB-2); Float money remains the known real-money blocker (DB-1, P1).
- **Finance**: idempotency strong (re-verified); ledger enforcement service-level (DB-3); simulated rails labeled (#43).
- **Inventory**: derived stock now validated + atomic (DB-2 fixed); reconciliation landed (#194 — count sessions with expectedQty snapshots, variance view, count-linked `adjusted` movements with `count:<id>` lineage, history + CSV; posting refuses doubles and never edits the movement ledger).
- **Offline**: versioned sync + conflict metadata verified; supplier portal online-only (FE-4, P2).
- **AI**: provider-gated, never-approves posture verified in code; zero canned responses.
- **Security**: IDOR sweep pass; 5 findings fixed this wave (SEC-1/2/3/4 + FE-1); remaining: SEC-5/6 + share-link expiry (P2).
- **UX**: 14 surfaces working; i18n 2,049-key parity with known EN-only sub-surfaces (FE-3, P2).
- **Website**: 19 routes working; CTAs/SEO pass; leads hardening (WD-1, P2).
- **Operations**: health endpoint good; backups/restore + observability + CI execution remain (INF-7, OBS-1/2, #98).

## Honest-open externals

#40 USSD telco gateway · #43 M-Pesa production certification · #41 native app
(ADR-0001) · #98 CI billing lock (owner action). Each has documented
workaround and does not fake success.

## Remaining to real-money production (P1 register)

1. DB-1 integer-cents money (Supabase design already specifies the target).
2. TEST-1 Playwright E2E golden paths.
3. SEC-6 project-membership authorization.
Then the Supabase cutover (ADR-0002) lands DB-level ledger enforcement,
tenant RLS, and NUMERIC money in one move.
