# MjengoOS Database — Technical Deep-Dive

**Document status:** v1.0 · 2026-08-28 · Author: Technical Documentation Engineer (Task 14-b)
**Source of truth:** `prisma/schema.prisma` (36 models, SQLite via `DATABASE_URL=file:../db/custom.db`, `prisma-client-js` generator). Every field, relation and constraint below was read from the schema; every "who reads/writes" claim was verified by grepping `src/` and `prisma/`.

---

## 1. Model inventory by domain (36 models)

### Identity & Access (1)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **User** | NextAuth credentials account | `email String @unique`, `passwordHash` (scrypt `salt:hash`), `name`, `role` (`contractor` default · `client` · `admin`), `projectId String?` (the client user's project — client-role login boots that project) | Written: `prisma/seed-extras/users.ts` (3 demo users), read by `src/lib/auth.ts` `authorize()` |

### Projects & Site Ops (12)

| Model | Purpose | Key fields & relations | Written/read by |
|---|---|---|---|
| **Project** | The root aggregate: one build | `shareToken @unique @default(cuid())`, `name`, `client`, `clientType` (diaspora/local/company), `location`, `budget Float`, `startDate`, `targetDate`, `status` (active/completed/on_hold); relations to nearly everything (phases, workers, deliveries, consumptions, photos, alerts, attendances, transactions, recaps, auditEvents, escrowWallet?, milestones, variations, photoComments, zones, notifications, parcels, supplyOrders, riskSignals, intelDigests, riskAssessments, ussdSessions) | `lib/mjengo.ts` (create via `/api/projects` POST, update, share.regenerate), read everywhere |
| **Phase** | Budget-bearing project phase | `projectId → Project (Cascade)`, `name`, `order Int`, `budget Float`, `status` (pending/in_progress/done), `progressManual Int?` (manual override, falls back to task average), `tasks Task[]` | `mjengo.ts` phase.create/update (+budget rescale on project.update), `/api/projects` POST templates (bungalow/maisonette/duplex/blank), `actions/money.ts` variation budget adjust |
| **Task** | Unit of work inside a phase | `phaseId → Phase (Cascade)`, `title`, `status` (pending/in_progress/done/blocked), `progress Int` (0-100), `dueDate?` | `mjengo.ts` task.create/update/delete |
| **Worker** | Fundi on the roster | `projectId → Project (Cascade)`, `name`, `role` (Kenyan trade titles), `phone`, `pin String?` (4-digit kiosk PIN), `dailyRate Float`, `active Boolean` (soft deactivation) | `mjengo.ts` worker.create/update; read by USSD service phone lookup |
| **Attendance** | One worker-day record; the trust-critical table | `workerId → Worker (Cascade)`, `projectId`, `date String` (YYYY-MM-DD, EAT), `checkIn/checkOut DateTime?`, `status` (present/absent/half_day/excused), `method` (geofence/ussd/app/kiosk_pin/qr_card/manager), `wage Float`, `paid Boolean`, `synced Boolean`, **`verification`** (verified/reported/exception — the reported-vs-verified distinction), `evidence String?` (JSON array), `exceptionReason/exceptionNote`, **`overrideLog String?`** (append-only JSON array of `{at,by,from,to,reason}` — never erased), `recordedBy` | `mjengo.ts` checkin/setStatus, `actions/trust.ts` record/exception/override/payroll, USSD service (creates `reported` rows), `wages.pay` |
| **SiteZone** | Interactive site-map zone (schematic % coords over a plan image) | `projectId (Cascade)`, `name`, `x/y/w/h Float` (percent 0-100) | `actions/evidence.ts` zone.create/delete (delete untags photos via `sitePhoto.updateMany`) |
| **SitePhoto** | Evidence photo + AI analysis | `projectId (Cascade)`, `phaseId? → Phase (SetNull)`, `zoneId String?` (denormalized tag, no FK), `url`, `caption?`, `analysis String?` (JSON from VLM), `progressPct Int?` | `mjengo.ts` photo.apply (AI analysis attach + phase progress bump), `/api/upload` writes the file it points at |
| **PhotoComment** | Client question pinned on a photo | `photoId → SitePhoto (Cascade)`, `projectId`, `author`, `role` (client/contractor/foreman), `message`, `resolved Boolean` | `actions/evidence.ts` comment.add/resolve |
| **Alert** | Anomaly/budget/safety/attendance/progress alert | `projectId (Cascade)`, `type`, `severity` (info/warning/critical), `title`, `message`, `acknowledged Boolean` | Written by `/api/ai/anomaly-scan` (≤4 per scan), `alert.ack` action; seeded |
| **Material** | Global material catalog (not per-project) | `name`, `unit` (bag/tonne/piece/roll/kg/metre), `unitPrice Float` (indicative KES) | `mjengo.ts` material.create (case-insensitive duplicate check — SQLite has no insensitive mode) |
| **Delivery** | Material delivery onto site | `projectId (Cascade)`, `materialId → Material`, `quantity/unitCost/totalCost Float`, `supplier String`, `date`, `source` (manual/voice/photo/mpesa), `rawTranscript String?` | `mjengo.ts` delivery.create (also auto-writes a `Transaction`), AI parse flows create these |
| **Consumption** | Material consumed from site stock | `projectId (Cascade)`, `materialId → Material`, `quantity`, `phaseName?`, `note?`, `date` | `mjengo.ts` consumption.create |

