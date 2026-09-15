"""Explicit configuration and a fingerprint shared with the Next.js service."""

from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import os
import re
from collections.abc import Mapping
from urllib.parse import unquote, urlsplit, urlunsplit

from .errors import WorkerError

PROFILE = "embedding-v1"
DIMENSIONS = 1536


def normalize_url(value: str) -> str:
    # Restrict ambiguous WHATWG / urllib spellings so both runtimes hash the
    # same URL. Configuration is never taken from job text or an HTTP result.
    if (not isinstance(value, str) or not value or len(value) > 2048
            or not value.isascii() or re.search(r"[\s\x00-\x1f\x7f\\]", value)
            or "?" in value or "#" in value):
        raise WorkerError("CONFIG_URL_INVALID")
    try:
        parts = urlsplit(value)
        host, port = parts.hostname, parts.port
        if (parts.scheme not in {"http", "https"} or not host or parts.username is not None
                or parts.password is not None or not re.fullmatch(r"[a-zA-Z0-9.\-:\[\]]+", parts.netloc)):
            raise ValueError
        if parts.scheme == "http" and host not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        if (any(unquote(segment) in {".", ".."} for segment in parts.path.split("/"))
                or re.search(r"%2e", parts.path, re.IGNORECASE)
                or not re.fullmatch(r"[a-zA-Z0-9/_~.!$&'()*+,;=:@%\-]*", parts.path)):
            raise ValueError
        if re.search(r"%(?![0-9a-fA-F]{2})", parts.path):
            raise ValueError
        host = f"[{ipaddress.IPv6Address(host).compressed}]" if ":" in host else host
        authority = host.lower()
        if port is not None and port != (443 if parts.scheme == "https" else 80):
            authority += f":{port}"
        return urlunsplit((parts.scheme, authority, parts.path.rstrip("/"), "", ""))
    except (ValueError, UnicodeError):
        raise WorkerError("CONFIG_URL_INVALID") from None


def _value(env: Mapping[str, str], name: str, limit: int = 2048) -> str:
    raw = env.get(name, "")
    if not isinstance(raw, str):
        raise WorkerError("CONFIG_MISSING_OR_INVALID")
    value = raw.strip()
    if (not value or len(value) > limit
            or re.search(r"[\x00-\x1f\x7f]", value)):
        raise WorkerError("CONFIG_MISSING_OR_INVALID")
    return value


@dataclass(frozen=True)
class EmbeddingConfig:
    base_url: str = field(repr=False)
    api_key: str = field(repr=False)
    model: str = field(repr=False)
    timeout_seconds: float = 20.0

    def __post_init__(self):
        object.__setattr__(self, "base_url", normalize_url(self.base_url))
        if (not self.api_key or not self.api_key.isascii() or re.search(r"[\s\x00-\x1f\x7f]", self.api_key)
                or len(self.api_key) > 4096 or not self.model or not self.model.isascii() or len(self.model) > 256
                or self.model != self.model.strip() or re.search(r"[\x00-\x1f\x7f]", self.model)
                or not 0 < self.timeout_seconds <= 30):
            raise WorkerError("CONFIG_EMBEDDING_INVALID")

    @property
    def fingerprint(self) -> str:
        encoded = json.dumps([PROFILE, self.base_url, self.model, DIMENSIONS],
                             ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ProcessorConfig:
    endpoint: str = field(repr=False)
    secret: str = field(repr=False)
    embedding: EmbeddingConfig
    worker_id: str = "python-bounded-worker"

    def __post_init__(self):
        object.__setattr__(self, "endpoint", normalize_url(self.endpoint))
        if (urlsplit(self.endpoint).path != "/api/internal/indexing"
                or not self.secret or not self.secret.isascii() or not 32 <= len(self.secret) <= 4096
                or re.search(r"[\s\x00-\x1f\x7f]", self.secret)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", self.worker_id)):
            raise WorkerError("CONFIG_PROCESSOR_INVALID")


def read_config(env: Mapping[str, str] | None = None) -> ProcessorConfig:
    values = os.environ if env is None else env
    return ProcessorConfig(
        endpoint=_value(values, "CONUO_PROCESSOR_ENDPOINT"),
        secret=_value(values, "CONUO_PROCESSOR_SECRET", 4096),
        embedding=EmbeddingConfig(
            base_url=_value(values, "CONUO_EMBEDDING_BASE_URL"),
            api_key=_value(values, "CONUO_EMBEDDING_API_KEY", 4096),
            model=_value(values, "CONUO_EMBEDDING_MODEL", 256),
        ),
        worker_id=values.get("CONUO_PROCESSOR_WORKER_ID", "python-bounded-worker"),
    )
