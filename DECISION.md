# Decision Document — The Coach That Remembers

## 1. Member Problem & Chosen Outcome
Members in the leadership programme complete a weekly exercise and commit to a specific action, but AI feedback currently feels disconnected from their prior commitments. At the same time, members share sensitive disclosures in `private_chat` (`chat-101-1`, `chat-202-1`) and expect strict privacy.

**Chosen Outcome:** Build a working end-to-end slice where submitting a weekly exercise produces concise, practical coaching feedback (`observation`, `reflectionQuestion`, `possibleNextCommitment`) grounded in the member's **current active commitment** and **most recent exercise**, while enforcing a **hard deterministic privacy boundary** prior to any model call, providing a confidential **Private AI Coach Chat & `pgvector` Semantic Search** space, and exposing an auditable **Reviewer Trace**.

## 2. Questions Asked, Answers Received, & Remaining Assumptions

| Clarifying Question Asked | Answer / Guidance from Brief & Product | Remaining Working Assumption |
|---|---|---|
| **1. Is `visibility === "exercise"` a strict, non-overridable access boundary, or can `private_chat` ever be referenced softly?** | Only `exercise`-visible records belonging to the trusted member may enter the exercise-feedback flow; `private_chat` and other members' records must be filtered before any model call. | We enforce a hard deny in deterministic code (`context_selector.py`) before prompt construction. Meanwhile, `private_chats` are isolated in their own table/vector scope so the member can search and chat privately without cross-contaminating exercise feedback. |
| **2. How should `superseded` (`com-202-1`) and earlier `completed` (`com-101-0`, `com-202-0`) commitments be handled?** | A `superseded` commitment must not be presented as the current commitment, and earlier records should be used only when they help with the current situation. | We completely omit `superseded` commitments from `SanitizedModelInput` so the LLM cannot anchor on outdated wording, and we omit older unrelated `completed` commitments whenever a newer `active` commitment exists. |
| **3. What should the Reviewer Trace expose for excluded records?** | Show which records informed the response and why in a development trace or explanation visible to the reviewer. | The trace logs `recordId`, `recordType`, `week`, `decision` (`included` / `excluded`), and policy `reason`—intentionally omitting the raw `text` of excluded records so `private_chat` content never leaks into UI traces or telemetry logs. |
| **4. Does submitting a new exercise automatically mark the previous active commitment as completed or superseded?** | The brief does not mandate automatic status mutation on exercise submission (and explicitly warns: *"Do not claim that a member completed an action unless the data says so"*). | Submitting an exercise is side-effect free; adopting the suggested `possibleNextCommitment` is an explicit member action (`POST /api/commitments`) that marks the previous `active` commitment as `superseded`. |

## 3. Architecture & Data Flow

```text
React + TypeScript UI (:5173, apps/web)
  │  REST (/api/scenarios, /api/member-workspace, /api/feedback, /api/commitments, /api/private-chat/*)
  ▼
NestJS + TypeORM Backend (:3000, apps/backend)
  ├─ 1. Session Trust Boundary (CoachService.resolveMemberId)
  │       Maps server-side trustedSessionId -> resolvedMemberId via TypeORM TrustedSessionEntity
  ├─ 2. Relational Persistence (TypeORM Entities -> PostgreSQL :5432)
  │       Tables: users, trusted_sessions, exercises, commitments, private_chats, scenarios
  │
  ▼  HTTP -> Python AI & Vector Microservice (:8000, apps/api)
CoachGraphService (LangGraph StateGraph — apps/api/src/coach/coach_graph.py)
  ├─ Node 1: select_context (Hard Privacy & Lifecycle Boundary — Pure Deterministic Python, No LLM)
  │       ├─ Gate 1 (Tenant Isolation): keeps only record.memberId == resolvedMemberId (blocks com-404-1)
  │       ├─ Gate 2 (Visibility Gate): keeps only record.visibility == "exercise" (blocks chat-101-1, chat-202-1)
  │       └─ Gate 3 (Lifecycle/Relevance): selects latest active commitment & recent exercise; omits superseded (com-202-1) & old completed (com-101-0, com-202-0)
  ├─ Node 2: generate_feedback (3-Tier Resilient LLM Pipeline with Retry & Cross-Provider Fallback)
  │       ├─ Tier 1 (Primary): LangChain ChatOpenAI .with_structured_output(CoachingFeedback).with_retry(stop_after_attempt=3)
  │       ├─ Tier 2 (Fallback): Google Gemini (gemini-2.5-flash) structured JSON runnable .with_retry(stop_after_attempt=3)
  │       └─ Tier 3 (Offline): Deterministic scenario-grounded fallback
  │       Receives ONLY narrow SanitizedModelInput { newExercise, activeCommitment, recentExercises }
  └─ Node 3: validate_guardrails (Deterministic Tone & Question Guardrail Gate)
          │
          └─ Vector Store: LangChain PGVector + OpenAIEmbeddings (text-embedding-3-small)
               Indexes & searches member records in PostgreSQL pgvector (filtered by member_id)
```

