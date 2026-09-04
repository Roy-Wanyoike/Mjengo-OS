# MjengoOS — Construction Site OS 🇰🇪

> **The evidence-backed operating system for construction.**

MjengoOS is an **offline-first Construction Operating System** built for Kenya and emerging markets.

It connects **clients, developers, contractors, project managers, site supervisors, fundis, architects, engineers, quantity surveyors, surveyors, suppliers, warehouses, drivers, procurement teams, and financial systems** around one source of truth for a construction project.

Construction sites are messy, distributed, cash-heavy, and often offline.

MjengoOS turns that reality into a structured digital system without pretending that everything happened simply because someone entered it into a form.

> **Don't just record what people say happened — record the evidence around what happened.**

Every important event can be represented as:

```text
Reported
   ↓
Evidence captured
   ↓
Verified
   ↓
Recorded in the system
```

The platform brings together:

* 📸 Evidence-backed site progress
* 🤖 AI construction intelligence
* 📱 Offline-first field operations
* 👷 Workforce and fundi management
* 📦 BOQ, materials and inventory
* 🛒 Procurement and supplier discovery
* 🚚 Delivery verification
* 💰 Project finance and cost control
* 🏦 Double-entry financial ledger
* 🔐 Milestone-based payments and escrow
* 🏠 Property and land verification
* 👨🏾‍🔧 Professional verification
* 📲 USSD/SMS workflows
* 🌍 Regional supplier and material intelligence
* 👤 Remote and diaspora client visibility
* 📄 Construction document management
* 🔔 Multi-channel notifications
* 📊 Project intelligence and reporting

---

## Why MjengoOS?

Construction management software often assumes:

* reliable internet,
* smartphones for everyone,
* accurate manual reporting,
* centralized teams,
* clean procurement processes,
* trustworthy inventory updates,
* and easy access to financial systems.

Real construction sites don't work that way.

A site may have:

* intermittent connectivity,
* supervisors working from phones,
* fundis without smartphones,
* materials purchased from multiple hardware stores,
* deliveries arriving at different times,
* handwritten invoices,
* cash and mobile-money transactions,
* changing quantities,
* incomplete documentation,
* remote clients,
* multiple subcontractors,
* and project information scattered across WhatsApp, paper, spreadsheets and conversations.

MjengoOS is designed around those constraints.

### Our core principle

> **The physical world is the source of truth. Software should capture, verify, reconcile and explain it.**

---

# Core Principles

## 1. Evidence First

MjengoOS distinguishes between:

```text
Reported ≠ Verified
```

A supervisor saying that 500 bags of cement arrived is a report.

A delivery containing:

* supplier,
* purchase order,
* quantity,
* timestamp,
* location,
* receiving user,
* delivery note,
* photos,
* and proof of delivery

provides evidence.

The platform preserves that distinction.

---

## 2. AI Never Approves

AI can:

* analyze,
* classify,
* extract,
* detect,
* predict,
* recommend,
* summarize,
* and flag anomalies.

AI cannot silently approve:

* payments,
* financial transactions,
* material purchases,
* inventory adjustments,
* contractual changes,
* milestone completion,
* or other high-impact actions.

AI produces **recommendations and evidence**, while authorized humans remain accountable for decisions.

---

## 3. The Ledger Never Lies

Financial truth is maintained through an **immutable double-entry ledger**.

Transactions are not silently overwritten.

Corrections happen through compensating entries.

```text
Debit
  +
Credit
  =
Balanced transaction
```

Financial records are separated from AI recommendations and operational projections.

---

## 4. Payments Are Idempotent

Every payment operation must be safe against:

* retries,
* duplicated requests,
* duplicated callbacks,
* network failures,
* provider timeouts,
* worker crashes,
* and webhook duplication.

The same payment request must never accidentally become two payments.

---

## 5. Closing Stock Is Derived

Inventory is not simply:

```text
Current Stock = whatever someone typed
```

Instead:

```text
Opening Stock
+ Verified Receipts
+ Approved Adjustments
- Verified Issues
- Verified Consumption
- Verified Transfers
=
Closing Stock
```

Inventory movements form an auditable chain.

---

## 6. Offline Is a First-Class State

Offline operation is not an error condition.

It is a normal operating mode.

