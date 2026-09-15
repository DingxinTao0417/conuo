"""Bounded processing. Database leases own retries and publication, not this process."""

from collections.abc import Callable
from dataclasses import dataclass, field
import threading
import time
from typing import Any, Protocol

from .errors import BudgetExpired, Cancelled, WorkerError
from .protocol import IndexingAPI, Job, integer, read_claim, read_chunks, timestamp
from .transport import check_budget


class Embedder(Protocol):
    def embed(self, texts: list[str], *, deadline: float,
              cancelled: threading.Event) -> list[list[float]]: ...


@dataclass
class RunResult:
    state: str = "idle"
    code: str = "NO_WORK"
    records: list[dict[str, str]] = field(default_factory=list)


def run_batch(api: IndexingAPI, embedder: Embedder, *, worker_id: str = "python-bounded-worker",
              max_jobs: int = 5, max_seconds: float = 40.0,
              cancelled: threading.Event | None = None,
              emit: Callable[[dict[str, str]], None] | None = None) -> RunResult:
    if type(max_jobs) is not int or not 1 <= max_jobs <= 5 or not 0 < max_seconds <= 40:
        raise WorkerError("RUN_BUDGET_INVALID")
    event = cancelled if cancelled is not None else threading.Event()
    deadline = time.monotonic() + max_seconds
    result = RunResult()
    seen = set()

    def report(job: Job | None, state: str, code: str):
        entry = {"state": state, "code": code}
        if job:
            entry["jobId"] = job.job_id
        result.records.append(entry)
        result.state, result.code = state, code
        if emit:
            emit(entry)

    def call(action: str, job: Job, **fields) -> dict[str, Any]:
        check_budget(deadline, event)
        return api.action(action, {**job.identity, **fields}, deadline=deadline, cancelled=event)

    def ensure_lease(job: Job):
        check_budget(deadline, event)
        if job.lease_until <= time.time():
            raise WorkerError("LEASE_EXPIRED")
        # Renew before a potentially slow provider request, never resurrect an
        # already-expired lease. The server independently fences every action.
        if job.lease_until - time.time() < min(35.0, deadline - time.monotonic() + 5):
            renewed = call("heartbeat", job)
            job.lease_until = timestamp(renewed.get("leaseUntil"))
            if job.lease_until <= time.time():
                raise WorkerError("LEASE_EXPIRED")

    for _ in range(max_jobs):
        job = None
        try:
            check_budget(deadline, event)
            if deadline - time.monotonic() < 5:
                report(None, "deferred", "BUDGET_REMAINING_LOW")
                break
            job = read_claim(api.action("claim", {"workerId": worker_id, "limit": 1, "leaseSeconds": 120},
                                       deadline=deadline, cancelled=event))
            if job is None:
                break
            if job.job_id in seen:
                report(job, "deferred", "DUPLICATE_CLAIM")
                break
            seen.add(job.job_id)
            while job.cursor < job.total:
                if deadline - time.monotonic() < 5:
                    raise BudgetExpired()
                ensure_lease(job)
                rows = read_chunks(call("read", job, limit=16), job)
                ensure_lease(job)
                # Reserve elapsed budget for the fenced commit. If exhausted,
                # do not read again (each read reserves the server's usage).
                vectors = embedder.embed([row["text"] for row in rows],
                                         deadline=deadline - 2.0, cancelled=event)
                check_budget(deadline, event)
                if len(vectors) != len(rows):
                    raise WorkerError("EMBEDDING_RESPONSE_INVALID")
                ensure_lease(job)
                next_cursor = job.cursor + len(rows)
                saved = call("commit", job, start=job.cursor, rows=[{
                    "chunkId": row["chunkId"], "contentHash": row["contentHash"], "embedding": vector,
                } for row, vector in zip(rows, vectors, strict=True)])
                if (integer(saved.get("cursor")) != next_cursor
                        or integer(saved.get("totalChunks")) != job.total
                        or saved.get("state") != "running"):
                    raise WorkerError("SERVER_COMMIT_INCOMPLETE")
                job.cursor = next_cursor
            # No finish for an unfinished cursor, uncertain commit, expired
            # lease, cancellation, or exhausted run budget.
            ensure_lease(job)
            published = call("finish", job)
            if published.get("state") != "succeeded":
                raise WorkerError("SERVER_FINISH_INCOMPLETE")
            report(job, "completed", "PUBLISHED")
        except Cancelled:
            report(job, "cancelled", "CANCELLED")
            break
        except BudgetExpired:
            report(job, "deferred", "BUDGET_EXPIRED")
            break
        except WorkerError as error:
            if error.code in {"SERVER_HTTP_409", "LEASE_EXPIRED"}:
                report(job, "stale", "LEASE_OR_CONTEXT_CHANGED")
                break
            if error.code.startswith("EMBEDDING_") and job:
                try:
                    # Only unambiguous provider failures use fail. An uncertain
                    # server commit/finish leaves its lease for reconciliation.
                    failed = call("fail", job, errorCode=error.code, retryable=error.retryable)
                    expected_state = "queued" if error.retryable and job.attempt < 5 else "failed"
                    if failed.get("state") != expected_state:
                        raise WorkerError("SERVER_FAIL_INCOMPLETE")
                    timestamp(failed.get("nextAttemptAt"))
                except Cancelled:
                    report(job, "cancelled", "CANCELLED")
                    break
                except BudgetExpired:
                    report(job, "deferred", "BUDGET_EXPIRED")
                    break
                except WorkerError:
                    report(job, "deferred", "FAIL_REPORT_UNCONFIRMED")
                    break
                report(job, "failed", error.code)
                if not error.retryable:
                    break
            else:
                report(job, "deferred", error.code)
                break
        except Exception:
            report(job, "deferred", "WORKER_INTERNAL")
            break
    return result