## 4. Consequential Technical Decisions

| Decision | Alternative considered | Why this choice fits now | Trade-off or risk | When I would revisit it |
|---|---|---|---|---|
| **1. Split NestJS + TypeORM Backend (`:3000`) and Python LangGraph AI Layer (`:8000`)** | Putting both application CRUD and AI orchestration in a single runtime or writing raw SQL in Python. | Aligns with OWOW's core TypeScript/NestJS + TypeORM stack (`UserEntity`, `TrustedSessionEntity`, `ExerciseEntity`, `CommitmentEntity`, `PrivateChatEntity`, `ScenarioEntity`) while using Python for LangGraph + LangChain `PGVector`. | Adds one internal HTTP hop between `backend` (`:3000`) and `api` (`:8000`) on the Docker network. | If ultra-low latency (<5ms internal overhead) is required at high scale, consolidate into a single NestJS + LangGraph.js service or gRPC transport. |
| **2. Deterministic policy & status filter (`context_selector.py`) for Exercise Feedback instead of RAG** | Using vector similarity search to pick context for the weekly exercise feedback prompt. | Weekly exercises and commitments have explicit lifecycle state (`status: active | completed | superseded`, `replacedBy`, `visibility`). Deterministic filtering is 100% auditable, zero-latency, and immune to cross-member semantic collisions (`com-404-1` has identical text to `com-101-1`). | Does not perform semantic topic matching across 50+ weeks of exercises in the exercise-feedback flow. | When a member accumulates >20 weeks of exercises and wants thematic recall across months (even then, run semantic search *only after* deterministic `member_id` and `visibility = 'exercise'` filtering). |
| **3. Enforce privacy via a narrower `SanitizedModelInput` schema before the LangGraph `generate_feedback` node** | Passing all member records into the prompt with instructions like *"Ignore private_chat records."* | A prompt instruction is not an access control. By stripping `private_chat` and `superseded` records into `SanitizedModelInput` inside `select_context_node`, the LLM node cannot see or leak restricted data. | Requires explicit schema updates when new exercise fields are added. | Never relax the pre-LLM filter; in multi-tenant production, also enforce PostgreSQL Row-Level Security (RLS). |
| **4. LangGraph `StateGraph` + LangChain `ChatOpenAI.with_structured_output(CoachingFeedback)` & `PGVector`** | Custom raw OpenAI SDK wrapper and manual SQL vector queries. | Eliminates custom adapter/vector boilerplate (`llm_adapter.py` and `store.py` removed). LangChain handles Pydantic structured output parsing and `PGVector` similarity search (`similarity_search_with_relevance_scores` with `member_id` metadata filters), with deterministic offline fallback when no API key is set. | Pulls in `langgraph`, `langchain-openai`, and `langchain-postgres` dependencies. | Keep LangGraph as the orchestration layer; add Langfuse OpenTelemetry tracing callbacks for production observability. |