### Money (4) — MjengoPay (simulated money, real workflow)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **Transaction** | The spend ledger | `projectId (Cascade)`, `type` (wage/material/transport/other/milestone), `amount`, `method` (mpesa/cash/bank/escrow), `reference?`, `note?`, `date` | `mjengo.ts` delivery/expense/wages, `actions/money.ts` milestone release (type `milestone`, method `escrow`, ref `MJP-xxxxxx`); `transaction.delete` is a hard delete |
| **EscrowWallet** | Simulated client escrow, one per project | **`projectId String @unique`** (1:1 with Project), `balance Float @default(0)` (KES) | `actions/money.ts` escrow.topup (upsert), milestone.decide (decrement with insufficient-balance guard) |
| **Milestone** | Payment locked against proof-of-work | `projectId`, `phaseId?`, `name`, `amount`, `status` (locked → evidence_submitted → release_requested → approved/released | rejected), `evidencePhotoIds String @default("[]")` (JSON array of SitePhoto ids — the proof gate), `requestedAt/decidedAt/decidedBy/decisionNote/releasedAt` | `actions/money.ts` (full state machine) |
| **VariationOrder** | Client-approved plan change that moves the budget | `projectId`, `phaseId?`, `title`, `description`, `budgetImpact Float` (+cost / −saving), `status` (submitted/approved/rejected), `submittedBy/decidedBy/decisionNote/decidedAt` | `actions/money.ts` (approve moves phase + project budget; reject touches nothing) |

### Trust / Intelligence (4)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **AuditEvent** | **The Bias-Free Ledger** — append-only record of everything that happened | `projectId (Cascade)`, `kind` (delivery/wage/attendance/milestone/variation/escrow/photo/comment/export/project/expense/share/auth/supply/intel/land/legal/ussd…), `actor`, `role` (contractor/foreman/client/system/ai/worker), `summary` (human one-liner), `meta String?` (JSON) | Written by `logAudit` (10 call sites: `mjengo.ts` auto-log for all 37 actions + 5 domain services + `audit.ts` impl); never updated or deleted |
| **RiskSignal** | Detected risk signal with evidence refs | `projectId`, `category` (cost/schedule/trust/supply/safety), `severity` (low/medium/high), `title`, `detail`, `evidence String?` (JSON refs), `status` (open/acknowledged/resolved), `detectedAt`, `resolvedAt` | Written by seeds + `intel-service.updateSignal` (ack/resolve); read by `getIntelData` |
| **IntelDigest** | Daily site intelligence digest | `projectId`, `date String`, `headline`, `body`, `riskLevel` (low/elevated/high) | **READ-ONLY at runtime** (`intel-service` displays); written only by `prisma/seed-extras/intelligence.ts` |
| **RiskAssessment** | Verification Risk per entity — schema comment: "NEVER called a fraud score: it measures how much of the record is evidence-backed vs self-reported" | `projectId`, `entityType` (worker/supplier/milestone/parcel), `entityName`, `score Int` (0-100, higher = less verified), `band` (low 0-33 / medium 34-66 / high 67-100), `factors String` ("; "-separated), `updatedAt` | **READ-ONLY at runtime** (`intel-service` displays); written only by `prisma/seed-extras/intelligence.ts` — no recompute engine exists yet |

