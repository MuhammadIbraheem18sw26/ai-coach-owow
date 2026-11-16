import json
from pathlib import Path
from typing import Optional
from .schemas import FixtureData, MemberRecord, Scenario, TrustedSession

DEFAULT_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "fixture.json"


class RecordStore:
    def __init__(self, fixture_path: Path = DEFAULT_FIXTURE_PATH) -> None:
        self._fixture_path = fixture_path
        self._data: FixtureData = self._load_fixture()

    def _load_fixture(self) -> FixtureData:
        raw = json.loads(self._fixture_path.read_text(encoding="utf-8"))
        return FixtureData.model_validate(raw)

    def reset(self) -> None:
        self._data = self._load_fixture()

    def resolve_member_id(self, trusted_session_id: str) -> Optional[str]:
        for session in self._data.trustedSessions:
            if session.id == trusted_session_id:
                return session.memberId
        return None

    def list_all_records(self) -> list[MemberRecord]:
        return list(self._data.records)

    def list_scenarios(self) -> list[Scenario]:
        return list(self._data.scenarios)

    def list_sessions(self) -> list[TrustedSession]:
        return list(self._data.trustedSessions)

    def save_new_commitment(self, member_id: str, week: int, text: str) -> MemberRecord:
        new_id = f"com-{member_id.split('-')[-1]}-w{week}-{len(self._data.records)}"
        for rec in self._data.records:
            if (
                rec.memberId == member_id
                and rec.type == "commitment"
                and rec.visibility == "exercise"
                and rec.status == "active"
            ):
                rec.status = "superseded"
                rec.replacedBy = new_id

        new_record = MemberRecord(
            id=new_id,
            memberId=member_id,
            type="commitment",
            visibility="exercise",
            week=week,
            status="active",
            text=text.strip(),
        )
        self._data.records.append(new_record)
        return new_record
