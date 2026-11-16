from typing import Literal, Optional
from pydantic import BaseModel, Field


class UserProfile(BaseModel):
    id: str
    name: str
    role: str


class TrustedSession(BaseModel):
    id: str
    memberId: str


class MemberRecord(BaseModel):
    id: str
    memberId: str
    type: Literal["exercise", "commitment", "private_chat"]
    visibility: Literal["exercise", "private_chat"]
    week: int
    status: Optional[Literal["completed", "active", "superseded"]] = None
    replacedBy: Optional[str] = None
    senderRole: Optional[Literal["member", "coach"]] = None
    question: Optional[str] = None
    text: str


class NewExercise(BaseModel):
    week: int = Field(..., ge=0)
    question: str = Field(..., min_length=3)
    answer: str = Field(..., min_length=3)


class Scenario(BaseModel):
    id: str
    trustedSessionId: str
    newExercise: NewExercise


class FixtureData(BaseModel):
    trustedSessions: list[TrustedSession]
    records: list[MemberRecord]
    scenarios: list[Scenario]


class SanitizedHistoryRecord(BaseModel):
    """Only exercise-visible records for the trusted member may be converted into this type."""

    id: str
    type: Literal["exercise", "commitment"]
    week: int
    status: Optional[Literal["completed", "active"]] = None
    text: str


class SanitizedModelInput(BaseModel):
    """The exact payload allowed to cross the boundary into the LLM adapter."""

    newExercise: NewExercise
    activeCommitment: Optional[SanitizedHistoryRecord] = None
    recentExercises: list[SanitizedHistoryRecord] = Field(default_factory=list)


class TraceDecision(BaseModel):
    """Audit metadata for reviewers. Intentionally omits raw text on excluded records to prevent leaks."""

    recordId: str
    recordType: str
    week: int
    decision: Literal["included", "excluded"]
    reason: str


class ContextTrace(BaseModel):
    trustedSessionId: str
    resolvedMemberId: str
    adapterUsed: str
    storageBackend: str = "in-memory"
    langfuseEnabled: bool = False
    langfuseTraceId: Optional[str] = None
    decisions: list[TraceDecision]
    sanitizedModelInput: SanitizedModelInput


class CoachingFeedback(BaseModel):
    observation: str = Field(
        ...,
        description="Concise 1-2 sentence observation grounded in the member's answer and active commitment (if any).",
    )
    reflectionQuestion: str = Field(
        ...,
        description="Exactly one direct, practical question that helps the member reflect.",
    )
    possibleNextCommitment: str = Field(
        ...,
        description="One concrete, small next commitment the member could take this week.",
    )


class FeedbackRequest(BaseModel):
    trustedSessionId: str
    newExercise: NewExercise
    simulateFailure: bool = False
    resolvedMemberId: Optional[str] = None
    records: Optional[list[MemberRecord]] = None


class FeedbackResponse(BaseModel):
    feedback: CoachingFeedback
    trace: ContextTrace


class SaveCommitmentRequest(BaseModel):
    id: Optional[str] = None
    trustedSessionId: str
    week: int
    text: str = Field(..., min_length=5)


class SemanticSearchResult(BaseModel):
    id: str
    recordType: Literal["private_chat", "exercise", "commitment"]
    visibility: Literal["private_chat", "exercise"]
    week: int
    status: Optional[str] = None
    senderRole: Optional[str] = None
    text: str
    similarity: float


class PrivateChatSearchRequest(BaseModel):
    trustedSessionId: str
    query: str = Field(..., min_length=2)
    scope: Literal["private_chat", "all"] = "all"
    topK: int = Field(default=5, ge=1, le=20)


class PrivateChatSearchResponse(BaseModel):
    resolvedMemberId: str
    query: str
    embeddingModel: str
    storageBackend: str
    results: list[SemanticSearchResult]


class SendPrivateChatRequest(BaseModel):
    trustedSessionId: str
    week: int = Field(default=2, ge=0)
    message: str = Field(..., min_length=2)


class SendPrivateChatResponse(BaseModel):
    memberMessage: MemberRecord
    coachMessage: MemberRecord
    retrievedPrivateContext: list[SemanticSearchResult]


class MemberWorkspaceResponse(BaseModel):
    trustedSessionId: str
    user: UserProfile
    storageBackend: str
    embeddingModel: str
    exercises: list[MemberRecord]
    commitments: list[MemberRecord]
    privateChats: list[MemberRecord]
