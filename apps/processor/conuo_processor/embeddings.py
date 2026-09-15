"""Embedding vectors must come from the configured compatible provider."""

import math
import threading

from .config import DIMENSIONS, EmbeddingConfig
from .errors import WorkerError
from .transport import post_json

MAX_INPUTS = 16
MAX_INPUT_BYTES = 120_000
MAX_INPUT_CHARS = 24_000
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_VECTOR_COMPONENT = 1e10


class EmbeddingClient:
    def __init__(self, config: EmbeddingConfig):
        self.config = config

    def embed(self, texts: list[str], *, deadline: float,
              cancelled: threading.Event) -> list[list[float]]:
        if (not 1 <= len(texts) <= MAX_INPUTS
                or any(not isinstance(text, str) or not text.strip() or len(text) > MAX_INPUT_CHARS for text in texts)):
            raise WorkerError("EMBEDDING_INPUT_INVALID")
        try:
            if sum(len(text.encode("utf-8")) for text in texts) > MAX_INPUT_BYTES:
                raise WorkerError("EMBEDDING_REQUEST_TOO_LARGE")
        except UnicodeError:
            raise WorkerError("EMBEDDING_INPUT_INVALID") from None
        payload = post_json(
            self.config.base_url + "/embeddings", self.config.api_key,
            {"input": texts, "model": self.config.model, "encoding_format": "float"},
            deadline=deadline, cancelled=cancelled, timeout=self.config.timeout_seconds,
            max_request=MAX_INPUT_BYTES + 4096, max_response=MAX_RESPONSE_BYTES,
            prefix="EMBEDDING",
        )
        if (not isinstance(payload, dict) or payload.get("object") != "list"
                or not isinstance(payload.get("model"), str) or not payload["model"].strip()
                or not isinstance(payload.get("data"), list) or len(payload["data"]) != len(texts)):
            raise WorkerError("EMBEDDING_RESPONSE_INVALID")
        results: dict[int, list[float]] = {}
        for row in payload["data"]:
            if not isinstance(row, dict):
                raise WorkerError("EMBEDDING_RESPONSE_INVALID")
            index, vector = row.get("index"), row.get("embedding")
            if (type(index) is not int or not 0 <= index < len(texts) or index in results
                    or row.get("object") != "embedding" or not isinstance(vector, list)
                    or len(vector) != DIMENSIONS):
                raise WorkerError("EMBEDDING_RESPONSE_INVALID")
            if any(type(value) not in {int, float} or abs(value) > MAX_VECTOR_COMPONENT
                   or not math.isfinite(value) for value in vector):
                raise WorkerError("EMBEDDING_RESPONSE_INVALID")
            if not any(value != 0 for value in vector):
                raise WorkerError("EMBEDDING_RESPONSE_INVALID")
            results[index] = vector
        return [results[index] for index in range(len(texts))]
