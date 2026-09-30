# Stage 5 — Node API Layer

**Status:** plan approved for revision, not yet implemented
**Date:** 2026-09-29
**Delivery:** one commit per phase, in phase order

---

## 1. Current state

| Fact | Value |
|---|---|
| n8n webhook | `POST /webhook/rag-query` → `{answer, confidence, sources, escalated, approved}` |
| Workflow size | 14 nodes (`n8n-files/rag-query.json`) |
| Blocking behaviour | Low-confidence path waits up to 45 min for a Slack click before responding |
| Failure behaviour | n8n returns **HTTP 200 with an empty body** on error (observed 5× in one session) |
| Upstream health | Gemini `503 high demand` is frequent; AI Agent now retries 4× |
| `app_db` tables | `conversations`, `escalation_tickets` — written by **n8n**, not by the API |
| Ports exposed | n8n `5678`, Qdrant `6333/6334`, Postgres `5433`, all bound to the host |
| Secrets in tree | `n8n-files/` holds a plaintext OpenAI key + Postgres password (gitignored) |

---

## 2. Design drivers

Three constraints dictated most of the design. Kept here because they explain decisions that otherwise look arbitrary.

### 2.1 The endpoint cannot be synchronous

The Slack "Send and Wait" approval can hold an execution for 45 minutes. A blocking Express handler pins a connection, blows every sane HTTP timeout, and makes retries meaningless. The API must acknowledge instantly and deliver the answer out-of-band.

→ `POST /api/v1/query` returns **`202 Accepted` + `requestId`**. Results arrive by websocket, with polling as a durable fallback.

### 2.2 Two writers for `conversations`

The workflow already INSERTs via **Log to Postgres** and *needs* the returned id to attach a ticket. A second writer produces duplicates. Ownership is therefore not a style choice but a data-integrity constraint.

→ **n8n stays the single writer.** The API generates a `requestId` UUID, passes it into the webhook body, and correlates everything on it. The API owns `api_requests` (its own record of what the workflow never logged) and reads `conversations` / `escalation_tickets` for the dashboard.

### 2.3 `init.sql` is a one-time bootstrap

Postgres only runs `/docker-entrypoint-initdb.d` on an empty data directory. This volume is already populated, so **edits to `init.sql` are inert**. A real migration runner is required before any schema change.

→ `api/db/migrations/*.sql` + a small runner that records applied versions in a `schema_migrations` table.

---

## 3. Confirmed decisions

| # | Question | Decision | Consequence |
|---|---|---|---|
| 1 | Who writes `conversations`? | n8n, confirmed | API never INSERTs answers; needs `request_id` correlation |
| 2 | Async `202` for `/query`? | Yes, non-negotiable | Contract is async; requires workflow change (§7) |
| 3 | Modify `rag-query.json` early? | Yes — before the API skeleton | Phase order reversed: workflow is Phase 1 |
| 4 | Public `/query` auth | Anonymous + rate limit (IP / `sessionId`) | No user accounts; multi-tenant API keys = README note only |
| 5 | TS or JS? | TypeScript | Pairs with zod, reads well on review |
| 6 | `ws` or `socket.io`? | `ws` | Polling fallback already planned; keep deps lean |
| 7 | `pg` raw or Drizzle? | Raw `pg` + repositories | Hand-written SQL, explicit over magic |

Decision 3 is the scheduling driver: Phases 1–3 of the original plan were being built against a contract that was about to change shape. The workflow is now locked and changed first.

---

## 4. Data model

Applied by `api/db/migrations/`, in this order. **Ordering is load-bearing** — `escalation_tickets.decided_by` becomes an FK to `admin_users`, so `admin_users` must exist first. Splitting the original single-table change into ordered migrations avoids a circular dependency.

