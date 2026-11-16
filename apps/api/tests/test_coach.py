import pytest
from fastapi.testclient import TestClient
from coach.coach_graph import CoachGraphService, normalize_openai_model, validate_coaching_output
from coach.main import create_app
from coach.schemas import CoachingFeedback, SanitizedModelInput


class InputSpy:
    """Captures every exact SanitizedModelInput that reaches the LangGraph generate_feedback node."""

    def __init__(self) -> None:
        self.captured_inputs: list[SanitizedModelInput] = []

    def __call__(self, model_input: SanitizedModelInput) -> None:
        self.captured_inputs.append(model_input)


class _ScenarioProxy:
    def __init__(self, graph: CoachGraphService) -> None:
        self._graph = graph

    def list_scenarios(self):
        return list(self._graph._fixture.scenarios)


def make_test_setup() -> tuple[TestClient, _ScenarioProxy, InputSpy]:
    spy = InputSpy()
    graph = CoachGraphService(database_url="", on_model_input=spy, force_deterministic=True)
    app = create_app(graph=graph)
    return TestClient(app), _ScenarioProxy(graph), spy


def test_privacy_boundary_across_all_scenarios() -> None:
    """
    Verifies what reaches the model:
    - private_chat records (chat-101-1, chat-202-1) NEVER reach the model.
    - other member records (com-404-1, etc.) NEVER reach the model.
    - excluded record text NEVER appears in the trace response.
    """
    client, store, spy = make_test_setup()
    forbidden_strings = [
        "I am thinking about leaving my job.",
        "I had an argument with my manager about my future on the team.",
        "chat-101-1",
        "chat-202-1",
        "com-404-1",
        "member-404",
    ]

    for scenario in store.list_scenarios():
        res = client.post(
            "/api/feedback",
            json={
                "trustedSessionId": scenario.trustedSessionId,
                "newExercise": scenario.newExercise.model_dump(),
            },
        )
        assert res.status_code == 200
        model_input_json = spy.captured_inputs[-1].model_dump_json()

        for secret in forbidden_strings:
            assert secret not in model_input_json, (
                f"Privacy leak in scenario '{scenario.id}': '{secret}' reached the model!"
            )

        # Also verify private chat text never leaks in the API response or trace
        response_text = res.text
        assert "leaving my job" not in response_text
        assert "argument with my manager" not in response_text


def test_continuity_scenario_context_and_grounding() -> None:
    """
    Scenario 1 (continuity / session-101):
    - Must include active commitment com-101-1 and recent exercise ex-101-1.
    - Must NOT include completed week-0 commitment com-101-0 as the active commitment.
    - Must NOT claim the member completed the conversation.
    """
    client, store, spy = make_test_setup()
    scenario = next(s for s in store.list_scenarios() if s.id == "continuity")

    res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": scenario.trustedSessionId,
            "newExercise": scenario.newExercise.model_dump(),
        },
    )
    assert res.status_code == 200
    data = res.json()

    captured = spy.captured_inputs[-1]
    assert captured.activeCommitment is not None
    assert captured.activeCommitment.id == "com-101-1"
    assert [e.id for e in captured.recentExercises] == ["ex-101-1"]

    # Ensure completed com-101-0 did not enter model input
    assert "com-101-0" not in captured.model_dump_json()
    assert "status roundup" not in captured.model_dump_json()

    # Grounding check: observation acknowledges postponement rather than claiming completion
    obs_lower = data["feedback"]["observation"].lower()
    assert "postponed" in obs_lower or "stopped you" in obs_lower


def test_revised_commitment_excludes_superseded_record() -> None:
    """
    Scenario 2 (revised-commitment / session-202):
    - Must select com-202-2 (active) and NEVER pass com-202-1 (superseded) to the model.
    """
    client, store, spy = make_test_setup()
    scenario = next(s for s in store.list_scenarios() if s.id == "revised-commitment")

    res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": scenario.trustedSessionId,
            "newExercise": scenario.newExercise.model_dump(),
        },
    )
    assert res.status_code == 200

    captured = spy.captured_inputs[-1]
    assert captured.activeCommitment is not None
    assert captured.activeCommitment.id == "com-202-2"
    assert "rank new requests" in captured.activeCommitment.text

    # Superseded wording must NOT reach the model
    assert "com-202-1" not in captured.model_dump_json()
    assert "decline every unplanned request" not in captured.model_dump_json()


def test_no_history_scenario_is_useful_without_inventing_past() -> None:
    """
    Scenario 3 (no-history / session-303):
    - Model receives activeCommitment=None and recentExercises=[].
    - Response still contains observation, reflectionQuestion, and possibleNextCommitment.
    """
    client, store, spy = make_test_setup()
    scenario = next(s for s in store.list_scenarios() if s.id == "no-history")

    res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": scenario.trustedSessionId,
            "newExercise": scenario.newExercise.model_dump(),
        },
    )
    assert res.status_code == 200
    data = res.json()

    captured = spy.captured_inputs[-1]
    assert captured.activeCommitment is None
    assert captured.recentExercises == []

    feedback = data["feedback"]
    assert len(feedback["observation"]) > 15
    assert feedback["reflectionQuestion"].endswith("?")
    assert len(feedback["possibleNextCommitment"]) > 15
    assert "last week" not in feedback["observation"].lower()


