# Project Overview, Architecture & End-to-End Data Flow — *The Coach That Remembers*

> **Purpose:** Complete guide to what this project solves, what was built, how the 4 Dockerized services interact, and how data flows service-by-service across every feature.

---

## 1. What the Project Is About (The Problem We Solved)

The client runs a leadership programme where members:
1. Submit a **weekly exercise reflection** (e.g., *"Which conversation or decision did you postpone this week, and what happened?"*).
2. Commit to a **specific weekly action** (a `commitment`, which can be `active`, `completed`, or `superseded`).
3. Have a **confidential 1-on-1 Private Chat** with their coach (`visibility: "private_chat"`, e.g., *"I am thinking about leaving my job"* or *"I had an argument with my manager"*).

**The Problem:**
- Previously, the AI feedback felt **disconnected** from what the member committed to the week before.
- At the same time, the client needs a **hard guarantee** that sensitive `private_chat` disclosures and other members' records (`member-404`) **never** leak into the weekly exercise feedback prompt—because *"a prompt instruction alone is not an access control."*

---

## 2. Architecture Overview (4 Dockerized Services)

The application uses a **4-container microservices architecture** orchestrated in [`docker-compose.yml`](./docker-compose.yml):

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. React + TypeScript Frontend (coach-web, :5173) — apps/web               │
│    • Top-left Reset DB & Fixture Data button with Caution modal ('reset')  │
│    • Scenario switcher (continuity | revised-commitment | no-history)      │
│    • Weekly Exercise Form (locked trustedSessionId) + 503 Outage Toggle    │
│    • Reviewer Trace & Privacy Boundary Proof Drawer                        │
│    • Confidential 1-on-1 Private Chat + pgvector Semantic Search Panel     │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ HTTP REST (/api/*)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. NestJS + TypeORM Backend (coach-backend, :3000) — apps/backend          │
│    • Owns 6 Relational Tables via TypeORM Entities (synchronize: true):    │
│      users, trusted_sessions, exercises, commitments, private_chats,       │
│      scenarios                                                             │
│    • Hard Trust Boundary: resolves trustedSessionId -> resolvedMemberId    │
│      on the server (client never supplies memberId)                        │
└───────────────┬───────────────────────────────────────────┬────────────────┘
                │ TypeORM SQL (:5432)                       │ HTTP (:8000)
                ▼                                           ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────┐
│ 3. PostgreSQL 16 + pgvector (:5432)  │  │ 4. Python LangGraph + LangChain  │
│    (coach-postgres)                  │◄─┤    AI Service (coach-ai-service, │
│    • Relational tables (TypeORM)     │  │    :8000) — apps/api             │
│    • Vector tables (LangChain        │  │    • LangGraph StateGraph        │
│      PGVector 1536-d embeddings)     │  │    • Deterministic Context       │
│                                      │  │      Selector (context_selector) │
│                                      │  │    • ChatOpenAI Structured       │
│                                      │  │      Output + Tone Guardrails    │
│                                      │  │    • LangChain PGVector Search   │
└──────────────────────────────────────┘  └──────────────────────────────────┘
```

### Why This Split?
- **NestJS + TypeORM (`apps/backend`, `:3000`)** handles relational database entities (`apps/backend/src/entities/`), automatic seeding on startup (`OnModuleInit`), server-side session resolution, and API routing.
- **Python FastAPI + LangGraph + LangChain (`apps/api`, `:8000`)** handles **LangGraph `StateGraph` orchestration** (`coach_graph.py`), **deterministic pre-LLM privacy filtering** (`context_selector.py`), **Pydantic structured outputs** (`ChatOpenAI.with_structured_output(CoachingFeedback)`), and **LangChain `PGVector`** semantic search.

---

## 3. End-to-End Data Flows (Service-by-Service)

### Flow A: Submitting a Weekly Exercise (`POST /api/feedback`)
This is the core trial-day flow where **deterministic privacy & lifecycle filtering** happens *before* the LLM is called:

1. **React UI (`apps/web/src/App.tsx`):**
   - The member selects a scenario (e.g., `continuity` with locked `trustedSessionId: "session-101"`) and clicks **"Submit Exercise & Get Feedback"**.
   - Sends `POST /api/feedback` with `{ trustedSessionId: "session-101", newExercise: { week: 2, question, answer } }`. Notice **no `memberId` is ever sent by the client**.
2. **NestJS + TypeORM Backend (`apps/backend/src/coach/coach.service.ts`):**
   - **Step 2a (Session Trust Boundary):** Queries the `trusted_sessions` table in PostgreSQL via TypeORM (`session-101` $\rightarrow$ `member-101`). If the session ID is unknown, it immediately rejects with `403 Forbidden`.
   - **Step 2b (Load Records from TypeORM):** Queries `exercises`, `commitments`, and `private_chats` from PostgreSQL and forwards `{ trustedSessionId, resolvedMemberId, newExercise, records }` to the Python AI service (`POST http://api:8000/api/feedback`).
3. **Python LangGraph Service (`apps/api/src/coach/coach_graph.py`):**
   Executes the 3-node **LangGraph `StateGraph`**:
   - **Node 1 — `select_context` (`apps/api/src/coach/context_selector.py`):**
     Pure deterministic Python (NO LLM) inspects every record and applies 3 hard gates:
     - **Gate 1 (Cross-Member Isolation):** Drops any record where `rec.memberId != resolvedMemberId` (blocks `com-404-1`, which has the exact same text as `com-101-1`).
     - **Gate 2 (Privacy Visibility Gate):** Drops any record where `rec.visibility != "exercise"` (blocks `chat-101-1`: *"I am thinking about leaving my job"* and `chat-202-1`).
     - **Gate 3 (Commitment Lifecycle & Relevance Gate):**
       - Picks only the latest `status == "active"` commitment (`com-101-1` for `member-101`, `com-202-2` for `member-202`).
       - Excludes `status == "superseded"` commitments (`com-202-1`: *"decline every unplanned request"*) so the coach never treats outdated plans as active.
       - Excludes older `status == "completed"` commitments (`com-101-0`, `com-202-0`) so the coach stays focused on the current obstacle.
       - Picks the most recent prior `exercise` (`ex-101-1`, `ex-202-1`).
     - Emits a narrow **`SanitizedModelInput`** (containing *only* `newExercise`, `activeCommitment`, and `recentExercises`) plus the audit `decisions` list (which logs excluded record IDs + reasons **without** their secret text).
   - **Node 2 — `generate_feedback` (`coach_graph.py`):**
     - Passes **only** `SanitizedModelInput` into a **3-tier resilient LLM pipeline**:
       1. **Tier 1 (Primary — OpenAI ChatGPT with Retry):** `ChatOpenAI(model="gpt-4o-mini").with_structured_output(CoachingFeedback).with_retry(stop_after_attempt=3, wait_exponential_jitter=True)`
       2. **Tier 2 (Cross-Provider Fallback — Google Gemini with Retry):** Automatically invoked if ChatGPT fails all 3 retry attempts; calls `gemini-2.5-flash` (`GOOGLE_API_KEY` / `GEMINI_API_KEY`) with a strict JSON `responseSchema` wrapped in LangChain `.with_retry(stop_after_attempt=3, wait_exponential_jitter=True)`.
       3. **Tier 3 (Offline Fallback):** Deterministic scenario-grounded fallback if both cloud providers are unreachable.
     - Attaches the **Langfuse OpenTelemetry `CallbackHandler`** (`from langfuse.langchain import CallbackHandler`) *strictly at this node* (after `select_context` has already stripped `private_chat` and cross-member records), tagging the trace with `langfuse_user_id`, `langfuse_session_id`, `included_record_ids`, and `excluded_record_ids` (never raw excluded text) and returning `langfuseTraceId` in the Reviewer Trace.
     - Returns a typed `CoachingFeedback` object: `{ observation, reflectionQuestion, possibleNextCommitment }`.
   - **Node 3 — `validate_guardrails` (`coach_graph.py`):**
     - Verifies the response contains no clinical/therapy/diagnosis words (`trauma`, `therapy`, `diagnose`, `disorder`) or generic praise (`great job!`), and ensures `reflectionQuestion` ends with `?`.
4. **React UI Renders Both Views:**
   - **Left Card:** Displays the member-facing **Observation**, **Reflection Question**, and **Possible Next Commitment**.
   - **Right Card (Reviewer Trace):** Displays the included/excluded table (`INCLUDED` in green, `EXCLUDED` in red with reasons like `privacy_boundary` and `lifecycle`) and the exact `SanitizedModelInput` JSON that reached the LLM.

---

### Flow B: Adopting the Suggested Next Commitment (`POST /api/commitments`)
1. The member clicks **"Adopt as My Active Commitment"** under `possibleNextCommitment` in the UI.
2. **NestJS + TypeORM (`coach.service.ts`):**
   - Resolves `memberId` from `trustedSessionId`.
   - Updates any existing `status = 'active'` commitment for that member in the PostgreSQL `commitments` table to `status = 'superseded'` and sets `replaced_by = newId`.
   - Inserts the new commitment as `status = 'active'` in TypeORM and syncs its vector embedding (with the exact same `id`) into Python's **LangChain `PGVector`** store.
3. If the member submits a Week 3 exercise right after, `select_context` automatically picks the newly adopted commitment and marks the previous one as `excluded (lifecycle: superseded)`.

---

### Flow C: Confidential 1-on-1 Private Chat & `pgvector` Semantic Search (`POST /api/private-chat/*`)
1. **Why We Added This:** Members share private reflections with their AI Coach (`private_chats` table) and want to search/view their own past chats and exercises—while keeping `private_chats` 100% isolated from the Weekly Exercise Feedback flow.
2. **Vector Search (`POST /api/private-chat/search`):**
   - **React UI** sends `{ trustedSessionId, query, scope: "all" | "private_chat" }` to **NestJS (`:3000`)**.
   - **NestJS** verifies `trustedSessionId -> memberId` and calls the **Python AI Service (`:8000`)**.
   - **Python (`CoachGraphService.search_member_records`)** uses **LangChain `PGVector` + `OpenAIEmbeddings` (`text-embedding-3-small`, 1536 dimensions)** to run `similarity_search_with_relevance_scores(query, k=5, filter={"member_id": member_id})`.
   - Because of the strict `member_id` filter in `PGVector`, `member-101` can search their own private chat (`chat-101-1`: *"leaving my job"*) and exercises, but can **never** see `member-202`'s or `member-404`'s records.
3. **Sending a New Private Chat Message (`POST /api/private-chat/messages`):**
   - Retrieves the member's top-3 related records via `PGVector`, generates a confidential reply, persists both the member's message and the coach's reply in the PostgreSQL `private_chats` table (`visibility = 'private_chat'`) via TypeORM, and indexes their 1536-d embeddings in `PGVector`.
   - **The Proof:** If you then submit the Weekly Exercise in Section 1 again, your newly added `private_chat` rows immediately appear in the **Reviewer Trace** as **`EXCLUDED (privacy_boundary: visibility is 'private_chat')`**—proving they never leak into the exercise feedback flow!
