"""All HTTP providers here are local test doubles; production has no fake vectors."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

from conuo_processor.config import DIMENSIONS, EmbeddingConfig, ProcessorConfig, normalize_url, read_config
from conuo_processor.embeddings import EmbeddingClient
from conuo_processor.errors import BudgetExpired, Cancelled, WorkerError
from conuo_processor.protocol import IndexingClient
from conuo_processor.transport import post_json
from conuo_processor.worker import run_batch

JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
LEASE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
KEY = "test-provider-key-must-not-leak"
SECRET = "test-internal-secret-must-not-leak"
TEXT = "Test-only source body must not be logged."
ROOT = Path(__file__).resolve().parents[1]


def future(seconds=120):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def vectors(count=1):
    return {"object": "list", "model": "test-model", "data": [
        {"object": "embedding", "index": index,
         "embedding": [float(index + 1)] + [0.0] * (DIMENSIONS - 1)} for index in range(count)
    ]}


@contextmanager
def server(respond):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            calls.append((self.path, dict(self.headers), payload))
            spec = respond(self.path, payload)
            if not isinstance(spec, tuple):
                spec = (200, spec, {}, 0, False)
            status, data, headers, delay, stream = spec
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            try:
                if not stream:
                    time.sleep(delay)
                self.send_response(status)
                self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                if not stream:
                    self.send_header("Content-Length", headers.get("Content-Length", str(len(body))))
                for key, value in headers.items():
                    if key not in {"Content-Type", "Content-Length"}:
                        self.send_header(key, value)
                self.end_headers()
                if stream:
                    for part in [body[:1], body[1:]]:
                        self.wfile.write(part)
                        self.wfile.flush()
                        time.sleep(delay)
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    instance.daemon_threads = True
    thread = threading.Thread(target=lambda: instance.serve_forever(poll_interval=0.02), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{instance.server_port}", calls
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=1)


def config(url):
    return ProcessorConfig(url + "/api/internal/indexing", SECRET,
                           EmbeddingConfig(url + "/v1", KEY, "test-model"))


def job(total=1, cursor=0):
    return {"jobId": JOB, "ownerId": OWNER, "sourceId": "source-one", "versionId": "version-one",
            "contentDigest": "d" * 64, "profile": "embedding-v1", "dimensions": 1536,
            "leaseToken": LEASE, "leaseUntil": future(), "cursor": cursor,
            "totalChunks": total, "attempt": 1}


class FakeAPI:
    """Lease service double for runner control-flow tests only."""
    def __init__(self, total=1, cursor=0):
        self.current = job(total, cursor)
        self.calls = []
        self.overrides = {}
        self.claimed = False

    def action(self, action, data, **_options):
        self.calls.append((action, data))
        if action in self.overrides:
            override = self.overrides[action]
            if isinstance(override, Exception):
                raise override
            return override(data) if callable(override) else override
        if action == "claim":
            if self.claimed:
                return {"jobs": []}
            self.claimed = True
            return {"jobs": [self.current.copy()]}
        if action == "read":
            start = self.current["cursor"]
            return {"jobId": self.current["jobId"], "ownerId": self.current["ownerId"], "cursor": start,
                    "totalChunks": self.current["totalChunks"], "chunks": [
                        {"chunkId": f"chunk-{index}", "text": TEXT,
                         "contentHash": hashlib.sha256(TEXT.encode()).hexdigest(), "ordinal": index * 3 + 8}
                        for index in range(start, min(start + 16, self.current["totalChunks"]))]}
        if action == "commit":
            self.current["cursor"] += len(data["rows"])
            return {"cursor": self.current["cursor"], "totalChunks": self.current["totalChunks"], "state": "running"}
        if action == "finish":
            return {"state": "succeeded"}
        if action == "heartbeat":
            return {"leaseUntil": future()}
        if action == "fail":
            return {"state": "queued" if data["retryable"] and self.current["attempt"] < 5 else "failed",
                    "nextAttemptAt": future()}
        raise AssertionError(action)

    @property
    def actions(self):
        return [name for name, _data in self.calls]


class FakeEmbedder:
    def __init__(self, error=None, after=None):
        self.error, self.after, self.calls = error, after, []

    def embed(self, texts, **options):
        self.calls.append(texts)
        if self.after:
            self.after(options)
        if self.error:
            raise self.error
        return [row["embedding"] for row in vectors(len(texts))["data"]]


class ConfigTests(unittest.TestCase):
    def test_config_is_explicit_and_repr_omits_secrets(self):
        with self.assertRaisesRegex(WorkerError, "CONFIG"):
            read_config({})
        value = config("http://127.0.0.1:1234")
        self.assertNotIn(KEY, repr(value))
        self.assertNotIn(SECRET, repr(value))
        self.assertNotIn("127.0.0.1", repr(value))

    def test_normalization_and_json_stringify_fingerprint(self):
        item = EmbeddingConfig("HTTPS://EXAMPLE.COM:443/v1///", KEY, "test-model")
        self.assertEqual(item.base_url, "https://example.com/v1")
        expected = hashlib.sha256(b'["embedding-v1","https://example.com/v1","test-model",1536]').hexdigest()
        self.assertEqual(item.fingerprint, expected)
        self.assertEqual(normalize_url("http://[::1]:80/v1/"), "http://[::1]/v1")

    def test_bad_urls_and_model_are_rejected(self):
        for url in ["", "http://example.com", "http://127.1", "http://localhost.evil", "https://x?", "https://x#",
                    "https://user:key@x/v1", "https://x\\evil", "https://x/../v1", "https://x/%2e/v1",
                    "https://x/空", "https://x/\n", "file:///tmp/a", "https://x:99999", "https://x/%zz"]:
            with self.subTest(url=url), self.assertRaises(WorkerError):
                normalize_url(url)
        for model in ["", "\nmodel", "模型"]:
            with self.subTest(model=model), self.assertRaises(WorkerError):
                EmbeddingConfig("https://example.com/v1", KEY, model)

    def test_endpoint_path_is_exact_and_environment_whitespace_matches_server(self):
        with self.assertRaises(WorkerError):
            ProcessorConfig("https://example.com/api/other", SECRET, config("https://example.com").embedding)
        parsed = read_config({"CONUO_PROCESSOR_ENDPOINT": " https://example.com/api/internal/indexing ",
                              "CONUO_PROCESSOR_SECRET": SECRET, "CONUO_EMBEDDING_BASE_URL": " https://example.com/v1 ",
                              "CONUO_EMBEDDING_API_KEY": KEY, "CONUO_EMBEDDING_MODEL": " test-model "})
        self.assertEqual(parsed.embedding.model, "test-model")


class ProviderTests(unittest.TestCase):
    def embed(self, url, texts=None, timeout=2, cancelled=None):
        client = EmbeddingClient(EmbeddingConfig(url + "/v1", KEY, "test-model", timeout))
        return client.embed(texts or [TEXT], deadline=time.monotonic() + 3,
                            cancelled=cancelled or threading.Event())

    def test_real_http_input_index_reordering_and_dimension_validation(self):
        payload = vectors(2)
        payload["data"].reverse()
        with server(lambda *_: payload) as (url, calls):
            result = self.embed(url, [TEXT, "Second test input"])
            self.assertEqual([row[0] for row in result], [1.0, 2.0])
            self.assertEqual(len(result[0]), DIMENSIONS)
            self.assertEqual(calls[0][0], "/v1/embeddings")
            self.assertEqual(calls[0][1]["Authorization"], "Bearer " + KEY)
            self.assertEqual(calls[0][2], {"input": [TEXT, "Second test input"], "model": "test-model", "encoding_format": "float"})

    def test_http_failures_never_retry_or_relay_provider_body(self):
        for status in [401, 403, 408, 429, 500, 503]:
            with self.subTest(status=status), server(lambda *_: (status, {"error": KEY + TEXT}, {}, 0, False)) as (url, calls):
                with self.assertRaises(WorkerError) as raised:
                    self.embed(url)
                self.assertEqual(raised.exception.code, f"EMBEDDING_HTTP_{status}")
                self.assertEqual(raised.exception.retryable, status in {408, 429, 500, 503})
                self.assertNotIn(KEY, str(raised.exception))
                self.assertNotIn(TEXT, str(raised.exception))
                self.assertEqual(len(calls), 1)

    def test_redirect_is_never_followed(self):
        with server(lambda *_: vectors()) as (target, target_calls):
            with server(lambda *_: (307, {}, {"Location": target + "/stolen"}, 0, False)) as (url, calls):
                with self.assertRaisesRegex(WorkerError, "EMBEDDING_REDIRECT"):
                    self.embed(url)
                self.assertEqual(len(calls), 1)
                self.assertEqual(target_calls, [])

    def test_indices_counts_types_dimensions_finite_and_range_are_strict(self):
        invalid = []
        for value in [True, -1, 1, "0"]:
            body = vectors(); body["data"][0]["index"] = value; invalid.append(body)
        for value in [math.nan, math.inf, -math.inf, 1e11, True, "0", 10 ** 500]:
            body = vectors(); body["data"][0]["embedding"][0] = value; invalid.append(body)
        for value in [[0.0] * 1536, [1.0] * 1535, [1.0] * 1537, "base64"]:
            body = vectors(); body["data"][0]["embedding"] = value; invalid.append(body)
        invalid.extend([{"data": []}, {**vectors(), "data": []}, {**vectors(), "data": vectors(2)["data"]},
                        {**vectors(), "object": "other"}, {**vectors(), "model": ""}])
        for index, body in enumerate(invalid):
            with self.subTest(case=index), server(lambda *_: body) as (url, _calls):
                with self.assertRaisesRegex(WorkerError, "EMBEDDING_RESPONSE_INVALID"):
                    self.embed(url)
        duplicate = vectors(2)
        duplicate["data"][1]["index"] = 0
        with server(lambda *_: duplicate) as (url, _calls):
            with self.assertRaisesRegex(WorkerError, "EMBEDDING_RESPONSE_INVALID"):
                self.embed(url, [TEXT, TEXT])

    def test_response_json_and_size_bounds(self):
        cases = [(b'{"data":[],"data":[]}', {}, False), (b"invalid", {}, False),
                 (vectors(), {"Content-Type": "text/html"}, False),
                 (vectors(), {"Content-Encoding": "gzip"}, False),
                 (b"{}", {"Content-Length": str(2 * 1024 * 1024)}, False),
                 (b" " * (1024 * 1024 + 1), {}, True)]
        for body, headers, stream in cases:
            with self.subTest(headers=headers, streamed=stream), server(lambda *_: (200, body, headers, 0, stream)) as (url, _calls):
                with self.assertRaises(WorkerError):
                    self.embed(url)

    def test_input_bounds_do_not_make_requests(self):
        with server(lambda *_: vectors()) as (url, calls):
            for inputs in [[""], ["x"] * 17, ["x" * 24001], ["汉" * 24000] * 2]:
                with self.subTest(count=len(inputs)), self.assertRaises(WorkerError):
                    self.embed(url, inputs)
            self.assertEqual(calls, [])

    def test_timeout_cancellation_and_slow_stream_are_bounded(self):
        for stream in [False, True]:
            with self.subTest(stream=stream), server(lambda *_: (200, vectors(), {}, 0.5, stream)) as (url, calls):
                started = time.monotonic()
                with self.assertRaisesRegex(WorkerError, "EMBEDDING_TIMEOUT"):
                    self.embed(url, timeout=0.08)
                self.assertLess(time.monotonic() - started, 0.4)
                self.assertEqual(len(calls), 1)
        with server(lambda *_: (200, vectors(), {}, 0.5, False)) as (url, _calls):
            cancelled = threading.Event()
            timer = threading.Timer(0.06, cancelled.set); timer.start()
            try:
                with self.assertRaises(Cancelled):
                    self.embed(url, cancelled=cancelled)
            finally:
                timer.join()

    def test_expired_budget_and_preexisting_cancel_never_send(self):
        with server(lambda *_: vectors()) as (url, calls):
            with self.assertRaises(BudgetExpired):
                post_json(url, KEY, {}, deadline=time.monotonic() - 1, cancelled=threading.Event())
            event = threading.Event(); event.set()
            with self.assertRaises(Cancelled):
                self.embed(url, cancelled=event)
            self.assertEqual(calls, [])

    def test_total_deadline_cuts_off_longer_transport_timeout(self):
        with server(lambda *_: (200, vectors(), {}, 0.5, False)) as (url, calls):
            started = time.monotonic()
            with self.assertRaises(BudgetExpired):
                post_json(url, KEY, {}, deadline=started + 0.08, timeout=5,
                          cancelled=threading.Event())
            self.assertLess(time.monotonic() - started, 0.4)
            self.assertEqual(len(calls), 1)


class RunnerTests(unittest.TestCase):
    def test_multiple_batches_keep_sparse_ordinals_and_publish_only_at_total(self):
        api = FakeAPI(total=18)
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(result.state, "completed")
        self.assertEqual(api.actions, ["claim", "read", "commit", "read", "commit", "finish", "claim"])
        commits = [data for name, data in api.calls if name == "commit"]
        self.assertEqual([value["start"] for value in commits], [0, 16])
        self.assertEqual([len(value["rows"]) for value in commits], [16, 2])
        self.assertEqual(commits[1]["rows"][0]["chunkId"], "chunk-16")

    def test_partial_finish_is_not_reported_as_success(self):
        api = FakeAPI(); api.overrides["finish"] = {"state": "running"}
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(result.code, "SERVER_FINISH_INCOMPLETE")
        self.assertNotIn("fail", api.actions)
        self.assertEqual(result.state, "deferred")

    def test_partial_or_uncertain_commit_never_finishes(self):
        for value in [{"cursor": 0, "totalChunks": 1, "state": "running"},
                      {"cursor": 2, "totalChunks": 1, "state": "running"},
                      {"cursor": 1, "totalChunks": 1, "state": "succeeded"},
                      WorkerError("SERVER_TIMEOUT", retryable=True)]:
            with self.subTest(value=value):
                api = FakeAPI(); api.overrides["commit"] = value
                result = run_batch(api, FakeEmbedder())
                self.assertEqual(result.state, "deferred")
                self.assertNotIn("finish", api.actions)
                self.assertNotIn("fail", api.actions)

    def test_stale_lease_at_each_action_never_publishes_or_fails_another_attempt(self):
        for action in ["read", "commit", "finish", "heartbeat"]:
            with self.subTest(action=action):
                api = FakeAPI()
                if action == "heartbeat": api.current["leaseUntil"] = future(10)
                api.overrides[action] = WorkerError("SERVER_HTTP_409")
                result = run_batch(api, FakeEmbedder())
                self.assertEqual(result.state, "stale")
                self.assertNotIn("fail", api.actions)
                self.assertEqual(api.actions[-1], action)

    def test_expired_lease_is_not_renewed(self):
        api = FakeAPI(); api.current["leaseUntil"] = future(-1)
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(result.state, "stale")
        self.assertEqual(api.actions, ["claim"])

    def test_heartbeat_before_slow_work(self):
        api = FakeAPI(); api.current["leaseUntil"] = future(10)
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(result.state, "completed")
        self.assertEqual(api.actions[:3], ["claim", "heartbeat", "read"])

    def test_deadline_or_cancel_after_embedding_leaves_lease_no_commit(self):
        for kind in ["deadline", "cancel"]:
            with self.subTest(kind=kind):
                event = threading.Event(); api = FakeAPI()
                embed = FakeEmbedder(error=BudgetExpired()) if kind == "deadline" else FakeEmbedder(after=lambda _: event.set())
                result = run_batch(api, embed, cancelled=event)
                self.assertEqual(result.state, "deferred" if kind == "deadline" else "cancelled")
                self.assertEqual(api.actions, ["claim", "read"])

    def test_low_budget_does_not_claim_or_reserve_read_usage(self):
        api = FakeAPI()
        result = run_batch(api, FakeEmbedder(), max_seconds=0.1)
        self.assertEqual(result.code, "BUDGET_REMAINING_LOW")
        self.assertEqual(api.actions, [])

    def test_provider_error_classification_and_fail_payload_are_safe(self):
        for error in [WorkerError("EMBEDDING_HTTP_429", retryable=True),
                      WorkerError("EMBEDDING_HTTP_401"), WorkerError("EMBEDDING_RESPONSE_INVALID")]:
            with self.subTest(code=error.code):
                api = FakeAPI()
                result = run_batch(api, FakeEmbedder(error=error))
                self.assertEqual(result.state, "failed")
                failed = next(data for name, data in api.calls if name == "fail")
                self.assertEqual(failed, {"jobId": JOB, "leaseToken": LEASE,
                                          "errorCode": error.code, "retryable": error.retryable})
                self.assertNotIn(TEXT, json.dumps(result.records))
                self.assertNotIn(LEASE, json.dumps(result.records))

    def test_fail_http_error_does_not_claim_more_or_claim_failure_confirmed(self):
        api = FakeAPI(); api.overrides["fail"] = WorkerError("SERVER_HTTP_503", retryable=True)
        result = run_batch(api, FakeEmbedder(error=WorkerError("EMBEDDING_HTTP_429", retryable=True)))
        self.assertEqual(result.code, "FAIL_REPORT_UNCONFIRMED")
        self.assertEqual(api.actions, ["claim", "read", "fail"])

    def test_malformed_failure_acknowledgement_is_not_confirmed(self):
        for reply in [{}, {"state": "succeeded", "nextAttemptAt": future()},
                      {"state": "queued", "nextAttemptAt": None}]:
            with self.subTest(reply=reply):
                api = FakeAPI(); api.overrides["fail"] = reply
                result = run_batch(api, FakeEmbedder(error=WorkerError("EMBEDDING_HTTP_429", retryable=True)))
                self.assertEqual(result.code, "FAIL_REPORT_UNCONFIRMED")
                self.assertEqual(api.actions, ["claim", "read", "fail"])

    def test_last_attempt_failure_is_terminal(self):
        api = FakeAPI(); api.current["attempt"] = 5
        result = run_batch(api, FakeEmbedder(error=WorkerError("EMBEDDING_HTTP_503", retryable=True)))
        self.assertEqual(result.state, "failed")

    def test_cancel_or_budget_during_failure_reporting_preserves_stop_state(self):
        for error in [Cancelled(), BudgetExpired()]:
            with self.subTest(code=error.code):
                api = FakeAPI(); api.overrides["fail"] = error
                result = run_batch(api, FakeEmbedder(error=WorkerError("EMBEDDING_HTTP_429", retryable=True)))
                self.assertEqual(result.code, error.code)
                self.assertEqual(api.actions, ["claim", "read", "fail"])

    def test_claim_profile_and_uuid_are_checked_before_read(self):
        for field, value in [("profile", "different"), ("dimensions", 10), ("jobId", TEXT),
                             ("leaseToken", TEXT), ("ownerId", TEXT), ("cursor", 2)]:
            with self.subTest(field=field):
                api = FakeAPI(); api.current[field] = value
                embed = FakeEmbedder()
                result = run_batch(api, embed)
                self.assertEqual(result.state, "deferred")
                self.assertEqual(api.actions, ["claim"])
                self.assertEqual(embed.calls, [])
                self.assertNotIn(TEXT, json.dumps(result.records))

    def test_duplicate_claim_and_five_job_budget_do_not_loop(self):
        api = FakeAPI(); api.overrides["claim"] = lambda _: {"jobs": [api.current.copy()]}
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(result.code, "DUPLICATE_CLAIM")
        self.assertEqual(api.actions.count("finish"), 1)
        api = FakeAPI(total=0)
        def next_job(_data):
            api.current["jobId"] = f"aaaaaaaa-aaaa-4aaa-8aaa-{api.actions.count('claim'):012d}"
            return {"jobs": [api.current.copy()]}
        api.overrides["claim"] = next_job
        result = run_batch(api, FakeEmbedder())
        self.assertEqual(len(result.records), 5)
        self.assertEqual(api.actions.count("claim"), 5)
        self.assertEqual(api.actions.count("finish"), 5)

    def test_wrong_owner_source_hash_chunk_count_or_identity_never_reaches_provider(self):
        for change in ["owner", "hash", "count", "duplicate", "cursor", "job"]:
            with self.subTest(change=change):
                api = FakeAPI(total=2)
                value = api.action("read", {})
                api.calls.clear()
                if change == "owner": value["ownerId"] = JOB
                if change == "hash": value["chunks"][0]["contentHash"] = "a" * 64
                if change == "count": value["chunks"].pop()
                if change == "duplicate": value["chunks"][1]["chunkId"] = value["chunks"][0]["chunkId"]
                if change == "cursor": value["cursor"] = 1
                if change == "job": value["jobId"] = OWNER
                api.overrides["read"] = value
                embed = FakeEmbedder()
                result = run_batch(api, embed)
                self.assertEqual(result.state, "deferred")
                self.assertEqual(embed.calls, [])
                self.assertNotIn("finish", api.actions)

    def test_daily_read_budget_denial_does_not_call_provider_or_reserve_again(self):
        api = FakeAPI(); api.overrides["read"] = WorkerError("SERVER_HTTP_429", retryable=True)
        embed = FakeEmbedder()
        result = run_batch(api, embed)
        self.assertEqual(result.code, "SERVER_HTTP_429")
        self.assertEqual(api.actions, ["claim", "read"])
        self.assertEqual(embed.calls, [])

    def test_resume_at_persisted_cursor_and_max_jobs_limit(self):
        api = FakeAPI(total=18, cursor=16)
        result = run_batch(api, FakeEmbedder(), max_jobs=1)
        self.assertEqual(result.state, "completed")
        self.assertEqual(api.actions, ["claim", "read", "commit", "finish"])
        self.assertEqual(api.calls[2][1]["start"], 16)


class HTTPAndCLITests(unittest.TestCase):
    def env(self, url):
        result = {key: value for key, value in os.environ.items() if not key.startswith("CONUO_")}
        result.update({"CONUO_PROCESSOR_ENDPOINT": url + "/api/internal/indexing",
                       "CONUO_PROCESSOR_SECRET": SECRET, "CONUO_EMBEDDING_BASE_URL": url + "/v1",
                       "CONUO_EMBEDDING_API_KEY": KEY, "CONUO_EMBEDDING_MODEL": "test-model",
                       "PYTHONDONTWRITEBYTECODE": "1"})
        return result

    def test_real_cli_http_claim_embed_commit_finish_and_safe_output(self):
        fake = FakeAPI(total=2)
        def respond(path, payload):
            if path == "/v1/embeddings": return vectors(len(payload["input"]))
            return fake.action(payload["action"], payload)
        with server(respond) as (url, calls):
            ran = subprocess.run([sys.executable, "-B", "-m", "conuo_processor", "--max-jobs", "1"],
                                 cwd=ROOT, env=self.env(url), capture_output=True, text=True, timeout=8)
            self.assertEqual(ran.returncode, 0, ran.stderr + ran.stdout)
            self.assertEqual(json.loads(ran.stdout), {"jobId": JOB, "state": "completed", "code": "PUBLISHED"})
            self.assertEqual(ran.stderr, "")
            expected = config(url).embedding.fingerprint
            for path, headers, payload in calls:
                if path == "/api/internal/indexing":
                    self.assertEqual(headers["Authorization"], "Bearer " + SECRET)
                    self.assertEqual(payload["profileFingerprint"], expected)
            for sensitive in [KEY, SECRET, TEXT, LEASE, OWNER]:
                self.assertNotIn(sensitive, ran.stdout + ran.stderr)

    def test_real_http_stale_lease_does_not_reach_provider(self):
        fake = FakeAPI()
        with server(lambda path, body: (409, {"error": TEXT}, {}, 0, False) if body["action"] == "read"
                    else fake.action(body["action"], body)) as (url, calls):
            cfg = config(url)
            result = run_batch(IndexingClient(cfg), EmbeddingClient(cfg.embedding))
            self.assertEqual(result.state, "stale")
            self.assertEqual([body["action"] for _path, _headers, body in calls], ["claim", "read"])

    def test_cli_later_success_does_not_hide_prior_provider_failure(self):
        fake = FakeAPI()
        def next_job(_data):
            count = fake.actions.count("claim")
            if count > 2:
                return {"jobs": []}
            fake.current = job()
            fake.current["jobId"] = f"aaaaaaaa-aaaa-4aaa-8aaa-{count:012d}"
            return {"jobs": [fake.current.copy()]}
        fake.overrides["claim"] = next_job
        provider_calls = []
        def respond(path, payload):
            if path == "/v1/embeddings":
                provider_calls.append(payload)
                return (429, {"error": KEY + TEXT}, {}, 0, False) if len(provider_calls) == 1 else vectors()
            return fake.action(payload["action"], payload)
        with server(respond) as (url, _calls):
            ran = subprocess.run([sys.executable, "-B", "-m", "conuo_processor"], cwd=ROOT,
                                 env=self.env(url), capture_output=True, text=True, timeout=8)
            self.assertEqual(ran.returncode, 1, ran.stderr + ran.stdout)
            self.assertEqual([json.loads(line)["state"] for line in ran.stdout.splitlines()], ["failed", "completed"])
            self.assertEqual(ran.stderr, "")
            self.assertNotIn(KEY, ran.stdout)
            self.assertNotIn(TEXT, ran.stdout)

    def test_cli_missing_config_exits_cleanly_without_traceback(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("CONUO_")}
        ran = subprocess.run([sys.executable, "-B", "-m", "conuo_processor"], cwd=ROOT,
                             env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(ran.returncode, 2)
        self.assertEqual(json.loads(ran.stdout)["code"], "CONFIG_MISSING_OR_INVALID")
        self.assertEqual(ran.stderr, "")

    def test_cli_invalid_argument_is_sanitized(self):
        ran = subprocess.run([sys.executable, "-B", "-m", "conuo_processor", "--max-jobs", KEY],
                             cwd=ROOT, capture_output=True, text=True, timeout=5)
        self.assertEqual(ran.returncode, 2)
        self.assertEqual(json.loads(ran.stdout)["code"], "CLI_ARGUMENT_INVALID")
        self.assertEqual(ran.stderr, "")
        self.assertNotIn(KEY, ran.stdout)

    def test_cli_idle_and_small_budget_exit_zero_with_no_provider_call(self):
        for args in [[], ["--max-seconds", "0.1"]]:
            with self.subTest(args=args), server(lambda *_: {"jobs": []}) as (url, calls):
                ran = subprocess.run([sys.executable, "-B", "-m", "conuo_processor", *args], cwd=ROOT,
                                     env=self.env(url), capture_output=True, text=True, timeout=5)
                self.assertEqual(ran.returncode, 0)
                self.assertEqual(json.loads(ran.stdout)["code"], "BUDGET_REMAINING_LOW" if args else "NO_WORK")
                self.assertEqual(len(calls), 0 if args else 1)


if __name__ == "__main__":
    unittest.main()