def test_untrusted_session_rejected_and_failure_mode_handled() -> None:
    client, _, _ = make_test_setup()

    # Unknown session
    bad_res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": "session-999-Attacker",
            "newExercise": {
                "week": 2,
                "question": "Which conversation did you postpone?",
                "answer": "I postponed the conversation.",
            },
        },
    )
    assert bad_res.status_code == 403

    # Simulated failure
    fail_res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": "session-101",
            "newExercise": {
                "week": 2,
                "question": "Which conversation did you postpone?",
                "answer": "I postponed the conversation.",
            },
            "simulateFailure": True,
        },
    )
    assert fail_res.status_code == 503


def test_save_commitment_supersedes_previous_active_commitment() -> None:
    """
    Verifies the commitment lifecycle extension:
    - Saving a new commitment marks the previous active commitment as superseded.
    - Subsequent feedback requests select the newly saved commitment and exclude the superseded one.
    """
    client, _, spy = make_test_setup()

    save_res = client.post(
        "/api/commitments",
        json={
            "trustedSessionId": "session-101",
            "week": 2,
            "text": "Send a two-sentence message to my colleague before Wednesday noon asking what delivery risk they see.",
        },
    )
    assert save_res.status_code == 200
    saved_record = save_res.json()
    assert saved_record["status"] == "active"

    # Subsequent week 3 submission must use the newly saved commitment and exclude com-101-1
    fb_res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": "session-101",
            "newExercise": {
                "week": 3,
                "question": "Which conversation or decision did you postpone this week, and what happened?",
                "answer": "I still hesitated to send the two-sentence message because I wanted to review the project plan.",
            },
        },
    )
    assert fb_res.status_code == 200
    captured = spy.captured_inputs[-1]
    assert captured.activeCommitment is not None
    assert captured.activeCommitment.id == saved_record["id"]
    assert "com-101-1" not in captured.model_dump_json()


def test_guardrail_rejects_banned_therapy_and_praise_terms() -> None:
    with pytest.raises(ValueError, match="failed coaching tone guardrail"):
        validate_coaching_output(
            CoachingFeedback(
                observation="Great job! This looks like an attachment trauma response.",
                reflectionQuestion="Why did you postpone it?",
                possibleNextCommitment="Talk to your colleague tomorrow.",
            )
        )


def test_openai_model_id_normalization() -> None:
    assert normalize_openai_model("openai/gpt-4o-mini") == "gpt-4o-mini"
    assert normalize_openai_model("gpt-4o-mini") == "gpt-4o-mini"
    assert normalize_openai_model("", None) == "gpt-4o-mini"
    assert (
        normalize_openai_model("openai/gpt-4o-mini", "https://openrouter.ai/api/v1")
        == "openai/gpt-4o-mini"
    )


def test_private_chat_vector_search_and_exercise_isolation() -> None:
    """
    Verifies:
    1. Member workspace returns only that member's exercises, commitments, and private_chats.
    2. Vector search finds the member's own private_chat ('leaving my job') and never returns
       another member's private chat ('argument with my manager') or commitment ('com-404-1').
    3. Sending a new confidential private chat message persists it for private search, but
       it STILL never leaks into the exercise-feedback model input.
    """
    client, _, spy = make_test_setup()

    # 1. Check member workspace for session-101
    ws_res = client.get("/api/member-workspace", params={"trustedSessionId": "session-101"})
    assert ws_res.status_code == 200
    ws = ws_res.json()
    assert ws["user"]["id"] == "member-101"
    assert [c["id"] for c in ws["privateChats"]] == ["chat-101-1"]

    # 2. Vector search for 'leaving my job' within session-101
    search_res = client.post(
        "/api/private-chat/search",
        json={
            "trustedSessionId": "session-101",
            "query": "thinking about leaving my job",
            "scope": "all",
            "topK": 5,
        },
    )
    assert search_res.status_code == 200
    results = search_res.json()["results"]
    assert results[0]["id"] == "chat-101-1"
    returned_ids = {r["id"] for r in results}
    assert "chat-202-1" not in returned_ids
    assert "com-404-1" not in returned_ids

    # 3. Send a new private chat message and verify it never leaks into exercise feedback
    chat_res = client.post(
        "/api/private-chat/messages",
        json={
            "trustedSessionId": "session-101",
            "week": 2,
            "message": "Confidentially, I am interviewing at another company next Tuesday.",
        },
    )
    assert chat_res.status_code == 200

    fb_res = client.post(
        "/api/feedback",
        json={
            "trustedSessionId": "session-101",
            "newExercise": {
                "week": 2,
                "question": "Which conversation or decision did you postpone this week, and what happened?",
                "answer": "I postponed the conversation again because I wanted more data.",
            },
        },
    )
    assert fb_res.status_code == 200
    model_input_json = spy.captured_inputs[-1].model_dump_json()
    assert "interviewing at another company" not in model_input_json
    assert "leaving my job" not in model_input_json