```text
ONLINE
  ↓
Capture locally
  ↓
OFFLINE
  ↓
Queue mutations
  ↓
Continue working
  ↓
NETWORK RETURNS
  ↓
Synchronize
  ↓
Validate
  ↓
Resolve conflicts
  ↓
SERVER CONFIRMS
```

---

# What MjengoOS Does

## 🏗️ Project Management

Manage an entire construction project from planning to handover.

Features include:

* project creation
* project templates
* project phases
* milestones
* tasks
* dependencies
* schedules
* Gantt views
* Kanban workflows
* project health
* project timeline
* daily site reports
* site diary
* issues
* blockers
* observations
* inspections
* punch lists
* snagging
* RFIs
* submittals
* drawings
* drawing revisions
* contracts
* variations
* change orders
* project documents

---

# 📸 Evidence & Site Intelligence

MjengoOS creates an evidence layer around the physical construction site.

Capture:

* photos
* videos
* GPS coordinates
* timestamps
* users
* devices
* site locations
* descriptions
* related tasks
* related milestones
* related deliveries
* related materials
* related issues

Evidence can be associated with project events.

Example:

```text
Material Delivery
      │
      ├── Purchase Order
      ├── Supplier
      ├── Quantity
      ├── Delivery Vehicle
      ├── GPS
      ├── Timestamp
      ├── Delivery Note
      ├── Photos
      ├── Receiver
      └── Proof of Delivery
```

This allows the project timeline to become an evidence-backed record of what happened.

---

# 🤖 AI Construction Intelligence

AI is built around project evidence rather than replacing project governance.

### AI capabilities

* construction progress analysis
* photo classification
* construction-stage detection
* visible-work analysis
* document extraction
* BOQ extraction
* invoice extraction
* quotation extraction
* receipt extraction
* drawing analysis
* contract document analysis
* voice-to-text
* Swahili voice logging
* voice-to-invoice
* voice-to-inventory
* spending anomaly detection
* material-consumption anomaly detection
* progress-vs-spending analysis
* project risk detection
* project summaries
* construction copilot
* supplier intelligence
* price intelligence
* cash-flow forecasting

### AI evidence pipeline

```text
Photo / Document / Voice
          ↓
      Object Storage
          ↓
      AI Processing
          ↓
   Structured Analysis
          ↓
    Confidence Score
          ↓
 Human Review (when required)
          ↓
      Project Record
```

Every important AI decision should preserve:

* model
* model version
* prompt/version
* timestamp
* input reference
* output
* confidence
* reviewer
* approval status

---

# 👷 Workforce & Fundi Management

Construction workers should not need a smartphone to exist in the digital system.

MjengoOS supports:

* workers
* fundis
* subcontractors
* trade leads
* supervisors
* attendance
* timesheets
* rates
* assignments
* worker profiles
* trade classification
* workforce status
* supervisor-assisted attendance
* worker trust levels

Attendance can originate from:

```text
Worker
Supervisor
USSD
Admin
```

Every attendance record maintains provenance.

Example:

```text
Worker: John
Date: 2026-09-04
Status: Present
Recorded By: Supervisor
Method: Supervisor-assisted
Time: 07:42
Location: Site
```

Corrections require an auditable reason.

MjengoOS can flag suspicious patterns as:

> **Anomaly detected — review recommended**

It does not automatically accuse workers or supervisors of fraud.

---

# 📱 Offline-First Field Operations

Construction sites must continue working when connectivity disappears.

The mobile application uses local persistence and synchronization.

Offline-capable workflows include:

* attendance
* site reports
* photos
* tasks
* material requests
* inventory operations
* delivery receiving
* inspections
* issues
* progress updates
* notes
* evidence capture

Mutations contain metadata such as:

```text
operation_id
device_id
user_id
entity_id
operation_type
payload
created_at
sync_status
```

Synchronization states:

```text
PENDING
SYNCING
SYNCED
FAILED
CONFLICT
```

Conflicts are never silently hidden.

---

# 📲 USSD & SMS

MjengoOS is designed for construction environments where not everyone owns a smartphone.

USSD/SMS workflows can support:

* attendance
* check-in
* check-out
* worker assignment confirmation
* delivery notifications
* approval notifications
* important project alerts
* payment notifications

This allows workers to participate without requiring a smartphone.

---

# 📦 BOQ, Materials & Inventory

Materials are connected from planning to physical consumption.

