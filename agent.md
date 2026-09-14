# AI Support Copilot — Stage 1: Environment Setup

RAG-based customer support system with confidence-based human escalation.
Stack: n8n (workflow engine) + Qdrant (vector DB) + Postgres, with a Node/React
layer added in later stages.

## Prerequisites
- Docker and Docker Compose installed
- An Anthropic or OpenAI API key (added inside n8n, not stored in this repo)

## 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
- Set real passwords for `POSTGRES_PASSWORD` and `N8N_BASIC_AUTH_PASSWORD`
- Generate an encryption key and set `N8N_ENCRYPTION_KEY`:
  ```bash
  openssl rand -hex 16
  ```

## 2. Start the stack

```bash
docker compose up -d
```

First boot pulls three images and initializes two Postgres databases
(`n8n` for the workflow engine, `app_db` reserved for later stages).

## 3. Verify everything is running

| Service | URL | Notes |
|---|---|---|
| n8n | http://localhost:5678 | Log in with `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` |
| Qdrant dashboard | http://localhost:6333/dashboard | Should load empty — no collections yet |
| Postgres | `localhost:5432` | `psql -h localhost -U $POSTGRES_USER -d app_db` |

## 4. Add your LLM credentials in n8n

In the n8n UI: **Credentials → New → Anthropic** (or OpenAI) → paste your API key.
Keeping it here instead of in `.env` means it's stored encrypted in n8n's database
and never risks being committed to the repo.

## What's running and why

- **n8n** — where all workflow logic lives (ingestion, RAG query, escalation)
- **Qdrant** — stores document embeddings for retrieval
- **Postgres** — one instance, two databases: `n8n` for the engine's internal
  state, `app_db` reserved for conversation logs and tickets once the Node API
  layer is built

## Stage 2: Ingestion Workflow

### 1. Create Qdrant collection

Run once to create the `support_docs` vector collection:

```bash
curl -X PUT http://localhost:6333/collections/support_docs \
  -H "Content-Type: application/json" \
  -d '{"vectors":{"size":1536,"distance":"Cosine"}}'
```

### 2. Import the n8n workflow

The workflow is pre-built at `n8n-files/ingest-support-docs.json`.
It was imported during setup via:

```bash
docker exec support-copilot-n8n n8n import:workflow \
  --input=/files/ingest-support-docs.json
```

**Workflow nodes (6):**

| # | Node | Purpose |
|---|------|---------|
| 1 | Manual Trigger | Click to run |
| 2 | Read Binary Files | Reads `/files/*.md` |
| 3 | Recursive Character Text Splitter | 1000 chars, 200 overlap |
| 4 | Default Data Loader | Converts binary → LangChain documents |
| 5 | Embeddings OpenAI | `text-embedding-3-small` (1536 dims) |
| 6 | Qdrant Vector Store | Upserts into `support_docs` collection |

### 3. Add OpenAI credential in n8n

In the n8n UI:
1. Open the **Ingest Support Docs to Qdrant** workflow
2. Click the **Embeddings OpenAI** node
3. Under **Credential**, click **Create New** → paste your OpenAI API key → save

### 4. Add documents and run

1. Drop `.md` files into `n8n-files/` (sample: `getting-started.md`)
2. In n8n, click **Execute Workflow**
3. Verify in Qdrant dashboard that points appear in `support_docs`

### What's running

- **n8n** — workflow engine (ingestion, RAG query, escalation)
- **Qdrant** — stores document embeddings for retrieval
- **Postgres** — `n8n` DB for engine state, `app_db` for future conversation logs

## Stage 3: RAG Query Workflow

### 1. Import the n8n workflow

The workflow is pre-built at `n8n-files/rag-query.json`.
It was imported during setup via:

```bash
docker exec support-copilot-n8n n8n import:workflow \
  --input=/files/rag-query.json
```

**Workflow nodes (6):**