| # | Migration | Contents |
|---|---|---|
| 001 | `admin_users` | `id SERIAL PK`, `email UNIQUE`, `password_hash`, `role`, `created_at`, `last_login_at` |
| 002 | `refresh_tokens` | `id`, `user_id FK`, **`family_id`**, `token_hash`, `expires_at`, `rotated_at`, `revoked_at` |
| 003 | `conversations` | `+ request_id UUID UNIQUE`, `+ session_id`, `+ sources JSONB`, `+ latency_ms`, `+ approved BOOL`, `+ decision_channel` |
| 004 | `escalation_tickets` | `+ request_id UUID`, `+ decided_by INTEGER FK → admin_users(id)`, `+ decided_at`, `+ decision_channel`, status CHECK widened |
| 005 | `api_requests` | `request_id UUID PK`, `question`, `received_at`, `state`, `upstream_http`, `error`, `latency_ms` |
| 006 | `audit_log` | `actor FK → admin_users(id)`, `action`, `entity`, `entity_id`, `before JSONB`, `after JSONB`, `at` |
| 007 | `ticket_timeout_sweeper` | index on `(status, created_at)` for the sweeper query (§9) |

### 4.1 `decided_by` is a real FK

Not a free-text string. A `VARCHAR` author column breaks the audit trail the moment an admin renames their account or is deactivated — you end up with orphan audit rows that can't be attributed to a person, and no way to answer "who approved this ticket six months ago". The FK makes the accountability durable.

### 4.2 Refresh token reuse detection

`family_id` is added **now**, not later, because retrofitting it means a migration that touches every active session.

Rules:
- Each login creates a **family**. Refresh issues a new token in the same family and marks the old one `rotated_at`.
- Presenting a token that is already `rotated_at` or `revoked_at` is **reuse** → revoke the entire family, force re-login, and log a security event.
- Only the token *hash* is stored; the raw token never touches the database.

Without this, a leaked refresh token is silent long-term access: the thief rotates it forever and the legitimate user never notices, because each rotation looks identical to a normal refresh.

### 4.3 Ticket status lifecycle

`escalation_tickets` moves from a passive log to a real state machine. `pending` becomes a first-class state the moment a low-confidence answer is escalated — before any human sees it.

```
                  ┌── approve ──→ approved ──→ in_progress ──→ resolved
escalated ──→ pending
                  ├── reject  ──→ rejected
                  └── timeout ──→ timed_out
```

| Status | Set by | Meaning |
|---|---|---|
| `pending` | workflow, on escalation | escalated to Slack, **nobody has looked yet** |
| `approved` | workflow, on human approval | a human accepted the answer |
| `rejected` | workflow, on human rejection | a human actively declined |
| `timed_out` | workflow sweeper / timeout branch | **nobody clicked** — distinct from `rejected` |
| `open` / `in_progress` / `resolved` | dashboard `PATCH` | normal agent triage after approval |

The CHECK constraint widens to
`('open','pending','approved','rejected','timed_out','in_progress','resolved')`.

`timed_out` is deliberately separate from `rejected`: *"someone declined this"* and *"nobody looked at it"* are different operational signals and the dashboard must be able to tell them apart. A spike in `timed_out` means the on-call rotation has a coverage problem, not that the bot is wrong.

---

## 5. Event state machine

```
accepted ──→ answered ──┬──→ completed          (confidence high/medium)
                        └──→ escalated ──┬──→ approved
                                          ├──→ rejected
                                          ├──→ timed_out
                                          └──→ failed          (upstream 503, n8n error)
```

| Event | Terminal | Emitted by |
|---|---|---|
| `accepted` | no | API, immediately on receipt |
| `answered` | no | workflow, on every non-low-confidence path |
| `escalated` | no | workflow, when confidence is low |
| `approved` | yes | workflow, human clicked Approve |
| `rejected` | yes | workflow, human clicked Reject |
| `timed_out` | yes | workflow, Slack wait expired |
| `failed` | yes | API (webhook 200-with-empty-body) **and** workflow (on-node-error path) |

---

## 6. API surface

**Public — anonymous, rate limited** (key: `sessionId` if present, else source IP)

```
POST   /api/v1/query                  {question, sessionId?} → 202 {requestId, state, pollUrl}
GET    /api/v1/requests/:id           current state + result
GET    /api/v1/requests/:id/result    answer, or 202 while pending
POST   /api/v1/requests/:id/feedback  {rating, comment}
```

**Admin — JWT required**