### Supply (3)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **Supplier** | Directory with honest trust metrics "earned from verified deliveries, never bought" | `name`, `phone`, `location`, `materials String` (", "-separated), `onTimeRate Float`, `priceFairness Float`, `totalDeliveries Int`, `verifiedDeliveries Int`, `status` (verified/watchlist/new) | `supply-service.recomputeSupplierTrust` (the ONLY runtime writer — recomputed from orders after every verification); seeded |
| **SupplyOrder** | Quoted → delivered → verified (or mismatch) | `projectId? → Project (Cascade)`, `supplierId → Supplier (Cascade)`, `materialName`, `quantity`, `unit`, `unitCost`, `marketCost` (benchmark at order time), `totalCost`, `status` (ordered/delivered/verified/mismatch/cancelled), `deliveredAt/verifiedAt`, `issue String?` (honest mismatch text) | `supply-service` create/deliver/verify |
| **PriceBenchmark** | Market price reference (KES) | `material`, `unit`, `marketPrice Float`, `source String` (e.g. "Nairobi hardware index (demo data)") | **READ-ONLY at runtime** (`supply-service.listSupplyData`, used to auto-fill the new-order dialog); written only by `prisma/seed-extras/supply.ts` |

### Land / LandVerify (8)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **LandParcel** | A parcel in the (simulated) registry, optionally linked to the project built on it | `projectId? → Project (SetNull)`, **`parcelNo @unique`** (LR number), `titleNo?`, `sizeAcres`, `location`, `county`, `ownerName`, `status` (verified/searching/caveat/attention), `notes?` | Seeded (upsert by parcelNo); read by land-service; never written at runtime |
| **TitleSearch** | A registry search record — honest misses stored as `found:false` | `parcelId? → LandParcel (SetNull)` (null = miss), `query`, `found Boolean`, `resultSummary` (honest result or miss explanation), `source @default("eRegistry (simulated)")`, `searchedBy` (session-stamped), `searchedAt` | `land-service.searchTitle` (the only runtime writer — every search, hit or miss, is recorded) |
| **Surveyor** | LSK-registered surveyor directory | **`licenseNo @unique`**, `name`, `firm`, `county`, `phone`, `verified Boolean`, `speciality` | **READ-ONLY at runtime** (land-service directory listing); written only by `prisma/seed-extras/land.ts` (5 surveyors, one deliberately unverified) |
| **ParcelDocument** | Parcel documents with OCR comparison vs registry record | `parcelId → LandParcel (Cascade)`, `docType` (title_deed/search_certificate/survey_map/beacon_certificate), `fileName`, `extractedText?`, `ocrMatchScore Int?` (%), `ocrNote?` (honest note on partial matches) | **Never touched directly at runtime** — read only via `include: { documents: true }` on parcel queries in `listLandData`; written only by `prisma/seed-extras/land.ts` (the OCR scores are seeded data, not a live pipeline) |
| **ParcelEvent** | Registry-sourced event history (transfers, caveats, searches…) | `parcelId → LandParcel (Cascade)`, `eventDate`, `eventType` (transfer/search/caveat/survey/beacon/registration/lien), `title`, `detail`, `source`, `needsAttention Boolean` | **READ-ONLY at runtime** (`listParcelEvents`, share-scoped); written only by `prisma/seed-extras/history.ts` (16 events) |
| **Professional** | Board-registered professionals (LSK/BORAQS/EBK/IQSK) | **`registrationNo @unique`**, `name`, `role` (surveyor/lawyer/engineer/architect/quantity_surveyor), `board`, `county`, `phone`, `verified`, `verifiedAt?`, `verificationSource?`, `specialization` | `professionals-service.verifyRegistration` (marks verified with source) — otherwise seeded (16 professionals) |
| **LegalReview** | Lawyer opinion request per parcel — scope-honest | `parcelId → LandParcel (Cascade)`, `scope` (title/transfer/diligence/dispute), `requestedBy` (session-stamped), `lawyerName/lawyerReg?`, `status` (requested/in_review/delivered), `coveredChecks` ("; "-separated — exactly what the opinion covers), `opinion?`, `opinionAt?` | `legal-service.requestReview` (runtime writer); one delivered opinion seeded |
| **VerificationRequest** | Verify-someone request log | `registrationNo`, `entityName?`, `entityType` (professional/surveyor/company), `status` (pending/found/not_found), `resultDetail?` (honest result text), `requestedBy`, `requestedAt` | `professionals-service.verifyRegistration` (found + not_found both logged) |