```text
BOQ
 ↓
Budget
 ↓
Material Request
 ↓
Procurement
 ↓
Purchase Order
 ↓
Supplier
 ↓
Delivery
 ↓
Verification
 ↓
Inventory
 ↓
Consumption
 ↓
Project Cost
```

Inventory supports:

* warehouses
* stores
* stock levels
* stock movements
* material receipts
* material issues
* transfers
* consumption
* adjustments
* reconciliation
* low-stock alerts
* batch/lot tracking where required

---

# 🛒 Procurement

MjengoOS connects project requirements with procurement execution.

Workflow:

```text
Material Request
       ↓
Budget Validation
       ↓
Inventory Check
       ↓
Supplier Discovery
       ↓
RFQ
       ↓
Quotes
       ↓
Price Comparison
       ↓
Approval
       ↓
Purchase Order
       ↓
Supplier Confirmation
       ↓
Invoice
       ↓
Payment
       ↓
Delivery
       ↓
Proof of Delivery
       ↓
Inventory Update
       ↓
Reconciliation
```

Procurement teams can compare:

* unit price
* supplier
* quantity
* availability
* delivery cost
* taxes/fees
* total landed cost
* estimated delivery time
* supplier reliability
* historical pricing

---

# 🏪 Supplier & Hardware Finder

Find construction suppliers and hardware stores by:

* county
* region
* town
* distance
* material
* price
* availability
* delivery capability
* verification status

Supplier profiles can contain:

* business information
* contacts
* location
* products
* pricing
* stock status
* minimum order quantity
* delivery options
* quotations
* invoices
* verification
* transaction history

Availability is explicitly classified.

```text
LIVE
RECENTLY VERIFIED
SUPPLIER REPORTED
UNKNOWN
```

MjengoOS never pretends supplier inventory is real-time unless there is a reliable source for that information.

---

# 🚚 Delivery & Logistics

Materials should not become inventory merely because someone created a purchase order.

Delivery workflows include:

* dispatch
* pickup
* transport assignment
* driver
* vehicle
* destination
* tracking
* delivery status
* proof of delivery
* receiving
* quantity verification
* damage reporting
* photos
* delivery notes
* inventory reconciliation

A delivery can therefore connect:

```text
Supplier
   ↓
Purchase Order
   ↓
Shipment
   ↓
Driver
   ↓
Site
   ↓
Proof of Delivery
   ↓
Inventory
```

---

# 💰 Construction Finance

MjengoOS provides project-level financial visibility.

Track:

* project budgets
* cost plans
* actual costs
* commitments
* invoices
* payment certificates
* variations
* change orders
* labor costs
* material costs
* subcontractor costs
* equipment costs
* delivery costs
* budget variance
* forecast costs
* cash flow

---

# 🏦 Universal Wallet & Financial Infrastructure

MjengoOS is designed to integrate with a reusable financial infrastructure layer.

The wallet is separated from the construction domain.

```text
MjengoOS
   │
   ▼
Wallet API
   │
   ▼
Financial Ledger
   │
   ├── M-Pesa
   ├── Bank
   ├── Mobile Money
   ├── Payment Providers
   └── Other Rails
```

The financial system supports:

* wallets
* accounts
* double-entry ledger
* payment requests
* payment approvals
* payment states
* provider integrations
* webhooks
* reconciliation
* idempotency
* transaction history
* multi-currency support
* limits
* financial audit trails

### Payment state machine

```text
REQUESTED
   ↓
VALIDATED
   ↓
APPROVED
   ↓
PROCESSING
   ↓
PENDING
   ↓
CONFIRMED
   ↓
LEDGER POSTED
   ↓
RECONCILED
```

Failures are explicit and recoverable.

---

# 🔐 Milestone Escrow

Construction payments can be linked to project milestones.

Example:

```text
Milestone Created
      ↓
Work Completed
      ↓
Evidence Submitted
      ↓
Progress Reviewed
      ↓
Milestone Approved
      ↓
Payment Authorized
      ↓
Payment Provider
      ↓
Ledger
      ↓
Recipient
```

AI may provide evidence and recommendations.

**AI does not approve financial releases.**

---

# 🏠 Property & Land Verification

Before construction begins, MjengoOS can establish a property verification record.

The property module can contain:

* parcel information
* title information
* uploaded documents
* official search results
* survey information
* boundary information
* professional verification
* ownership information where legally accessible
* encumbrances
* cautions
* restrictions
* verification status
* verification history
* red flags

