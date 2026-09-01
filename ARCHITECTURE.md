# MjengoOS — Architecture

MjengoOS is a Construction Site Operating System for Kenya and the wider African market:
offline-first, evidence-driven, financially honest, AI-assisted.

This repo is the **application workspace**: a Next.js 16 + TypeScript monolith
(App Router, React 19, Tailwind 4, shadcn/ui, Prisma/SQLite) that implements the full
product domain. It runs as a single deployable web app + PWA.

---

## Current architecture (this repo)

```text
Next.js 16 (App Router, RSC shell + client app)
  ├── UI:            src/components/mjengo/** (tab surfaces, role-aware)
  ├── Client state:  src/hooks/use-mjengo.ts (zustand + persisted offline outbox)
  ├── API:           src/app/api/** (actions dispatch, sync, search, upload, jobs,
  │                  notifications, ai/*, v1/wallets, v1/payments, ussd, flags)
  └── Domain:        src/modules/** — each module = service + policy + types
        ├── ledger    double-entry accounts/transactions/entries (source of truth)
        ├── wallet    escrow, payment requests, provider seam (SimulatedProvider)
        ├── supply    requests → approvals → quotes → POs → deliveries → site store
        ├── inventory append-only stock movements, derived closing stock
        ├── invoices  lifecycle, 3-way match (PO ↔ invoice ↔ delivery)
        ├── land      parcels, documents, registry search, property passport
        ├── professionals verified directory + credential checks
        ├── intel     risk engine, health score, digest, price intelligence
        ├── notify    in-app notifications (deliveryStatus honesty)
        ├── events    domain event bus (in-process, durable rows)
        └── jobs      background job queue (JobRecord) with guarded run endpoint
```

**Rules that are non-negotiable in this codebase:**

1. **Ledger is the source of truth.** Balances are derived from balanced double-entry
   postings; legacy transaction rows are decorated with `ledgerTxnId`, never trusted alone.
2. **Frontend never touches the DB.** All mutations go through guarded API routes with
   role allowlists; every action writes an audit event (actor, entity, ip, requestId).
3. **No fake features.** Simulated rails (payments, SMS, USSD, AI confidence) are labeled
   honestly at the seam and in the UI. Verification ladders never claim government
   certification.
4. **Offline-first.** Mutations queue in a persisted outbox, sync is idempotent
   (`Idempotency-Key` + outbox dedupe), reconnection auto-drains.
5. **Every claim carries evidence** (photos, GPS, timestamps, approval rows, ledger refs).

---

## Production target architecture (migration roadmap)

The monolith is deliberately structured so each `src/modules/*` domain maps 1:1 to a
future extracted service. When scale or reliability requirements demand it, migrate in
this order — each step is independently valuable:

| Capability | Target technology | Trigger to migrate |
|---|---|---|
| Web clients | Next.js 16 + React 19 (keep) + Expo/React Native field app | Field crews need native camera/GPS/push beyond PWA |
| API contract | REST + OpenAPI 3.1 generated from `/api/v1` | External integrators / SDK consumers appear |
| Core backend | Java 25 LTS + Spring Boot modular monolith (modules mirror `src/modules/*`) | Team grows beyond TypeScript; or need for Spring's transactional tooling |
| Database | PostgreSQL 18 + PostGIS | Multi-tenant scale, real geospatial queries ("cement within 15km of site") |
| Durable workflows | Temporal (approvals, payments, delivery, document processing) | Long-running sagas need crash-resume guarantees beyond JobRecord |
| Event streaming | NATS JetStream | Service extraction requires durable cross-service events |
| Cache/coordination | Redis | Multi-instance deploys, distributed rate limiting |
| Object storage | S3-compatible / Cloudflare R2 (no egress fees) | Media volume outgrows local disk (`/public/photos`) |
| Identity | Keycloak (OIDC, orgs, MFA) | Enterprise SSO / multi-org requirements |
| Search | OpenSearch | Full-text + faceted search over projects/suppliers/documents |
| Observability | OpenTelemetry → Prometheus + Loki + Tempo + Grafana | Production SLAs require tracing across the request path |
| Deployment | Docker → Kubernetes + Helm + Terraform + Argo CD | HA / zero-downtime requirements |
| Analytics | ClickHouse + Parquet on object storage | High-volume event analytics |

**AI layer:** provider-agnostic by design. All AI features (vision progress estimates,
anomaly scans, voice parsing, recaps, document extraction) call an internal seam
(`src/lib/ai.ts` → z-ai SDK today) so providers can be swapped without touching domain
logic. AI results are always labeled with confidence and require human application —
AI never writes official records directly.

**Payments:** `PaymentProvider` abstraction (`src/modules/wallet/providers.ts`).
`SimulatedProvider` today; M-Pesa Daraja / card rails plug in behind the same seam with
idempotent replay keys already enforced.

---

## Sandbox constraints (why some things are "simulated")

This workspace runs a single Next.js instance with SQLite and no external credentials.
Therefore: payment rails, SMS/USSD gateways, push notifications, and government registry
APIs are **honestly simulated** behind real seams. No secret ever ships in the repo.
See README for the full honesty map.