```
POST   /api/v1/auth/login | refresh | logout
GET    /api/v1/admin/conversations    filter: confidence, q, from, to, cursor pagination
GET    /api/v1/admin/conversations/:id
GET    /api/v1/admin/tickets          filter: status, assigned_to
GET    /api/v1/admin/tickets/:id
PATCH  /api/v1/admin/tickets/:id      status / assigned_to / notes → audit_log
GET    /api/v1/admin/stats            counts by confidence + status, p50/p95 latency, error rate
GET    /api/v1/admin/health           §9
```

**Server-to-server — shared secret, not JWT**

```
POST   /internal/notify               workflow callback (§7.2)
```

**Infra:** `GET /healthz`, `GET /readyz`, `GET /docs`, `WS /ws`

---

## 7. Required workflow change (Phase 1)

This is the contract the entire API is built against, so it is locked and implemented first.

### 7.1 Webhook contract change

Current: `responseMode: responseNode` — n8n answers at the end of the run, forcing the 45-minute block.

New: `responseMode: onReceived` — n8n acknowledges the request immediately and continues in the background.

```
POST /webhook/rag-query
{ "question": "...", "requestId": "<uuid>", "sessionId": "...", "receivedAt": "<iso>" }

→ 200 (empty, immediately)
```

The API records `receivedAt` and sends it along so the workflow can compute `latency_ms` — the API's clock, not the workflow's.

### 7.2 Notify callback

All three **Respond to Webhook** nodes are removed and replaced by a single **HTTP Request → `POST {API_URL}/internal/notify`** node on each terminal branch. Authenticated with a shared secret header, not a JWT — this is server-to-server, and minting a user token for it would be nonsense.

```json
{
  "requestId": "0f8c...",
  "event": "escalated",
  "conversationId": 12,
  "ticketId": 4,
  "answer": "...",
  "confidence": "low",
  "sources": [],
  "approved": true,
  "latencyMs": 4210,
  "error": null
}
```

A fourth branch is added for the Slack wait expiring, emitting `timed_out` and updating the ticket. Without it, timeouts are silently indistinguishable from pending forever.

An error trigger path is added so an upstream `503` also emits `failed` — otherwise a Gemini outage produces no events at all and the dashboard shows nothing wrong while every request is dead.

### 7.3 Propagating `requestId`

**Detail that will bite if missed:** the **Confidence Scorer** (a Code node) rebuilds the item as `{question, answer, confidence, sources}`, discarding everything upstream. It must be extended to carry `requestId` and `sessionId` through, or every downstream node sees `undefined`. This is the same class of bug as the Slack message rendering blank placeholders earlier — an item-replacing node silently dropping context.

Downstream nodes reference `$('Confidence Scorer').first().json.requestId`.

### 7.4 Node-level changes

| Node | Change |
|---|---|
| Webhook | `responseMode: onReceived`; pass through `requestId` |
| Confidence Scorer | emit `requestId`, `sessionId` |
| Log to Postgres | INSERT new `conversations` columns |
| Create Ticket | INSERT with `status='pending'`, `request_id` |
| Approve Ticket *(new)* | UPDATE → `approved` + `decided_at` + `decision_channel` |
| Reject Ticket *(new)* | UPDATE → `rejected` + `decided_at` + `decision_channel` |
| Timeout Ticket *(new)* | UPDATE → `timed_out` |
| Respond OK / Low / Rejected | **removed** → replaced by Notify nodes |
| Error path *(new)* | Notify `failed` |

### 7.5 Version control for the workflow

`n8n-files/` stays gitignored — it must, because it contains a live OpenAI key and the Postgres password in plaintext. But that means **the workflow definition cannot be committed**, which breaks phase-by-phase commits.

Fix: commit a **secret-free export** at `workflows/rag-query.json` — node graph and parameters only, with credentials referenced by `id`/`name` and no `data` blobs. Add a read-only `./workflows:/workflows` mount and import via:

```bash
docker exec support-copilot-n8n n8n import:workflow --input=/workflows/rag-query.json
```

Caveat to verify in Phase 1: if the export carries `"id": "2"` (the live workflow id), import should update in place. If it creates a duplicate, pin the id explicitly or deactivate the old copy.

---

## 8. Live escalation events (websockets)