Verification statuses include:

```text
VERIFIED
PARTIALLY VERIFIED
PENDING
UNABLE TO VERIFY
REJECTED
```

MjengoOS does not claim government-level verification unless the relevant official source or authorized professional confirms it.

---

# 👨🏾‍🔧 Professional Verification

Construction depends on qualified professionals.

MjengoOS supports professional profiles for:

* architects
* engineers
* quantity surveyors
* surveyors
* project managers
* contractors
* site supervisors
* inspectors
* other construction professionals

Professional records can include:

* profession
* registration authority
* registration number
* verification status
* evidence
* verification date
* project associations

The platform must never fabricate professional credentials or registration numbers.

---

# 👤 Remote & Diaspora Client Experience

A client should not have to travel to a construction site to understand what is happening.

The client dashboard provides:

* project progress
* physical progress
* budget
* spending
* remaining budget
* milestones
* recent site photos
* site reports
* materials purchased
* deliveries
* inventory
* issues
* approvals
* invoices
* documents
* project timeline
* alerts

### Remote project experience

```text
Site
 ↓
Evidence
 ↓
MjengoOS
 ↓
Verified Project State
 ↓
Client Dashboard
```

Clients can approve:

* material requests
* purchase orders
* variations
* budget changes
* invoices
* milestone completion
* payments
* contractor requests

---

# 📄 Document Intelligence

Construction produces enormous amounts of documents.

MjengoOS supports:

* BOQs
* invoices
* quotations
* receipts
* contracts
* drawings
* permits
* land documents
* delivery notes
* payment certificates
* inspection reports
* site reports

Documents can be:

```text
Uploaded
   ↓
Stored
   ↓
Indexed
   ↓
Extracted
   ↓
Classified
   ↓
Linked to Project Entities
```

AI extraction always preserves the original document.

---

# 🔔 Notifications

MjengoOS supports multi-channel notifications.

Potential channels include:

* in-app
* push
* email
* SMS
* WhatsApp
* USSD

Notifications cover:

* approvals
* payments
* deliveries
* low stock
* project risks
* milestone updates
* worker events
* procurement events
* important project changes

---

# 📊 Project Intelligence

MjengoOS provides an explainable project health model.

Health can consider:

```text
Schedule
Budget
Physical Progress
Procurement
Inventory
Quality
Safety
Attendance
Issues
```

Example:

```text
PROJECT HEALTH

Schedule       ████████░░
Budget         █████████░
Progress       ███████░░░
Procurement    █████████░
Inventory      ████████░░
Quality        █████████░
```

The system should explain **why** a project is considered healthy or at risk.

---

# 🧭 Unified Project Timeline

Every important project event can become part of a unified timeline.

Example:

```text
Project Created
      ↓
Land Verified
      ↓
BOQ Approved
      ↓
Material Requested
      ↓
Supplier Selected
      ↓
Purchase Order Approved
      ↓
Payment Completed
      ↓
Delivery Received
      ↓
Inventory Updated
      ↓
Site Progress Captured
      ↓
Inspection Completed
      ↓
Milestone Approved
      ↓
Payment Released
```

This becomes the project's operational memory.

---

# 🔐 Security & Governance

MjengoOS is designed for multi-tenant environments.

Security includes:

* organization isolation
* project-level authorization
* RBAC
* fine-grained permissions
* authentication
* session management
* audit logging
* immutable financial history
* secure file access
* signed URLs
* encryption
* secrets management
* rate limiting
* API validation
* idempotency
* abuse protection
* security headers
* structured security events

Every sensitive operation should have:

```text
WHO
WHAT
WHEN
WHERE
WHY
RESULT
EVIDENCE
```

---

# 🏛️ Architecture

MjengoOS follows a **modular architecture** designed to begin as a modular monolith while maintaining clear boundaries for future service extraction.

```text
                        ┌─────────────────────┐
                        │     Web Client       │
                        │     Next.js          │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │   Mobile Client      │
                        │ React Native / Expo  │
                        └──────────┬──────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │       API / Backend       │
                     │     Java 25 / Spring     │
                     └─────────────┬─────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
  PostgreSQL                  Temporal                    NATS
  + PostGIS                  Workflows                 JetStream
        │                          │                          │
        ▼                          ▼                          ▼
     Redis                  Long-running                 Events
                              Processes
        │
        ▼
 Object Storage
 R2 / S3
```

