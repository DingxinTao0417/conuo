"""Bounded JSON POST, no redirects, no proxy discovery, no automatic retries."""

import http.client
import json
import queue
import socket
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from .config import normalize_url
from .errors import BudgetExpired, Cancelled, WorkerError


def check_budget(deadline: float, cancelled: threading.Event) -> None:
    if cancelled.is_set():
        raise Cancelled()
    if time.monotonic() >= deadline:
        raise BudgetExpired()


def _reject_constant(_value: str):
    raise ValueError


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def post_json(url: str, secret: str, payload: dict[str, Any], *, deadline: float,
              cancelled: threading.Event, timeout: float = 8.0,
              max_request: int = 1024 * 1024, max_response: int = 1024 * 1024,
              prefix: str = "SERVER") -> Any:
    url = normalize_url(url)
    check_budget(deadline, cancelled)
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError):
        raise WorkerError(f"{prefix}_REQUEST_INVALID") from None
    if len(body) > max_request:
        raise WorkerError(f"{prefix}_REQUEST_TOO_LARGE")
    stop_at = min(deadline, time.monotonic() + timeout)
    result: queue.Queue = queue.Queue(maxsize=1)
    aborted = threading.Event()
    active: list[http.client.HTTPConnection] = []
    sockets: list[socket.socket] = []

    def stopped():
        if cancelled.is_set():
            raise Cancelled()
        if aborted.is_set() or time.monotonic() >= stop_at:
            raise WorkerError(f"{prefix}_TIMEOUT", retryable=True)

    def close_connection():
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for connection in active:
            connection.close()

    def request():
        connection = None
        response = None
        try:
            parts = urlsplit(url)
            cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
            connection = cls(parts.hostname, parts.port, timeout=max(0.01, stop_at - time.monotonic()))
            active.append(connection)
            stopped()
            connection.connect()
            if connection.sock:
                sockets.append(connection.sock)
            # DNS resolution itself may outlive cancellation. Never send headers
            # or content if resolution completed after the caller's budget.
            stopped()
            connection.request("POST", parts.path or "/", body=body, headers={
                "Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                "Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close",
            })
            stopped()
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise WorkerError(f"{prefix}_REDIRECT")
            if not 200 <= response.status < 300:
                # Do not consume or relay provider errors, URLs, or diagnostic text.
                raise WorkerError(f"{prefix}_HTTP_{response.status}",
                                  retryable=response.status in {408, 429} or response.status >= 500)
            if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise WorkerError(f"{prefix}_RESPONSE_INVALID")
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise WorkerError(f"{prefix}_RESPONSE_INVALID")
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > max_response):
                raise WorkerError(f"{prefix}_RESPONSE_TOO_LARGE")
            data = bytearray()
            while True:
                stopped()
                part = response.read1(min(8192, max_response + 1 - len(data)))
                if not part:
                    break
                data.extend(part)
                if len(data) > max_response:
                    raise WorkerError(f"{prefix}_RESPONSE_TOO_LARGE")
            stopped()
            if length is not None and len(data) != int(length):
                raise WorkerError(f"{prefix}_RESPONSE_INVALID")
            try:
                parsed = json.loads(data.decode("utf-8"), parse_constant=_reject_constant,
                                    object_pairs_hook=_object)
            except (ValueError, UnicodeError, RecursionError):
                raise WorkerError(f"{prefix}_RESPONSE_INVALID") from None
            stopped()
            result.put((True, parsed))
        except WorkerError as error:
            result.put((False, error))
        except (TimeoutError, socket.timeout):
            result.put((False, WorkerError(f"{prefix}_TIMEOUT", retryable=True)))
        except Exception:
            result.put((False, WorkerError(f"{prefix}_NETWORK", retryable=True)))
        finally:
            if response:
                response.close()
            if connection:
                connection.close()

    # The caller has a hard elapsed budget even if DNS or a slow peer blocks.
    # Cancellation closes the socket; this daemon never retries or sends after
    # a delayed connect. Python cannot cancel a system DNS resolver mid-call.
    thread = threading.Thread(target=request, daemon=True, name="conuo-http")
    thread.start()
    try:
        while True:
            check_budget(deadline, cancelled)
            left = stop_at - time.monotonic()
            if left <= 0:
                raise WorkerError(f"{prefix}_TIMEOUT", retryable=True)
            try:
                ok, value = result.get(timeout=min(left, 0.05))
            except queue.Empty:
                continue
            check_budget(deadline, cancelled)
            if ok:
                return value
            raise value
    finally:
        aborted.set()
        close_connection()