## 5. First-Release Scope (Implemented, Mocked, Unfinished)
- **Implemented:**
  - **NestJS + TypeORM Backend (`apps/backend`):** 6 TypeORM entities (`users`, `trusted_sessions`, `exercises`, `commitments`, `private_chats`, `scenarios`), automatic database seeding (`OnModuleInit`), server-side session resolution (`trustedSessionId -> memberId`), and REST controllers.
  - **Python LangGraph + LangChain `PGVector` + Langfuse AI Service (`apps/api`):** 3-node `StateGraph` (`select_context` $\rightarrow$ `generate_feedback` $\rightarrow$ `validate_guardrails`), `ChatOpenAI.with_structured_output(CoachingFeedback)`, `OpenAIEmbeddings` + `PGVector` similarity search, Langfuse OpenTelemetry `CallbackHandler` tracing (attached strictly after `select_context` so excluded `private_chat` text never enters telemetry), and tone guardrails.
  - **React + TypeScript UI (`apps/web`):** Scenario dropdown switcher (`continuity`, `revised-commitment`, `no-history`), locked `trustedSessionId` field, exercise submission form, 503 failure simulation toggle, **"Adopt as My Active Commitment"** lifecycle action, **Reviewer Trace & Privacy Boundary Proof** drawer, **Confidential 1-on-1 AI Coach Chat (`private_chats`)** with PII masking (`XXXXXXXXXXXXXXXX`), **`pgvector` Semantic Search**, and a **Caution Reset DB** confirmation modal (`reset`).
  - **Verification Suite:** 11/11 `pytest` tests (`InputSpy` verifying exact `SanitizedModelInput`, ChatGPT retry + Google Gemini fallback, and PII redaction) and 5/5 scenarios in `scripts/evaluate.py`.
- **Mocked:**
  - Authentication is represented by `trustedSessions` in `fixture.json` as instructed.
  - When `OPENAI_API_KEY` and `GOOGLE_API_KEY` are not configured, the service falls back to deterministic coaching feedback and 1536-d local token-hash embeddings so all tests and demos work offline.
- **Intentionally Unfinished (Next Steps):**
  - PostgreSQL Row-Level Security (RLS) policies, real OAuth/JWT session middleware, and multi-week longitudinal cohort analytics.

## 6. Privacy Boundary & Failure Handling
- **Hard Privacy Boundary:** Access control is enforced in two places before any LLM call: NestJS resolves `trustedSessionId -> resolvedMemberId` via TypeORM, and `select_context_for_member()` (`context_selector.py`) strips all `private_chat` and cross-member records prior to `generate_feedback_node`. Excluded records are logged by ID and reason only—their `text` is omitted from both `SanitizedModelInput` and `ContextTrace`.
- **Failure Handling:** If the model service times out, errors, or is simulated as down (via the UI **"Simulate model service outage"** toggle), the backend returns a clean `502`/`503` notice while preserving the member's draft answer in the form for safe retry.

## 7. Evaluation & Post-Launch Quality Plan
- **Pre-merge Automated Checks (`uv run pytest` & `evaluate.py`):**
  - **InputSpy Verification:** Asserts `chat-101-1`, `chat-202-1`, `com-404-1`, `com-202-1` (superseded), and newly sent private chat messages never appear in `SanitizedModelInput`.
  - **Scenario Grounding:** Verifies `continuity` selects `com-101-1`, `revised-commitment` selects `com-202-2`, and `no-history` passes empty history without inventing past interactions.
  - **Tone Guardrails:** Rejects therapy/diagnosis language and enforces a direct reflection question.
- **Post-Launch Evaluation:**
  - Track **Commitment Adoption Rate** (how often members adopt or edit `possibleNextCommitment`) and **Week-over-Week Follow-Through Rate**.
  - Run an offline **LLM-as-a-Judge + Human Coach Rubric** on a sampled, anonymized golden dataset scoring *Grounding*, *Non-Hallucination*, *Directness*, and *Actionability*.