Two sources, deliberately combined:

1. **Postgres `LISTEN/NOTIFY`** — triggers on the `conversations` / `escalation_tickets` writes fire a NOTIFY; a dedicated `pg` client on the API pushes to subscribed clients. Real-time, **no workflow dependency**. Payload capped at 8 KB, so notifications carry **ids only**; the API re-reads the row.
2. **Workflow callback** (§7.2) — covers `rejected`, `timed_out` and `failed`, which produce no DB write that alone would be sufficient.

`ws` handles transport. Heartbeat every 30 s, drop dead sockets, and let clients reconnect with `lastEventId` to replay missed events. WS auth goes in the query string or `Sec-WebSocket-Protocol` (browsers cannot set headers on upgrade) with a short-lived, single-use ticket minted by `GET /api/v1/requests/:id` — plus an origin allowlist.

---

## 9. Health & observability

The n8n REST endpoint `/executions?status=waiting` is **not** the source of truth for pending escalations. It needs a separate n8n API key (unrelated to webhook auth) and has a known reliability gap where `waiting` executions do not consistently appear in some n8n versions. A dashboard tile built on it would intermittently show zero during a real incident.

| Metric | Source | Notes |
|---|---|---|
| Escalations awaiting a human | `COUNT(*) FROM escalation_tickets WHERE status='pending'` | authoritative — data we own |
| Likely-stalled escalations | `... AND created_at < now() - interval '45 minutes'` | sweeper reaps these to `timed_out` |
| n8n execution counts | `SELECT status, count(*) FROM execution_entity GROUP BY status` | read **directly from the `n8n` DB** via a separate read-only pool — no API key, no reliability gap |
| Upstream failure rate | `COUNT(*) FROM api_requests WHERE state='failed'` | captures the 200-with-empty-body cases the workflow never records |
| p50/p95 latency | `latency_ms` in `conversations` / `api_requests` | |

The API's sweeper (Phase 7) marks `pending` tickets older than the Slack wait window as `timed_out` even if the n8n execution died — otherwise a crashed workflow leaves permanent phantom pendings.

Cross-database reads use a second `pg` Pool pointed at the `n8n` database, named `n8nPool` and kept strictly read-only, so the boundary is explicit in code review.

---

## 10. Stack

| Concern | Choice |
|---|---|
| Runtime | Node 20+ in Docker, new `api` service (not on the host) |
| Language | TypeScript, `tsx` for dev, `tsc` build |
| Framework | Express 5 |
| Validation | `zod@^3` — env, request, and OpenAPI in one source |
| DB | `pg` + hand-written repositories |
| Auth | `jsonwebtoken` + `bcrypt`; 15 min access, 7 day rotating refresh |
| WS | `ws` |
| Logging | `pino` + `pino-http`, structured JSON |
| Security | `helmet`, `cors` allowlist, `express-rate-limit` |
| Migrations | `db/migrations/*.sql` + custom runner |

**`zod@^3` is pinned deliberately.** `@asteasolutions/zod-to-openapi` generates the OpenAPI spec from the same schemas used for runtime validation, which is the entire point — a hand-maintained `openapi.yaml` drifts from the code within weeks and a stale `/docs` page is worse than no `/docs` page. Pinning v3 avoids the v4 generator incompatibility. A CI check regenerates the spec and fails on diff, so drift can't land silently.

---

## 11. Project layout

```
api/
  src/
    app.ts  index.ts
    config/env.ts
    db/ pool.ts  n8nPool.ts  migrations/  migrate.ts
    modules/
      auth/       routes service repo middleware tokens
      query/      routes service n8nClient repo
      conversations/ tickets/ admin/ auth-seed/
    events/ bus.ts  pgListener.ts  socketHub.ts  sweeper.ts
    middleware/ errorHandler validate rateLimit requestId requireAuth
    lib/ logger.ts errors.ts asyncHandler.ts
  db/migrations/
  tests/ unit/ integration/
  docs/ Dockerfile  package.json  tsconfig.json
```

Business logic lives in **pure functions with dependencies passed as arguments** — no module-level singletons for anything with a decision in it. This is what makes §12's unit layer possible without mocking frameworks.

---