---

# 🧩 Domain Modules

The backend is organized around business domains.

```text
identity
organizations
projects
workforce
construction
boq
inventory
procurement
suppliers
warehouses
deliveries
finance
payments
wallet
documents
property
professionals
notifications
ai
audit
reporting
```

Each domain owns its:

* entities
* business rules
* services
* repositories
* APIs
* events
* workflows
* authorization rules
* tests

---

# 🛠️ Technology Stack

## Web

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui
* Radix UI
* TanStack Query
* React Hook Form
* Zod

## Mobile

* React Native
* Expo
* TypeScript
* SQLite
* Offline synchronization

## Backend

* Java 25 LTS
* Spring Boot
* Spring Security
* Hibernate / JPA
* Flyway
* REST
* OpenAPI 3.1

## Database

* PostgreSQL
* PostGIS

## Distributed Workflows

* Temporal

Used for long-running and failure-sensitive workflows such as:

* payments
* procurement
* deliveries
* approvals
* notifications
* AI processing
* verification
* scheduled reports

## Messaging

* NATS JetStream

Used for domain events and asynchronous processing.

## Cache

* Redis

## Identity

* Keycloak
* OpenID Connect
* OAuth 2.x

## Object Storage

* Cloudflare R2 / S3-compatible storage

Used for:

* photos
* videos
* documents
* evidence
* AI artifacts

## Infrastructure

* Docker
* Kubernetes
* Helm
* Terraform / OpenTofu
* Argo CD
* GitHub Actions

## Observability

* OpenTelemetry
* Prometheus
* Grafana
* Loki
* Tempo

## Testing

* JUnit
* Mockito
* Testcontainers
* Vitest
* Playwright

---

# 🌍 Kenya-First, Africa-Ready

MjengoOS is designed around Kenyan construction realities while maintaining an architecture that can expand across Africa.

Kenya-native considerations include:

* M-Pesa
* mobile money
* bank payments
* USSD
* SMS
* WhatsApp
* KRA-related financial workflows
* eTIMS-compatible invoice workflows where applicable
* NCA-related construction workflows
* land/property verification
* county/region-based suppliers
* local hardware stores
* local construction professionals

Future regional expansion can support:

* Tanzania
* Uganda
* Rwanda
* Ethiopia
* Ghana
* Nigeria
* South Africa
* other African markets

Localization should be treated as a domain capability rather than hardcoded business logic.

---

# 👥 Supported Roles

MjengoOS supports project-specific roles including:

* Client
* Developer
* Project Manager
* Main Contractor
* Site Manager
* Site Supervisor
* Foreman
* Clerk of Works
* Architect
* Quantity Surveyor
* Structural Engineer
* Civil Engineer
* MEP Engineer
* Land Surveyor
* Procurement Officer
* Storekeeper
* Safety Officer
* Quality Inspector
* Subcontractor
* Trade Lead
* Fundi
* Worker
* Equipment Manager
* Driver
* Supplier
* Warehouse Manager
* Finance Officer
* Organization Administrator
* Auditor
* Read-only user

A user may have different roles across different projects.

---

# 🔄 Example End-to-End Workflow

Consider a client building a house in Kenya.

```text
1. Client creates project
          ↓
2. Property information added
          ↓
3. Land verification initiated
          ↓
4. Professionals assigned
          ↓
5. BOQ uploaded
          ↓
6. BOQ extracted and reviewed
          ↓
7. Budget established
          ↓
8. Construction phases created
          ↓
9. Material request created
          ↓
10. Nearby suppliers discovered
          ↓
11. Quotes collected
          ↓
12. Quotes compared
          ↓
13. Client approves purchase
          ↓
14. Purchase order created
          ↓
15. Supplier confirms
          ↓
16. Payment initiated
          ↓
17. Payment confirmed
          ↓
18. Delivery dispatched
          ↓
19. Material arrives at site
          ↓
20. Supervisor verifies delivery
          ↓
21. Proof of delivery captured
          ↓
22. Inventory updated
          ↓
23. Workers record attendance
          ↓
24. Site photos captured
          ↓
25. AI analyzes progress
          ↓
26. Human reviews where necessary
          ↓
27. Project progress updated
          ↓
28. Milestone completed
          ↓
29. Client reviews evidence
          ↓
30. Milestone payment approved
          ↓
31. Ledger records transaction
          ↓
32. Project timeline updated
```