| # | Node | Purpose |
|---|------|---------|
| 1 | Webhook | POST `/rag-query` — accepts `{"question":"..."}` |
| 2 | AI Agent | Orchestrates retrieval + generation with system prompt |
| 3 | Qdrant Vector Store | Retrieves top 5 similar chunks (retrieve mode) |
| 4 | Embeddings OpenAI | `text-embedding-3-small` (embeds the query) |
| 5 | OpenAI Chat Model | `gpt-4o-mini` (generates answer from context) |
| 6 | Confidence Scorer | Parses confidence marker from LLM output |

### 2. Add OpenAI credential in n8n

In the n8n UI:
1. Open the **RAG Query** workflow
2. Click the **Embeddings OpenAI** node → **Credential → Create New** → paste API key
3. Click the **OpenAI Chat Model** node → select the same credential

### 3. Activate and test

1. Toggle the workflow to **Active** (the webhook must be active to receive requests)
2. Test with curl:

```bash
curl -X POST http://localhost:5678/webhook/rag-query \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I create a project?"}'
```

**Response format:**
```json
{
  "answer": "To create a project, go to Dashboard → New Project...",
  "confidence": "high",
  "sources": []
}
```

### Confidence levels

| Level | Meaning |
|-------|---------|
| `high` | Context directly and clearly answers the question |
| `medium` | Context partially answers or requires inference |
| `low` | Context barely relates or agent couldn't find relevant info |

## Stage 4: Confidence-Based Escalation & Conversation Logging

### Database schema

The `app_db` database has two tables (created by `init-db/init.sql`):

```sql
conversations (id, question, answer, confidence, created_at)
escalation_tickets (id, conversation_id, status, assigned_to, notes, created_at, resolved_at)
```

### Updated RAG Query workflow

The workflow now has 7 nodes — after answering, it logs every conversation to
Postgres and creates an escalation ticket when confidence is low:

```
Webhook → AI Agent → Confidence Scorer → Log to Postgres → IF (confidence == low?)
  ├─ true  → Create Ticket → Respond Low
  └─ false → Respond OK
```

| # | Node | Purpose |
|---|------|---------|
| 1 | Webhook | POST `/rag-query` |
| 2 | AI Agent | RAG generation (retrieves + answers) |
| 3 | Confidence Scorer | Parses CONFIDENCE marker from output |
| 4 | Log to Postgres | INSERT INTO conversations |
| 5 | IF | Branch on confidence == "low" |
| 6 | Create Ticket | INSERT INTO escalation_tickets (low confidence only) |
| 7a | Respond OK | Returns `{ answer, confidence, escalated: false }` |
| 7b | Respond Low | Returns `{ answer, confidence, escalated: true }` |

### Add Postgres credential in n8n

In the n8n UI:
1. Go to **Credentials → New → Postgres**
2. Configure:
   - Host: `postgres`
   - Port: `5432`
   - Database: `app_db`
   - User: `postgres`
   - Password: (from `.env` `POSTGRES_PASSWORD`)
3. Name it **Postgres App DB**
4. Wire it to the **Log to Postgres** and **Create Ticket** nodes

### Test

```bash
# Normal query (high confidence — no ticket created)
curl -X POST http://localhost:5678/webhook/rag-query \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I create a project?"}'

# Off-topic query (low confidence — ticket created)
curl -X POST http://localhost:5678/webhook/rag-query \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the meaning of life?"}'
```

Check results:
```bash
docker exec support-copilot-postgres psql -U postgres -d app_db \
  -c "SELECT * FROM conversations ORDER BY id DESC LIMIT 5"

docker exec support-copilot-postgres psql -U postgres -d app_db \
  -c "SELECT * FROM escalation_tickets ORDER BY id DESC LIMIT 5"
```

### Next: Stage 5

Build a Node/React admin dashboard to view conversations, manage escalation
tickets, and monitor system health.