## 12. Test strategy

Two layers, because "vitest + supertest against the running stack" alone means every test pays a real Postgres/n8n round trip and the suite gets slow and flaky as it grows.

### 12.1 Unit — no I/O, no Docker, no network

`npm test` runs this in seconds. Covers everything with a decision in it and no external call:

- confidence-threshold classification and state-machine transition guards
- zod schema accept/reject cases
- JWT claim shaping — sign, verify, expiry, wrong-audience rejection
- token-family revocation logic — given a set of token rows, decide rotate vs revoke-family
- n8n webhook response parsing — **empty body → failure**, malformed → failure, valid → typed result
- `requestId` propagation rules
- rate-limit key derivation (sessionId preferred, IP fallback)

### 12.2 Integration — real stack required

`npm run test:integration`, scoped to the handful of things that genuinely need it:

- auth round-trip: login → access call → refresh → reuse-detection kills the family
- query `202` → websocket event delivery end to end
- ticket `PATCH` writes an `audit_log` row
- migration runner applies cleanly to a scratch database

`npm test` alone must pass with Docker down, so the default script stays unit-only and CI stays fast.

---

## 13. Phased delivery

One commit per phase, in order. Phase 1 is the workflow because everything downstream is built against its contract.

| # | Phase | Commit message | Done when |
|---|---|---|---|
| 0 | Plan | `docs: add Stage 5 Node API layer plan` | this doc reviewed |
| 1 | **Workflow contract** | `feat(rag-workflow): emit ticket lifecycle and notify API callbacks` | `onReceived`; `pending`→`approved/rejected/timed_out`; notify on every terminal branch incl. error; secret-free export at `workflows/rag-query.json` |
| 2 | API skeleton | `feat(api): add Express skeleton with health checks and structured logging` | `/healthz` up in Docker |
| 3 | DB layer | `feat(api): add migration runner, schema changes, and repositories` | 007 applies cleanly to the live volume |
| 4 | Auth | `feat(api): add JWT auth with rotating refresh tokens and reuse detection` | JWT round-trips; reuse kills the family; no route leaks |
| 5 | Query endpoint | `feat(api): add async query endpoint with requestId correlation` | `/query` returns instantly; 200-empty and 503 both recorded in `api_requests` |
| 6 | Websockets | `feat(api): push escalation lifecycle events over websockets` | dashboard sees `accepted → escalated → approved` live |
| 7 | Admin endpoints | `feat(api): add admin read endpoints, ticket mutations, and audit log` | dashboard data complete; `pending` sweeper running |
| 8 | Hardening | `chore(api): add security middleware, test layers, and generated OpenAPI docs` | `npm test` green with Docker down; spec-drift check in CI |

Phases 2–4 are independent of the workflow's internals and unblock dashboard work early. Phases 5–6 are tightly coupled and ship together.

---

## 14. Risks and open items

| # | Item | Severity | Mitigation |
|---|---|---|---|
| 1 | Gemini 503s are frequent | high | `failed` state + `api_requests` make outages visible; consider a fallback model |
| 2 | Slack wait window (45 min) vs ticket sweeper | med | sweeper threshold must match the workflow's `limitWaitTime`; derive both from one env var |
| 3 | `onReceived` breaks direct n8n testing | med | `curl` against the webhook no longer returns an answer; document `GET /internal/notify` replay for debugging |
| 4 | Workflow export/import drift | med | keep `workflows/rag-query.json` as the source of truth; DB is a deploy target, not a source |
| 5 | Plaintext secrets in `n8n-files/` | med | stays gitignored; rotate the exposed OpenAI key (unused since the Gemini switch) |
| 6 | n8n port still public | med | bind `5678` to `127.0.0.1` or drop the mapping once the API is the only caller |
| 7 | No automated n8n credential setup | low | bootstrap is manual today; out of scope for this stage |

---

## 15. Out of scope (deliberate)

- Multi-tenant API keys — README note only (decision 4)
- React admin dashboard — next stage; this API is designed for it
- Reclaiming `conversations` ownership from n8n (decision 1)
- Automated n8n credential bootstrap
- n8n API key usage of any kind — we read the `n8n` DB directly instead (§9)
