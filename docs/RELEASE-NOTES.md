# MjengoOS — Release Notes (plain language)

What shipped, wave by wave, in words a non-engineer can follow — written for
recruiters, investors and operators. Everything listed here **exists in this
repository and is pinned by tests** (1,100+ tests across 43 vitest files at
the time of writing); nothing is roadmap dressed up as shipped. What is
deliberately simulated is listed in [the honest small print](#the-honest-small-print).
For the engineering detail behind each wave, see [ARCHITECTURE.md](../ARCHITECTURE.md)
and the [README](../README.md).

---

## v0.1 — The foundation

The core product: an evidence-based construction OS for Kenya. One login
screen, seven demo roles, a 13-tab workspace covering the whole build —
phase budgets kept on a double-entry ledger (the kind of bookkeeping an
accountant can audit), escrow-backed milestones that only release against
photo proof, a procurement loop that matches purchase order ↔ supplier
invoice ↔ delivery before anyone pays, an append-only "Bias-Free Ledger"
that records every action with who/when/where, workforce attendance with
verified-vs-reported trust levels, and a `*384#` USSD line so a fundi on a
feature phone can check in without an app. Diaspora clients follow their
build through a share link — no account, and the link can be revoked.
**Why it matters:** this is the trust substrate everything later builds on —
every number a client sees traces back to evidence rows, not promises.

## v0.2 — Production posture (28 commits)

The foundation made deployable and provable. Photo/document storage moved
behind a driver seam — local disk by default, S3/Cloudflare R2/MinIO when
configured, with client-direct presigned uploads (no new dependencies:
SigV4 signing implemented with Node's own crypto). A Safaricom M-Pesa
**Daraja sandbox** provider landed behind the payment seam, with a
reconciliation sweep that re-checks payments whose callback never arrived —
money never gets invented to make a ledger look tidy. Notifications gained
preference gating and an SMS webhook seam; document extraction learned to
read PDF text server-side; transactions gained phase cost codes so budget
variance is attributed honestly (real, mixed or estimated — labeled, never
guessed); rate limiting gained an optional shared SQLite store for
multi-process deployments. And the test suite more than doubled: 495 → 899
tests, including full pinning suites for the core modules and the v1 REST
routes. **Why it matters:** the difference between a demo and a system —
deployable, observable, and every claim checkable.

## v0.2.1 — Wave 3: trust foundation (security fix, money API, MjengoScore)

Three features, one theme: trust that survives scrutiny. First, a security
review found that the offline sync path could dispatch actions for features
that had been switched off — the fix puts the flag gate on **every** mutation
path (online actions, per-item on the offline sync drain, and the share
link's allowlist), so "off" now means off, and a denied item writes nothing.
Second, the v1 REST API grew the money-governance surface: milestone release
ladders, supplier invoices with the 3-way-match verdict (PO ↔ invoice ↔
delivery), and escrow balances **derived from the ledger itself** rather than
a stored number — 19 `/api/v1` paths in total, all documented live in an
OpenAPI contract an integrator can generate an SDK from. Third, **MjengoScore**:
a deterministic 0–100 contractor trust score computed from evidence the system
already records — evidence-backed releases, verified attendance, budget pace,
variation discipline, delivery accuracy, invoice disputes. Every point of
deduction traces to countable rows; young projects get an honest "not enough
evidence" instead of a fake number; and the score deliberately gates nothing —
it describes, humans decide. Suite: 1,019 tests.

## v0.2.2 — Wave 4: diaspora proof + field reach

The wave that turns trust into a portable artifact. When a milestone releases
now, the proof **freezes**: an immutable, SHA-256-stamped "evidence draw pack"
containing the evidence photos, the ledger reference, variations open at
decision time, the attendance window and the MjengoScore at release — served
through the client's existing (revocable) share link, printable, and
forwardable to a lender who can re-verify the hash offline. Second, SMS got a
real rail: an Africa's Talking provider behind the existing notification
seam, env-gated and fail-closed (pick it or the webhook relay; with neither,
nothing pretends to send). Third, the **WhatsApp field line**: a documented
webhook contract and keyword grammar — workers text `PRESENT`, `ABSENT`,
`HALF`, `BALANCE` or free text, and real attendance and photo notes land
through the same appliers the app uses. Honest seam: no Meta Cloud API is
wired; every reply is footered "MjengoOS sim". Suite: 1,102 tests, all
browser-verified end-to-end.

## v0.2.3 — Wave 5: engagement & coverage (in flight)

Being built now, documented as in flight — not claimed as shipped. **Web push
notifications** (VAPID-gated through the notify seam, same honest `logged`
default) keep the diaspora client in the loop with the tab closed. The
**supplier-side portal** gives the marketplace's supply side its own scoped
role and surface — catalog, quotes, orders, delivery confirmation — closing
the one structural gap the marketing site honestly flagged. Kiswahili
coverage continues to hold key-for-key parity with every new feature.
**Why it matters:** retention for the paying persona, and two-sided liquidity
for the marketplace.

---

## The honest small print

- **Payment rails default to simulated.** The ledger, approval workflow,
  idempotency and reversal mechanics are real; a Daraja **sandbox** provider
  activates only when its env credentials are set. No licensed rail, no real
  money — labeled as such in the UI.
- **USSD and WhatsApp are faithful simulations** that dispatch real records
  through the real appliers; no telco gateway or Meta Cloud API is wired yet.
- **Web push is in flight** (Wave 5) and not in this build.
- **Land verification records evidence**; it never claims government registry
  confirmation.
- **AI never approves anything** — results carry confidence labels and wait
  for a human.

**Test growth across the releases:** 495 (v0.2 baseline) → 899 (v0.2 merged)
→ 1,019 (Wave 3) → 1,102 (Wave 4). Run the whole thing yourself:
`bun run test`. Screenshots: [MjengoScore](./screenshots/mjengo-score.png) ·
[draw pack](./screenshots/draw-pack.png).
