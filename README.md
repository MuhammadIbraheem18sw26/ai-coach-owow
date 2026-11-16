# The Coach That Remembers

Working prototype, automated verification suite, and engineering decision document for **OWOW Trial Day AI Engineer — The Coach That Remembers**.

- **Decision Document:** See [`DECISION.md`](./DECISION.md)
- **Backend Application Layer (`apps/backend`, `:3000`):** **NestJS + TypeORM** managing PostgreSQL relational entities (`users`, `trusted_sessions`, `exercises`, `commitments`, `private_chats`, `scenarios`), automatic fixture seeding (`OnModuleInit`), server-side session resolution (`trustedSessionId -> memberId`), and API routing.
- **AI & Vector Layer (`apps/api`, `:8000`):** **Python 3.12 + LangGraph (`StateGraph`) + LangChain (`ChatOpenAI.with_structured_output` & `PGVector`)** enforcing deterministic pre-LLM privacy filtering (`context_selector.py`) and 1536-d vector similarity search.
- **Frontend UI (`apps/web`, `:5173`):** **React + TypeScript + Vite** proxying `/api` to the NestJS backend (`:3000`).

---

## Repository Structure

```text
.
├── apps/
│   ├── backend/                       # NestJS + TypeORM Backend (:3000)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── data/fixture.json
│   │   └── src/
│   │       ├── entities/              # TypeORM Entities (users, trusted_sessions, exercises, commitments, private_chats, scenarios)
│   │       ├── coach/                 # CoachController & CoachService (OnModuleInit seeding + AI service bridge)
│   │       ├── app.module.ts
│   │       └── main.ts
│   ├── api/                           # Python LangGraph + LangChain PGVector AI Layer (:8000, managed by uv)
│   │   ├── Dockerfile
│   │   ├── pyproject.toml
│   │   ├── db/init.sql                # Enables pgvector extension
│   │   ├── data/fixture.json
│   │   ├── src/coach/
│   │   │   ├── coach_graph.py         # LangGraph StateGraph + LangChain ChatOpenAI & PGVector
│   │   │   ├── context_selector.py    # Deterministic privacy & commitment lifecycle filter (no LLM)
│   │   │   ├── schemas.py             # Pydantic v2 models & strict contracts
│   │   │   └── main.py                # FastAPI AI service endpoints
│   │   ├── scripts/evaluate.py        # Offline + live evaluation scorecard
│   │   └── tests/test_coach.py        # Pytest suite (9 tests verifying model input, privacy, and vector search)
│   └── web/                           # React + TypeScript + Vite UI (:5173)
│       ├── Dockerfile
│       ├── nginx.conf
│       └── src/App.tsx
├── docker-compose.yml                 # 4-container stack: postgres (:5432), api (:8000), backend (:3000), web (:5173)
├── DECISION.md                        # Deliverable 1: Concise engineering decision document
└── README.md                          # Setup, run, and verification instructions
```

---

## Option A — Run Complete Application with Docker Compose (Recommended)

Start **PostgreSQL 16 + `pgvector`** (`:5432`), the **Python LangGraph AI Service** (`:8000`), the **NestJS + TypeORM Backend** (`:3000`), and the **React Frontend** (`:5173`) with a single command:

```powershell
docker compose up --build
```

- **Member UI, Private Coach Chat, Vector Search & Reviewer Trace:** [http://localhost:5173](http://localhost:5173)
- **NestJS + TypeORM Backend Healthcheck:** [http://localhost:3000/api/health](http://localhost:3000/api/health)
- **Python LangGraph AI Service Healthcheck:** [http://localhost:8000/api/health](http://localhost:8000/api/health)

Run the automated test suite and evaluation scorecard inside the running AI service container:

```powershell
docker compose exec api uv run pytest -v
docker compose exec api uv run python scripts/evaluate.py
```

---

## Option B — Run Locally (`uv` + `pnpm`)

### 1. Run Automated Privacy & Scenario Tests (`apps/api`)

```powershell
Push-Location apps/api
uv run pytest -v
uv run python scripts/evaluate.py
Pop-Location
```

### 2. Start Services Locally

```powershell
# 1. Start PostgreSQL + pgvector in Docker
docker compose up -d postgres

# 2. Start Python LangGraph AI Service (:8000)
Push-Location apps/api
uv run uvicorn coach.main:app --reload --port 8000
Pop-Location

# 3. Start NestJS + TypeORM Backend (:3000)
Push-Location apps/backend
pnpm install
pnpm run start:dev
Pop-Location

# 4. Start React Frontend (:5173)
Push-Location apps/web
pnpm install
pnpm dev
Pop-Location
```