### USSD (2)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **UssdSession** | One `*384*746#` session | **`sessionId @unique`**, `phone` (normalized), `projectId?`, `purpose` (attendance/balance/help/unknown), `status` (active/completed/abandoned), `lastMenu` (state-machine key: `main`, `pin`, `pin:1`, `pin:2`, `help`), `startedAt`, `endedAt?`, `logs UssdLog[]` | `ussd-service` start/input/end |
| **UssdLog** | Step-by-step session log (menus shown / keys pressed) | `sessionDbId → UssdSession (Cascade)`, `step Int`, `direction` (ussd menu shown / user key pressed), `text`, `at` | `ussd-service.appendLog` |

### Platform / Comms (2)

| Model | Purpose | Key fields | Written/read by |
|---|---|---|---|
| **Notification** | In-app notification + WhatsApp delivery-log stub | `projectId? (Cascade)`, `kind` (recap/milestone/variation/anomaly/comment/attendance/share/system), `title`, `body`, `channel @default("in_app")` (in_app/whatsapp/sms/push — whatsapp/sms are stubs), `recipient?`, `read Boolean` | Written by `actions/money.ts` (release/variation events), `/api/ai/recap` (channel `whatsapp` log row), `actions/evidence.ts` (client comment ping); `notification.read/readAll` |
| **Recap** | 6 PM WhatsApp-style daily recap text | `projectId (Cascade)`, `day Int`, `content` (the message) | `/api/ai/recap` (LLM-generated, stored); read in project payload (take 5) |

---

## 2. ER-style overview (actual relation names from the schema)

```
User (role, projectId?) ──(client-role pinning only; no FK)──┐
                                                              │
Project ──┬── phases ──── Phase ── tasks ──── Task           │
          ├── workers ─── Worker ── attendances ─ Attendance  │
          │                       └─(workerId)───────────────┘
          ├── deliveries ─ Delivery ──(materialId)── Material
          ├── consumptions ─ Consumption ──(materialId)──┘
          ├── photos ───── SitePhoto ──(phaseId, SetNull)── Phase
          │                 └── comments ── PhotoComment
          ├── zones ────── SiteZone
          ├── alerts ───── Alert
          ├── transactions ─ Transaction
          ├── recaps ───── Recap
          ├── auditEvents ─ AuditEvent            (append-only ledger)
          ├── escrowWallet ─ EscrowWallet         (projectId @unique → 1:1)
          ├── milestones ── Milestone             (evidencePhotoIds JSON → SitePhoto ids)
          ├── variations ── VariationOrder
          ├── notifications ─ Notification
          ├── parcels ───── LandParcel ──(projectId, SetNull)
          │                    ├── events ────── ParcelEvent
          │                    ├── documents ─── ParcelDocument
          │                    ├── searches ──── TitleSearch    (parcelId, SetNull → honest miss = null)
          │                    └── legalReviews ─ LegalReview ──(lawyer by name from)── Professional
          ├── supplyOrders ─ SupplyOrder ──(supplierId, Cascade)── Supplier
          │                    └─ benchmarked against ── PriceBenchmark (no FK; material-name similarity)
          ├── riskSignals ── RiskSignal
          ├── intelDigests ─ IntelDigest
          ├── riskAssessments ─ RiskAssessment
          └── ussdSessions ─ UssdSession ── logs ── UssdLog

Professional ──(verified by)── VerificationRequest   (registrationNo string match, no FK)
Surveyor     (standalone directory; no relations)
```

