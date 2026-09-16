# MjengoOS — Master Feature Matrix (Phase 0.5)

Legend: ✓ = verified working (evidence in the per-surface baselines) ·
◐ = partial (gap noted) · ✗ = missing · `–` = not applicable.
Status scale: DONE / PARTIAL / MISSING / BLOCKED (external) / MOCK-DEMO
(labeled simulation). **A feature is DONE only when the whole stack works.**

| Feature | UI | API | DB | Auth | Logic | Tests | Audit | Offline | Status | Issue |
|---|---|---|---|---|---|---|---|---|---|---|
| Projects CRUD + switcher | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ POST /api/projects unlogged (API-11) | ✓ | **DONE*** | reg |
| Phases / tasks / milestones | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **DONE** | – |
| Milestone escrow ladder | ✓ | ✓ | ✓ | ✓ | ✓ (money gates this wave) | ✓ | ✓ (this wave) | – | **PARTIAL** — simulated rails (#43) | #43 |
| Evidence capture + verification | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (photo queue) | **DONE** | – |
| Photo authenticity (dHash + vision) | ✓ | ✓ | ✓ | ✓ (flag) | ✓ | ✓ | ✓ | – | **DONE** (AI-gated) | – |
| AI draw review (advisory) | ✓ | ✓ | – | ✓ | ✓ never approves | ✓ | ✓ | – | **DONE** (AI-gated) | – |
| AI trust digest + voice | ✓ | ✓ | ✓ | ✓ share link | ✓ | ✓ | ✓ | – | **DONE** (AI-gated) | – |
| AI copilot / voice log / recap / anomaly | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** (AI-gated) | – |
| AI document extraction | ✗ orphan UI | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **PARTIAL** — no consumer (API-2) | reg |
| Workforce / fundis / trust levels | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **DONE** | – |
| Attendance (incl. USSD/WhatsApp) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **DONE*** — unique(workerId,date) added this wave | – |
| Materials / BOQ / inventory | ✓ | ✓ | ✓ | ✓ | ✓ (DB-2 fixed this wave) | ✓ (this wave) | ✓ | ✓ | **DONE*** | – |
| Stock reconciliation | ◐ | ✓ | ✓ | ✓ | ✓ derived | ◐ (this wave added core) | ✓ | – | **PARTIAL** — reconciliation UI/report thin | reg |
| Procurement: request→RFQ→quotes→compare | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (outbox) | **DONE** | – |
| Purchase orders + approvals | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE*** — unique codes this wave | – |
| Deliveries + proof-of-delivery photos | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Invoices + three-way match | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Budget / actuals / variance | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Double-entry ledger | – | ✓ | ✓ | ✓ | ✓ service-level (DB-3) | ✓ | ✓ | – | **PARTIAL** — Float money (DB-1), service-only enforcement | reg |
| Wallet: deposit/withdraw/transfer | ✓ | ✓ | ✓ | ✓ finance gates | ✓ idempotent | ✓ | ✓ (this wave) | – | **PARTIAL** — simulated rails | #43 |
| M-Pesa Daraja integration | – | ✓ | ✓ | ✓ | ✓ sandbox, reconcile | ✓ | ✓ | – | **BLOCKED** — production certs | #43 |
| Payments API (v1) | – | ✓ | ✓ | ✓ | ✓ idempotency | ✓ | ✓ (this wave) | – | **DONE*** | – |
| Land / parcels / title search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Professionals directory + verification | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Client share-link view + decisions | ✓ | ✓ | ✓ | ✓ token | ✓ allowlist | ✓ | ✓ | – | **PARTIAL** — no expiry, decide powers (SEC-3 residual) | reg |
| Supplier portal | ✓ | ✓ | ✓ | ✓ scoped | ✓ | ✓ | ✓ | ✗ online-only (FE-4) | **PARTIAL** | reg |
| Supplier discovery / search | ✓ | ✓ | ✓ | ✓ | ◐ in-memory 300-row (API-12) | ✓ | – | – | **PARTIAL** | reg |
| USSD `*384#` flows | ✓ sim | ✓ | ✓ | ◐ PIN | ✓ | ✓ | ✓ | – | **MOCK-DEMO** — faithful sim, no telco | #40 |
| WhatsApp bot | ✓ | ✓ | ✓ | ◐ HMAC opt | ✓ (real writes) | ✓ | ✓ | – | **MOCK-DEMO** — sim replies | reg |
| SMS (AT) / web-push notifications | ✓ | ✓ | ✓ | ✓ | ✓ env-gated | ✓ | ✓ | ✓ push | **DONE** (seams honest) | – |
| Email notifications | ✗ | ✗ | ✗ | – | ✗ | ✗ | – | – | **MISSING** | reg |
| Documents / draw pack (PDF, hash-stamped) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **DONE** | – |
| Reports (budget variance, exports) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **DONE** | – |
| Intel / MjengoScore | ✓ | ✓ | ✓ | ✓ | ✓ deterministic | ✓ | – | – | **DONE** | – |
| Offline sync (outbox, versions, conflicts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **DONE*** — no auto-retry (FE-6) | reg |
| i18n EN/SW field surface | ✓ | – | – | – | ✓ 2,049 keys | ✓ parity gate | – | – | **PARTIAL** — sub-surfaces EN-only (FE-3) | reg |
| Auth (credentials, lockout, guards) | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | **DONE*** — SEC-1/2 fixed this wave | – |
| Health / jobs scheduler | – | ✓ | ✓ | ✓ token | ✓ | ✓ | ✓ | – | **DONE** | – |
| OpenAPI v1 contract | – | ✓ 29/29 | – | – | ✓ | ✓ | – | – | **DONE** | – |
| Marketing website (19 routes) | ✓ | ✓ contact | – | – | ✓ honest | ✓ static | – | – | **DONE*** | – |
| Observability (logs/metrics/traces) | – | ◐ health | – | – | ✗ | – | – | – | **MISSING** beyond health/audit | reg |

\* = improved by this wave's branches (`fix/audit2-security`, `fix/audit2-data`).

## Reading of the matrix

- **Core evidence-first loop is genuinely DONE end-to-end**: projects →
  phases/tasks → evidence (photos, GPS, verification) → attendance (multi-channel)
  → materials/BOQ → procurement (RFQ→quotes→PO→delivery→receiving) → invoices
  (three-way match) → ledger → milestone escrow decisions → reporting/intel.
- **The honest-seam posture holds**: every external dependency (money, telco,
  AI) is env-gated, clearly labeled, and fails toward "unavailable", never
  toward fake success. Zero accidental mocks found in production paths.
- **The P1/P2 residuals** are: real-money readiness (Float money, DB-level
  ledger enforcement — both designed and solved in the Supabase target state),
  share-link hardening (expiry + decision powers), supplier offline parity,
  i18n completion, observability, and the external seams (#40/#41/#43/#98).
