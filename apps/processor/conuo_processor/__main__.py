"""CLI emits only job IDs, states and error codes. No dotenv loading or credentials generation."""

import argparse
import json
import signal
import sys
import threading

from .config import read_config
from .embeddings import EmbeddingClient
from .errors import WorkerError
from .protocol import IndexingClient
from .worker import run_batch


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise WorkerError("CLI_ARGUMENT_INVALID")


def main(argv: list[str] | None = None) -> int:
    parser = SafeParser(description="Run one bounded Conuo indexing batch.")
    parser.add_argument("--max-jobs", type=int, default=5)
    parser.add_argument("--max-seconds", type=float, default=40)
    try:
        args = parser.parse_args(argv)
    except WorkerError as error:
        print(json.dumps({"state": "failed", "code": error.code}), flush=True)
        return 2
    cancelled = threading.Event()
    previous = {}
    for name in ("SIGINT", "SIGTERM"):
        signum = getattr(signal, name, None)
        if signum is not None:
            previous[signum] = signal.signal(signum, lambda _number, _frame: cancelled.set())
    try:
        config = read_config()
        result = run_batch(IndexingClient(config), EmbeddingClient(config.embedding),
                           worker_id=config.worker_id, max_jobs=args.max_jobs,
                           max_seconds=args.max_seconds, cancelled=cancelled,
                           emit=lambda record: print(json.dumps(record), flush=True))
        if not result.records:
            print(json.dumps({"state": result.state, "code": result.code}))
        if result.state == "cancelled":
            return 130
        # A later completed job must not hide an earlier failed job in this run.
        failures = [row for row in result.records
                    if row["state"] not in {"completed", "idle"} and not row["code"].startswith("BUDGET_")]
        return 1 if failures else 0
    except WorkerError as error:
        print(json.dumps({"state": "failed", "code": error.code}), flush=True)
        return 2
    except Exception:
        print(json.dumps({"state": "failed", "code": "WORKER_INTERNAL"}), flush=True)
        return 1
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    sys.exit(main())
