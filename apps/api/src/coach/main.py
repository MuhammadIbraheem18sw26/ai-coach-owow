from typing import Callable, Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from .coach_graph import CoachGraphService
from .schemas import (
    FeedbackRequest,
    FeedbackResponse,
    MemberRecord,
    MemberWorkspaceResponse,
    PrivateChatSearchRequest,
    PrivateChatSearchResponse,
    SanitizedModelInput,
    SaveCommitmentRequest,
    SendPrivateChatRequest,
    SendPrivateChatResponse,
    UserProfile,
)


def create_app(
    graph: CoachGraphService | None = None,
    on_model_input: Optional[Callable[[SanitizedModelInput], None]] = None,
    force_deterministic: bool = False,
) -> FastAPI:
    app = FastAPI(title="The Coach That Remembers — Python AI & LangGraph Service", version="0.5.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    coach_graph = graph or CoachGraphService(
        on_model_input=on_model_input,
        force_deterministic=force_deterministic,
    )

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "adapter": coach_graph.model_label,
            "storageBackend": coach_graph.storage_backend,
            "embeddingModel": coach_graph.embedding_model,
            "langfuseEnabled": coach_graph.langfuse_enabled,
        }

    @app.get("/api/scenarios")
    def get_scenarios() -> dict:
        return {
            "scenarios": [s.model_dump() for s in coach_graph._fixture.scenarios],
            "trustedSessions": [s.model_dump() for s in coach_graph._fixture.trustedSessions],
            "adapter": coach_graph.model_label,
            "storageBackend": coach_graph.storage_backend,
            "embeddingModel": coach_graph.embedding_model,
        }

    @app.get("/api/member-workspace", response_model=MemberWorkspaceResponse)
    def get_member_workspace(trustedSessionId: str = Query(...)) -> MemberWorkspaceResponse:
        resolved_member_id = coach_graph.resolve_member_id(trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")

        recs = [r for r in coach_graph._fixture.records if r.memberId == resolved_member_id]
        return MemberWorkspaceResponse(
            trustedSessionId=trustedSessionId,
            user=UserProfile(id=resolved_member_id, name=f"Member {resolved_member_id}", role="Participant"),
            storageBackend=coach_graph.storage_backend,
            embeddingModel=coach_graph.embedding_model,
            exercises=[r for r in recs if r.type == "exercise"],
            commitments=[r for r in recs if r.type == "commitment"],
            privateChats=[r for r in recs if r.type == "private_chat"],
        )

    @app.post("/api/private-chat/search", response_model=PrivateChatSearchResponse)
    def search_private_chat_and_history(
        payload: PrivateChatSearchRequest,
    ) -> PrivateChatSearchResponse:
        resolved_member_id = coach_graph.resolve_member_id(payload.trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")

        results = coach_graph.search_member_records(
            member_id=resolved_member_id,
            query=payload.query,
            scope=payload.scope,
            top_k=payload.topK,
        )
        return PrivateChatSearchResponse(
            resolvedMemberId=resolved_member_id,
            query=payload.query,
            embeddingModel=coach_graph.embedding_model,
            storageBackend=coach_graph.storage_backend,
            results=results,
        )

    @app.post("/api/private-chat/messages", response_model=SendPrivateChatResponse)
    def send_private_chat_message(
        payload: SendPrivateChatRequest,
    ) -> SendPrivateChatResponse:
        resolved_member_id = coach_graph.resolve_member_id(payload.trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")

        retrieved_context = coach_graph.search_member_records(
            member_id=resolved_member_id,
            query=payload.message,
            scope="all",
            top_k=3,
        )

        member_msg = coach_graph.add_private_chat_message(
            member_id=resolved_member_id,
            week=payload.week,
            sender_role="member",
            text=payload.message,
        )

        reply_text = coach_graph.invoke_private_chat_reply(
            message=payload.message,
            private_context=retrieved_context,
            member_id=resolved_member_id,
            session_id=payload.trustedSessionId,
        )
        coach_msg = coach_graph.add_private_chat_message(
            member_id=resolved_member_id,
            week=payload.week,
            sender_role="coach",
            text=reply_text,
        )

        return SendPrivateChatResponse(
            memberMessage=member_msg,
            coachMessage=coach_msg,
            retrievedPrivateContext=retrieved_context,
        )

    @app.post("/api/feedback", response_model=FeedbackResponse)
    def generate_feedback(payload: FeedbackRequest) -> FeedbackResponse:
        if payload.simulateFailure:
            raise HTTPException(
                status_code=503,
                detail="Coaching model service is temporarily unavailable. Your exercise answer is safe—please retry.",
            )

        try:
            return coach_graph.invoke_feedback(
                trusted_session_id=payload.trustedSessionId,
                new_exercise=payload.newExercise,
                resolved_member_id=payload.resolvedMemberId,
                records=payload.records,
            )
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to generate coaching feedback: {exc}",
            ) from exc

    @app.post("/api/commitments", response_model=MemberRecord)
    def save_commitment(payload: SaveCommitmentRequest) -> MemberRecord:
        resolved_member_id = coach_graph.resolve_member_id(payload.trustedSessionId)
        if not resolved_member_id:
            raise HTTPException(status_code=403, detail="Invalid or untrusted session ID.")
        return coach_graph.save_new_commitment(
            member_id=resolved_member_id,
            week=payload.week,
            text=payload.text,
            record_id=payload.id,
        )

    @app.post("/api/reset")
    def reset_ai_store() -> dict[str, str]:
        coach_graph.reset()
        return {"status": "reset", "storageBackend": coach_graph.storage_backend}

    return app


app = create_app()
