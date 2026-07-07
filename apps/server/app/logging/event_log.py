from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class EventLogEntry:
    ts: datetime
    session_id: str
    event_type: str
    payload: dict[str, Any]