Cascade rules: everything hanging off `Project` is `onDelete: Cascade` except `LandParcel.projectId` (`SetNull`) and `SitePhoto.phaseId` (`SetNull`). `Material` is a global catalog with no project scoping.

---

## 3. Integrity notes

**Unique constraints (the only indexes that exist).** `Project.shareToken`, `User.email`, `EscrowWallet.projectId`, `LandParcel.parcelNo`, `Surveyor.licenseNo`, `Professional.registrationNo`, `UssdSession.sessionId` — all `@unique`. **There are zero `@@index` declarations in the schema**: foreign-key columns (e.g. `Attendance.projectId`, `AuditEvent.projectId`) carry no explicit index. Honest note: acceptable at demo scale (SQLite scans of a few thousand rows are instant); a production posture would add indexes on the hot `projectId` filters and `Attendance.date`.

**Transactions (`db.$transaction`).** Exactly two runtime uses:
- `supply-service.recomputeSupplierTrust` — interactive transaction: read all orders + update supplier counters atomically.
- `professionals-service.verifyRegistration` — array transaction: create `VerificationRequest` + update `Professional.verified` together.

Everything else — including the money state machine (`escrow.topup`, `milestone.decide` releasing escrow + writing a Transaction + notification) — is a sequence of single writes with guards checked before each write. Honest boundary: a crash between the escrow decrement and the Transaction insert could leave the ledger momentarily inconsistent; at demo scale this is accepted (documented here, not hidden).

**No soft deletion.** `task.delete`, `transaction.delete`, `zone.delete` are hard deletes. The integrity spine is *append-only history* instead: `AuditEvent` records every mutation, `Attendance.overrideLog` preserves every status correction, and milestone/variation decision history lives in `decidedBy/decidedAt/decisionNote`. `Worker.active=false` is the one soft flag.

**Case-insensitive duplicates.** SQLite has no `mode: 'insensitive'` — `material.create` and `zone.create` do manual case-insensitive duplicate scans over all rows.

**Date handling.** "Today" is computed as EAT (`Date.now() + 3h` → ISO date) in `lib/mjengo.ts`, `actions/trust.ts`, and the USSD service — all three must stay in sync (commented in trust.ts).

**SQLite locking / seeding.** One `PrismaClient` per process (`src/lib/db.ts` dev-global singleton, `log: ['query']` in dev). The 11-script seed chain (`bun run db:seed:all`) runs strictly sequentially (`&&` in the package.json script), each script wipes only its own tables (`deleteMany`) and disconnects in `finally` — no retry loops exist or are needed because no two writers run concurrently. SQLite's single-writer model is also why the app runs as one Node process with in-memory rate limiting (see MJENGOOS_SECURITY.md).

**Seed-only models — verified (6).** These models are never written by runtime code; they are populated only by `prisma/seed*.ts` and (for 5 of 6) read by services:

| Model | Runtime reads | Runtime writes | Seed writer |
|---|---|---|---|
| RiskAssessment | `intel-service.getIntelData` | **none** | `seed-extras/intelligence.ts` |
| IntelDigest | `intel-service.getIntelData` | **none** | `seed-extras/intelligence.ts` |
| ParcelEvent | `land-service.listParcelEvents` | **none** | `seed-extras/history.ts` |
| ParcelDocument | only via `include: { documents: true }` in `listLandData` | **none** | `seed-extras/land.ts` |
| Surveyor | `land-service.listLandData` directory | **none** | `seed-extras/land.ts` |
| PriceBenchmark | `supply-service.listSupplyData` | **none** | `seed-extras/supply.ts` |

(`LandParcel` is also never runtime-written, but it is *upserted* by seeds and lives on the read path — the 6 above are the canonical "seed-written only" set. Consequence worth stating: RiskAssessment scores go stale as real attendance/orders change — a recompute engine is the top honesty gap flagged in the feature audit.)