This is the core MjengoOS philosophy:

> **Connect money, materials, people and physical evidence into one coherent project history.**

---

# 📁 Repository Structure

A high-level repository structure:

```text
mjengo-os/
│
├── backend/
│   ├── src/
│   │   └── main/
│   │       └── java/
│   │           └── com/
│   │               └── mjengoos/
│   │                   ├── identity/
│   │                   ├── organizations/
│   │                   ├── projects/
│   │                   ├── workforce/
│   │                   ├── construction/
│   │                   ├── boq/
│   │                   ├── inventory/
│   │                   ├── procurement/
│   │                   ├── suppliers/
│   │                   ├── warehouses/
│   │                   ├── deliveries/
│   │                   ├── finance/
│   │                   ├── payments/
│   │                   ├── wallet/
│   │                   ├── documents/
│   │                   ├── property/
│   │                   ├── professionals/
│   │                   ├── notifications/
│   │                   ├── ai/
│   │                   ├── audit/
│   │                   └── reporting/
│   │
│   └── src/test/
│
├── web/
│   ├── app/
│   ├── components/
│   ├── features/
│   ├── lib/
│   └── tests/
│
├── mobile/
│   ├── app/
│   ├── features/
│   ├── database/
│   ├── sync/
│   └── tests/
│
├── website/
│   └── # Marketing website
│
├── infrastructure/
│   ├── docker/
│   ├── kubernetes/
│   ├── helm/
│   ├── terraform/
│   └── argocd/
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── security/
│   ├── operations/
│   └── product/
│
└── README.md
```

---

# 🚀 Production Engineering Principles

MjengoOS is designed for production rather than a prototype.

The platform should support:

* horizontal scaling
* graceful shutdown
* health checks
* readiness/liveness probes
* rolling deployments
* zero-downtime migrations
* backward-compatible APIs
* database migrations
* automated backups
* disaster recovery
* retry policies
* dead-letter handling
* idempotency
* distributed tracing
* metrics
* structured logging
* rate limiting
* circuit breakers
* failure isolation
* secure secrets
* audit trails
* automated testing

### Failure philosophy

A service failure should not corrupt the project.

For example:

```text
AI unavailable
    ↓
Construction operations continue
    ↓
AI analysis = PENDING
    ↓
Retry later
```

Or:

```text
Payment provider timeout
    ↓
Payment = PENDING
    ↓
Temporal retries / reconciliation
    ↓
Provider confirmation
    ↓
Ledger update
```

The system should degrade gracefully instead of pretending a failure never occurred.

---

# 🧪 Quality Standards

A feature is not considered complete simply because a screen exists.

A feature is considered production-ready only when the relevant layers exist:

```text
UI
+
API
+
Business Logic
+
Database
+
Authorization
+
Validation
+
Error Handling
+
Auditability
+
Offline Support (when required)
+
Observability
+
Tests
+
Documentation
```

No fake integrations.

No silent failures.

No placeholder business logic presented as production functionality.

No financial state stored only in frontend state.

No AI-generated result treated as unquestionable truth.

---

# 🔒 Data Integrity Invariants

The following principles are architectural invariants.

### Financial

```text
Every posted financial transaction balances.
```

### Payments

```text
Same idempotency key ≠ duplicate payment.
```

### Inventory

```text
Closing stock is derived from inventory movements.
```

### AI

```text
AI recommendations cannot directly authorize sensitive actions.
```

### Evidence

```text
Evidence retains provenance.
```

### Audit

```text
Important mutations are auditable.
```

### Offline

```text
Offline mutations are not silently discarded.
```

### Conflicts

```text
Financial and inventory conflicts require deterministic resolution or human review.
```

---

# 🗺️ Product Roadmap

## Phase 1 — Construction Foundation

* Organizations
* Users
* Roles
* Projects
* Phases
* Tasks
* Milestones
* Site reports
* Photos
* Documents
* Workforce
* Attendance
* BOQ
* Budgets
* Inventory

## Phase 2 — Procurement & Physical Operations

* Suppliers
* Warehouses
* Material finder
* Price comparison
* RFQs
* Purchase orders
* Delivery management
* Proof of delivery
* Inventory reconciliation

## Phase 3 — Financial Infrastructure

