import re
from .schemas import (
    MemberRecord,
    NewExercise,
    SanitizedHistoryRecord,
    SanitizedModelInput,
    TraceDecision,
)

_SENSITIVE_NUMBER_PATTERN = re.compile(r"\+?\d[\d\s\-\.\(\)]{6,}\d")


def redact_sensitive_pii(text: str) -> str:
    """
    Deterministic PII redaction guardrail:
    Masks credit/debit card numbers (13-19 digits) and private phone/ID numbers (8+ digits)
    with 'XXXXXXXXXXXXXXXX' before text enters storage, vector embeddings, or LLM prompts.
    """
    def _mask_match(match: re.Match[str]) -> str:
        raw = match.group(0)
        digit_count = sum(1 for ch in raw if ch.isdigit())
        if digit_count >= 8:
            return "X" * max(16, digit_count)
        return raw

    return _SENSITIVE_NUMBER_PATTERN.sub(_mask_match, text)


def select_context_for_member(
    *,
    resolved_member_id: str,
    new_exercise: NewExercise,
    all_records: list[MemberRecord],
) -> tuple[SanitizedModelInput, list[TraceDecision]]:
    """
    Deterministic policy & relevance filter executed BEFORE any LLM call.
    1. Rejects records belonging to other members.
    2. Rejects records where visibility != 'exercise' (e.g. 'private_chat').
    3. Rejects 'superseded' commitments from active coaching context.
    4. Selects the latest 'active' commitment (if any) and omits earlier unrelated 'completed' commitments
       when an active commitment exists, preventing false anchors.
    5. Selects the most relevant recent exercise record(s) to provide continuity.
    """
    decisions: list[TraceDecision] = []
    member_exercise_records: list[MemberRecord] = []

    for rec in all_records:
        # Gate 1: Strict tenant/member isolation
        if rec.memberId != resolved_member_id:
            decisions.append(
                TraceDecision(
                    recordId=rec.id,
                    recordType=rec.type,
                    week=rec.week,
                    decision="excluded",
                    reason="privacy_boundary: belongs to a different member",
                )
            )
            continue

        # Gate 2: Strict visibility boundary (blocks private_chat)
        if rec.visibility != "exercise" or rec.type == "private_chat":
            decisions.append(
                TraceDecision(
                    recordId=rec.id,
                    recordType=rec.type,
                    week=rec.week,
                    decision="excluded",
                    reason=f"privacy_boundary: visibility is '{rec.visibility}' (not 'exercise')",
                )
            )
            continue

        # Gate 3: Future week guard
        if rec.week > new_exercise.week:
            decisions.append(
                TraceDecision(
                    recordId=rec.id,
                    recordType=rec.type,
                    week=rec.week,
                    decision="excluded",
                    reason="temporal_filter: record week is after current submission week",
                )
            )
            continue

        member_exercise_records.append(rec)

    # Partition commitments and exercises
    commitments = [r for r in member_exercise_records if r.type == "commitment"]
    exercises = [r for r in member_exercise_records if r.type == "exercise"]

    # Find active commitment (latest week)
    active_commitments = sorted(
        [c for c in commitments if c.status == "active"],
        key=lambda r: r.week,
        reverse=True,
    )
    selected_commitment = active_commitments[0] if active_commitments else None

    for c in commitments:
        if selected_commitment and c.id == selected_commitment.id:
            decisions.append(
                TraceDecision(
                    recordId=c.id,
                    recordType=c.type,
                    week=c.week,
                    decision="included",
                    reason="relevance: current active commitment",
                )
            )
        elif c.status == "superseded":
            replacement = f" by {c.replacedBy}" if c.replacedBy else ""
            decisions.append(
                TraceDecision(
                    recordId=c.id,
                    recordType=c.type,
                    week=c.week,
                    decision="excluded",
                    reason=f"lifecycle: commitment status is 'superseded'{replacement}",
                )
            )
        elif c.status == "completed":
            decisions.append(
                TraceDecision(
                    recordId=c.id,
                    recordType=c.type,
                    week=c.week,
                    decision="excluded",
                    reason="relevance: already completed in an earlier week; omitted to keep focus on current challenge",
                )
            )
        else:
            decisions.append(
                TraceDecision(
                    recordId=c.id,
                    recordType=c.type,
                    week=c.week,
                    decision="excluded",
                    reason="relevance: older commitment superseded by newer active commitment",
                )
            )

    # Select relevant recent exercise(s):
    # Prioritize exercise from the same week as the active commitment (or latest prior week)
    sorted_exercises = sorted(exercises, key=lambda r: r.week, reverse=True)
    selected_exercises: list[MemberRecord] = []

    if sorted_exercises:
        latest_ex = sorted_exercises[0]
        selected_exercises.append(latest_ex)

    selected_ex_ids = {e.id for e in selected_exercises}
    for ex in exercises:
        if ex.id in selected_ex_ids:
            decisions.append(
                TraceDecision(
                    recordId=ex.id,
                    recordType=ex.type,
                    week=ex.week,
                    decision="included",
                    reason="relevance: most recent prior exercise reflection",
                )
            )
        else:
            decisions.append(
                TraceDecision(
                    recordId=ex.id,
                    recordType=ex.type,
                    week=ex.week,
                    decision="excluded",
                    reason="relevance: older resolved exercise; omitted to avoid distracting from current week",
                )
            )

    sanitized_commitment = (
        SanitizedHistoryRecord(
            id=selected_commitment.id,
            type="commitment",
            week=selected_commitment.week,
            status="active",
            text=selected_commitment.text,
        )
        if selected_commitment
        else None
    )

    sanitized_exercises = [
        SanitizedHistoryRecord(
            id=ex.id,
            type="exercise",
            week=ex.week,
            text=ex.text,
        )
        for ex in selected_exercises
    ]

    redacted_exercise = NewExercise(
        week=new_exercise.week,
        question=redact_sensitive_pii(new_exercise.question),
        answer=redact_sensitive_pii(new_exercise.answer),
    )

    model_input = SanitizedModelInput(
        newExercise=redacted_exercise,
        activeCommitment=sanitized_commitment,
        recentExercises=sanitized_exercises,
    )
    return model_input, decisions
