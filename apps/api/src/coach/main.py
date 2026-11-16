from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .context_selector import select_context_for_member
from .llm_adapter import CoachLlmAdapter, get_default_adapter
from .schemas import (
    ContextTrace,
    FeedbackRequest,
    FeedbackResponse,
    MemberRecord,
    SaveCommitmentRequest,
)
from .store import RecordStore


def create_app(
    store: RecordStore | None = None,
    adapter: CoachLlmAdapter | None = None,
) -> FastAPI:
    app = FastAPI(title="The Coach That Remembers API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    record_store = store or RecordStore()
    llm_adapter = adapter or get_default_adapter()

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "adapter": llm_adapter.name}

    @app.get("/api/scenarios")
    def get_scenarios() -> dict:
        return {
            "scenarios": [s.model_dump() for s in record_store.list_scenarios()],
            "trustedSessions": [s.model_dump() for s in record_store.list_sessions()],
            "adapter": llm_adapter.name,
        }

    @app.post("/api/feedback", response_model=FeedbackResponse)
    def generate_feedback(payload: FeedbackRequest) -> FeedbackResponse:
        if payload.simulateFailure:
            raise HTTPException(
                status_code=503,
                detail="Coaching model service is temporarily unavailable. Your exercise answer is safe—please retry.",
            )

        resolved_member_id = record_store.resolve_member_id(payload.trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")

        sanitized_input, decisions = select_context_for_member(
            resolved_member_id=resolved_member_id,
            new_exercise=payload.newExercise,
            all_records=record_store.list_all_records(),
        )

        try:
            feedback = llm_adapter.generate_feedback(sanitized_input)
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to generate coaching feedback: {exc}",
            ) from exc

        trace = ContextTrace(
            trustedSessionId=payload.trustedSessionId,
            resolvedMemberId=resolved_member_id,
            adapterUsed=llm_adapter.name,
            decisions=decisions,
            sanitizedModelInput=sanitized_input,
        )
        return FeedbackResponse(feedback=feedback, trace=trace)

    @app.post("/api/commitments", response_model=MemberRecord)
    def save_commitment(payload: SaveCommitmentRequest) -> MemberRecord:
        resolved_member_id = record_store.resolve_member_id(payload.trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")
        return record_store.save_new_commitment(
            member_id=resolved_member_id,
            week=payload.week,
            text=payload.text,
        )

    @app.post("/api/reset")
    def reset_store() -> dict[str, str]:
        record_store.reset()
        return {"status": "reset"}

    return app


app = create_app()