* Project finance
* Invoices
* Payment requests
* Double-entry ledger
* Wallet integration
* Payment providers
* Reconciliation
* Milestone payments
* Escrow workflows

## Phase 4 — Offline & Africa Connectivity

* Offline mobile
* Synchronization
* Conflict resolution
* USSD
* SMS
* WhatsApp
* Low-bandwidth optimization

## Phase 5 — AI Construction Intelligence

* Document intelligence
* Photo progress analysis
* Voice-to-record
* Voice-to-invoice
* AI project copilot
* Spending anomalies
* Material anomalies
* Progress intelligence
* Forecasting

## Phase 6 — Verification & Trust

* Property verification
* Surveyor verification
* Professional verification
* Contractor verification
* Evidence scoring
* Trust profiles
* Project reputation

## Phase 7 — Construction Network

* Supplier marketplace
* Professional marketplace
* Equipment marketplace
* Transport network
* Regional price intelligence
* Construction data intelligence

---

# 🧠 The MjengoOS Data Model

At the center of the platform is a relationship between:

```text
PEOPLE
  │
  ├── Workers
  ├── Professionals
  ├── Contractors
  ├── Suppliers
  └── Clients
        │
        ▼
PROJECT
        │
        ├── Property
        ├── BOQ
        ├── Budget
        ├── Schedule
        ├── Workforce
        ├── Procurement
        ├── Inventory
        ├── Deliveries
        ├── Evidence
        ├── Documents
        ├── Milestones
        ├── Issues
        └── Financial Activity
```

Everything ultimately contributes to the project's state.

---

# 🌐 The Long-Term Vision

MjengoOS is not intended to become another construction task-management application.

The long-term vision is a **Construction Operating System** where:

```text
Land
 ↓
Planning
 ↓
Professionals
 ↓
BOQ
 ↓
Budget
 ↓
Procurement
 ↓
Suppliers
 ↓
Payments
 ↓
Logistics
 ↓
Materials
 ↓
Inventory
 ↓
Workers
 ↓
Site Execution
 ↓
Evidence
 ↓
Progress
 ↓
Inspections
 ↓
Milestones
 ↓
Finance
 ↓
Completion
 ↓
Handover
```

all exist inside one connected system.

The goal is to make construction more:

**Transparent.**

**Accountable.**

**Measurable.**

**Verifiable.**

**Accessible.**

**Efficient.**

---

# 🇰🇪 Built for Kenya. Designed for Africa.

MjengoOS starts with Kenya because the problem is concrete and immediate.

But the underlying problem exists across Africa:

* fragmented construction supply chains
* unreliable connectivity
* informal labor
* fragmented payments
* poor project visibility
* material price volatility
* limited access to verified professionals
* weak documentation
* remote property owners
* disconnected financial and operational systems

MjengoOS aims to become the infrastructure connecting those pieces.

---

# 📜 Philosophy

> **Don't just record what people say happened — record the evidence around what happened.**

> **Reported is not verified.**

> **AI assists; humans remain accountable.**

> **The ledger never lies.**

> **Payments must be idempotent.**

> **Inventory must be derived.**

> **Offline is a normal state.**

> **Every important action should have provenance.**

> **Trust should be earned through evidence, not assumed.**

---

# 🛠️ Development Status

MjengoOS is under active development.

The repository is being built toward production readiness with a strong emphasis on:

* correctness
* security
* reliability
* offline-first operation
* financial integrity
* evidence-based workflows
* scalable architecture
* African market requirements
* AI-assisted construction intelligence

Features are implemented incrementally and validated across the full stack before being considered complete.

---

# 🤝 Contributing

Contributions are welcome.

Before implementing a feature:

1. Inspect the existing architecture.
2. Check whether the capability already exists.
3. Identify the appropriate domain.
4. Reuse existing abstractions where possible.
5. Avoid duplicating business logic.
6. Preserve data integrity.
7. Add tests.
8. Update documentation.
9. Ensure authorization is enforced.
10. Consider offline behavior where applicable.
11. Consider auditability.
12. Consider failure and retry behavior.

Pull requests should clearly explain:

* the problem
* the solution
* architectural impact
* database changes
* API changes
* security considerations
* testing
* migration requirements
* operational considerations

---

# 📄 License

License information will be added as the project reaches its community release stage.

---

## MjengoOS

**Construction sites are physical.**

**Their data should reflect reality.**

**Build with evidence.**
