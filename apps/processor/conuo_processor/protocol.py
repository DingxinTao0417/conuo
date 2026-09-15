"""Strict decoding of authorized job inputs and lease-fenced HTTP actions."""

from dataclasses import dataclass
from datetime import datetime
import hashlib
import re
import threading
from typing import Any, Protocol
import uuid

from .config import DIMENSIONS, PROFILE, ProcessorConfig
from .errors import WorkerError
from .transport import post_json


class IndexingAPI(Protocol):
    def action(self, name: str, data: dict[str, Any], *, deadline: float,
               cancelled: threading.Event) -> dict[str, Any]: ...


class IndexingClient:
    def __init__(self, config: ProcessorConfig):
        self.config = config

    def action(self, name: str, data: dict[str, Any], *, deadline: float,
               cancelled: threading.Event) -> dict[str, Any]:
        if name not in {"claim", "read", "commit", "finish", "heartbeat", "fail"}:
            raise WorkerError("SERVER_ACTION_INVALID")
        result = post_json(
            self.config.endpoint, self.config.secret,
            {**data, "action": name, "profileFingerprint": self.config.embedding.fingerprint},
            deadline=deadline, cancelled=cancelled,
        )
        if not isinstance(result, dict):
            raise WorkerError("SERVER_RESPONSE_INVALID")
        return result


def integer(value: Any, minimum: int = 0, maximum: int = 1_000_000) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise WorkerError("SERVER_RESPONSE_INVALID")
    return value


def identifier(value: Any, *, is_uuid: bool = False, limit: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
        raise WorkerError("SERVER_RESPONSE_INVALID")
    if is_uuid:
        try:
            if str(uuid.UUID(value)) != value.lower():
                raise ValueError
        except ValueError:
            raise WorkerError("SERVER_RESPONSE_INVALID") from None
    return value


def timestamp(value: Any) -> float:
    if not isinstance(value, str) or len(value) > 64:
        raise WorkerError("SERVER_RESPONSE_INVALID")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed.timestamp()
    except (ValueError, OverflowError):
        raise WorkerError("SERVER_RESPONSE_INVALID") from None


def digest(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise WorkerError("SERVER_RESPONSE_INVALID")
    return value


@dataclass
class Job:
    job_id: str
    owner_id: str
    lease_token: str
    lease_until: float
    cursor: int
    total: int
    attempt: int

    @property
    def identity(self) -> dict[str, str]:
        return {"jobId": self.job_id, "leaseToken": self.lease_token}


def read_claim(value: dict[str, Any]) -> Job | None:
    jobs = value.get("jobs")
    if not isinstance(jobs, list) or len(jobs) > 1:
        raise WorkerError("SERVER_RESPONSE_INVALID")
    if not jobs:
        return None
    raw = jobs[0]
    if not isinstance(raw, dict) or raw.get("profile") != PROFILE or raw.get("dimensions") != DIMENSIONS:
        raise WorkerError("SERVER_PROFILE_MISMATCH")
    owner_id = identifier(raw.get("ownerId"), is_uuid=True)
    identifier(raw.get("sourceId"))
    identifier(raw.get("versionId"))
    digest(raw.get("contentDigest"))
    total = integer(raw.get("totalChunks"))
    return Job(identifier(raw.get("jobId"), is_uuid=True), owner_id,
               identifier(raw.get("leaseToken"), is_uuid=True), timestamp(raw.get("leaseUntil")),
               integer(raw.get("cursor"), maximum=total), total, integer(raw.get("attempt"), minimum=1))


def read_chunks(value: dict[str, Any], job: Job) -> list[dict[str, Any]]:
    if (value.get("jobId") != job.job_id or value.get("ownerId") != job.owner_id
            or integer(value.get("cursor")) != job.cursor
            or integer(value.get("totalChunks")) != job.total):
        raise WorkerError("SERVER_BATCH_MISMATCH")
    rows = value.get("chunks")
    if not isinstance(rows, list) or len(rows) != min(16, job.total - job.cursor):
        raise WorkerError("SERVER_BATCH_MISMATCH")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise WorkerError("SERVER_BATCH_MISMATCH")
        chunk_id = identifier(row.get("chunkId"))
        integer(row.get("ordinal"))
        if chunk_id in seen:
            raise WorkerError("SERVER_BATCH_MISMATCH")
        seen.add(chunk_id)
        text = row.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 100_000:
            raise WorkerError("SERVER_BATCH_MISMATCH")
        try:
            actual = hashlib.sha256(text.encode("utf-8")).hexdigest()
        except UnicodeError:
            raise WorkerError("SERVER_BATCH_MISMATCH") from None
        if digest(row.get("contentHash")) != actual:
            raise WorkerError("SERVER_BATCH_MISMATCH")
    return rows
