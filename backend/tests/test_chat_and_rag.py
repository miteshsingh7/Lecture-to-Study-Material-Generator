"""Unit and integration tests for chunking, BM25 retrieval, chat service, and LLM provider."""

from __future__ import annotations

import email.message
import io
import json
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import app as flask_app_module
import lambda_api
from chat_service import MAX_HISTORY_TURNS, MAX_QUESTION_CHARS, handle_chat
from config import Settings
from llm_provider import LLMServiceError, TokenRateLimiter, chat_completion, estimate_tokens
from pipeline import process_lecture_text
from retrieval import BM25Retriever, build_retrieval_chunks, build_search_query, retrieve_top_chunks, tokenize
from storage import LocalStorage


def _mock_settings(provider: str = "mock", groq_key: str = "test-secret-key-123") -> Settings:
    return Settings(
        llm_provider=provider,
        groq_api_key=groq_key,
        groq_model="llama-3.3-70b-versatile",
        groq_fallback_model="llama-3.1-8b-instant",
        groq_endpoint="https://api.groq.com/openai/v1/chat/completions",
        groq_tpm_limit=12000,
        groq_rpm_limit=30,
        bedrock_model_id="amazon.nova-micro-v1:0",
        aws_region="ap-southeast-2",
        bucket_name="test-bucket",
        local_data_dir="local_data",
    )


def _sample_text() -> str:
    return (Path(__file__).resolve().parents[1] / "sample_lecture.txt").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Chunking & Retrieval Tests
# ---------------------------------------------------------------------------
def test_build_retrieval_chunks_respects_size_overlap_and_numbering() -> None:
    long_text = "\n\n".join(
        [
            f"Paragraph {i}: Distributed Raft consensus protocols rely on leader election, "
            f"quorum replication, term numbers, and randomized heartbeat timeouts to ensure "
            f"safety across asynchronous networks even under node crashes."
            for i in range(1, 30)
        ]
    )
    chunks = build_retrieval_chunks(long_text, target_chars=1200, max_chars=1500, overlap_chars=180)
    assert len(chunks) >= 3
    assert [c["chunk_number"] for c in chunks] == list(range(1, len(chunks) + 1))
    assert all(len(c["text"]) <= 1500 for c in chunks)
    # Interior chunks should hit the 1000-1500 target band
    assert all(950 <= len(c["text"]) <= 1500 for c in chunks[:-1])
    # Overlap check: end of chunk 1 shares tail words with start of chunk 2
    tail_words = chunks[0]["text"].split()[-5:]
    assert any(w in chunks[1]["text"] for w in tail_words)


def test_bm25_returns_expected_chunk_for_sample_questions() -> None:
    chunks = [
        {"chunk_number": 1, "text": "TCP uses a three-way handshake SYN, SYN-ACK, ACK for reliable byte streams."},
        {"chunk_number": 2, "text": "Quicksort selects a pivot and partitions arrays with O(n log n) average runtime."},
        {"chunk_number": 3, "text": "Raft prevents split votes using randomized election timeouts between 150ms and 300ms."},
        {"chunk_number": 4, "text": "B-Trees store sorted keys in disk pages for balanced logarithmic lookups."},
        {"chunk_number": 5, "text": "Bloom filters test set membership probabilistically with zero false negatives."},
    ]
    retriever = BM25Retriever(chunks)
    top = retriever.search("How does Raft prevent split votes using election timeouts?", top_k=4)
    assert len(top) == 4
    assert top[0]["chunk_number"] == 3
    assert top[0]["score"] > top[1]["score"]


def test_tokenize_removes_stopwords_and_punctuation() -> None:
    tokens = tokenize("What is the Role of Randomized Timeouts in Raft?")
    assert "role" in tokens
    assert "randomized" in tokens
    assert "raft" in tokens
    assert "the" not in tokens
    assert "is" not in tokens


def test_short_followup_includes_previous_user_question() -> None:
    history = [
        {"role": "user", "content": "How does Raft prevent split votes?"},
        {"role": "assistant", "content": "By using randomized election timeouts [Excerpt 3]."},
    ]
    expanded = build_search_query("How long is that?", history)
    assert "split votes" in expanded
    assert "How long is that?" in expanded


# ---------------------------------------------------------------------------
# 2. Chat Service Validation, Grounding, and Caps
# ---------------------------------------------------------------------------
def test_chat_service_in_scope_and_out_of_scope_with_mock_provider(tmp_path) -> None:
    storage = LocalStorage(tmp_path)
    settings = _mock_settings(provider="mock")
    process_lecture_text(
        job_id="job-raft",
        filename="sample_lecture.txt",
        text=_sample_text(),
        storage=storage,
        settings_override=settings,
    )

    # In-scope question
    status, res = handle_chat(
        {"job_id": "job-raft", "question": "How does Raft prevent split votes?"},
        storage,
        settings_override=settings,
    )
    assert status == 200
    assert "Excerpt" in res["answer"]
    assert res["model"] == "mock-study-model"
    assert len(res["sources"]) >= 1
    assert "chunk_number" in res["sources"][0]
    assert "snippet" in res["sources"][0]

    # Out-of-scope question
    status2, res2 = handle_chat(
        {"job_id": "job-raft", "question": "Who won the 1998 World Cup?"},
        storage,
        settings_override=settings,
    )
    assert status2 == 200
    assert "does not cover" in res2["answer"].lower()


def test_chat_service_validates_job_state(tmp_path) -> None:
    storage = LocalStorage(tmp_path)
    settings = _mock_settings(provider="mock")

    code, body = handle_chat({"job_id": "missing", "question": "Hello?"}, storage, settings_override=settings)
    assert code == 404
    assert "not found" in body["error"].lower()

    storage.write_status("job-proc", "processing", "Working...")
    code, body = handle_chat({"job_id": "job-proc", "question": "Hello?"}, storage, settings_override=settings)
    assert code == 409
    assert "processing" in body["error"].lower()

    storage.write_status("job-err", "error", "Failed")
    code, body = handle_chat({"job_id": "job-err", "question": "Hello?"}, storage, settings_override=settings)
    assert code == 400


def test_chat_caps_history_at_4_turns_and_question_at_500_chars(tmp_path) -> None:
    storage = LocalStorage(tmp_path)
    storage.write_status("job-caps", "complete", "results/job-caps/study_pack.md")
    storage.save_chunks(
        "job-caps",
        [{"chunk_number": 1, "text": "Raft uses AppendEntries RPCs for log replication."}],
    )

    long_history = []
    for i in range(1, 8):  # 7 turns = 14 messages
        long_history.append({"role": "user", "content": f"User turn {i} about Raft?"})
        long_history.append({"role": "assistant", "content": f"Assistant reply {i} about Raft."})

    long_question = "Explain AppendEntries " + ("details " * 100)
    assert len(long_question) > MAX_QUESTION_CHARS

    captured_messages: list[dict[str, str]] = []

    def _fake_chat(messages, **kwargs):
        captured_messages.extend(messages)
        return {"content": "AppendEntries replicates log entries [Excerpt 1].", "model": "mock", "provider": "mock", "usage": {}}

    with patch("chat_service.chat_completion", side_effect=_fake_chat):
        code, _ = handle_chat(
            {"job_id": "job-caps", "question": long_question, "history": long_history},
            storage,
            settings_override=_mock_settings(),
        )

    assert code == 200
    # 1 system + at most 8 history messages (4 turns) + 1 current user message = <= 10 messages
    history_in_prompt = [m for m in captured_messages[1:-1]]
    assert len(history_in_prompt) <= MAX_HISTORY_TURNS * 2
    assert "User turn 1" not in json.dumps(history_in_prompt)
    assert "User turn 7" in json.dumps(history_in_prompt)

    final_user_msg = captured_messages[-1]["content"]
    sent_q = final_user_msg.split("Question: ", 1)[1]
    assert len(sent_q) <= MAX_QUESTION_CHARS
    assert estimate_tokens(captured_messages) < 3000


# ---------------------------------------------------------------------------
# 3. LLM Provider 429 Retry, Fallback, Throttle, and Key Safety
# ---------------------------------------------------------------------------
def _make_http_error(code: int, body_dict: dict, retry_after: str | None = None) -> urllib.error.HTTPError:
    hdrs = email.message.Message()
    if retry_after is not None:
        hdrs["Retry-After"] = retry_after
    return urllib.error.HTTPError(
        url="https://api.groq.com/openai/v1/chat/completions",
        code=code,
        msg="Error",
        hdrs=hdrs,
        fp=io.BytesIO(json.dumps(body_dict).encode("utf-8")),
    )


def test_groq_429_retries_honoring_retry_after_and_falls_back_on_daily_limit() -> None:
    secret_key = "gsk_DO_NOT_LEAK_THIS_KEY_999"
    settings = _mock_settings(provider="groq", groq_key=secret_key)
    sleeps: list[float] = []
    calls: list[str] = []

    def _fake_urlopen(req, timeout=90):
        body = json.loads(req.data.decode("utf-8"))
        model = body["model"]
        calls.append(model)
        if len(calls) == 1:
            raise _make_http_error(429, {"error": {"message": "Rate limit RPM"}}, retry_after="4.5")
        if len(calls) == 2:
            raise _make_http_error(429, {"error": {"message": "Tokens per day (TPD) limit reached"}})

        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(
            {"model": model, "choices": [{"message": {"content": "Fallback succeeded [Excerpt 1]"}}]}
        ).encode("utf-8")
        return mock_resp

    limiter = TokenRateLimiter(tpm_limit=12000, rpm_limit=30, sleep_fn=sleeps.append)
    with patch("llm_provider.urllib.request.urlopen", side_effect=_fake_urlopen):
        res = chat_completion(
            [{"role": "user", "content": "Test question"}],
            settings_override=settings,
            limiter=limiter,
            sleep_fn=sleeps.append,
            max_retries=3,
        )

    assert sleeps == [4.5]
    assert calls == ["llama-3.3-70b-versatile", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
    assert res["model"] == "llama-3.1-8b-instant"
    assert "Fallback succeeded" in res["content"]


def test_groq_both_models_fail_raises_safe_user_message_without_key() -> None:
    secret_key = "gsk_SECRET_SHOULD_NEVER_APPEAR_999"
    settings = _mock_settings(provider="groq", groq_key=secret_key)

    def _always_429(req, timeout=90):
        raise _make_http_error(429, {"error": {"message": f"Tokens per day limit reached ({secret_key})"}})

    with patch("llm_provider.urllib.request.urlopen", side_effect=_always_429):
        with pytest.raises(LLMServiceError) as exc_info:
            chat_completion(
                [{"role": "user", "content": "Test"}],
                settings_override=settings,
                limiter=TokenRateLimiter(sleep_fn=lambda _: None),
                sleep_fn=lambda _: None,
                max_retries=2,
            )

    assert exc_info.value.is_rate_limit is True
    assert secret_key not in str(exc_info.value)


def test_token_throttle_sleeps_when_tpm_budget_exceeded() -> None:
    now = [100.0]
    sleeps: list[float] = []

    def _clock() -> float:
        return now[0]

    def _sleep(sec: float) -> None:
        sleeps.append(sec)
        now[0] += sec

    limiter = TokenRateLimiter(tpm_limit=1000, rpm_limit=30, clock_fn=_clock, sleep_fn=_sleep)
    assert limiter.wait_if_needed(700) == 0.0
    waited = limiter.wait_if_needed(500)
    assert waited >= 60.0
    assert len(sleeps) == 1


def test_bedrock_provider_path_works_behind_same_interface() -> None:
    settings = _mock_settings(provider="bedrock")
    mock_client = MagicMock()
    mock_client.converse.return_value = {
        "output": {"message": {"content": [{"text": "Grounded Nova reply"}]}},
        "usage": {"inputTokens": 100, "outputTokens": 20},
    }
    with patch("boto3.client", return_value=mock_client):
        res = chat_completion(
            [{"role": "system", "content": "Be concise"}, {"role": "user", "content": "Hi"}],
            settings_override=settings,
        )
    assert res["provider"] == "bedrock"
    assert res["model"] == "amazon.nova-micro-v1:0"
    assert res["content"] == "Grounded Nova reply"


# ---------------------------------------------------------------------------
# 4. Flask & Lambda POST /chat Parity
# ---------------------------------------------------------------------------
def test_flask_and_lambda_chat_routes_use_shared_core(tmp_path, monkeypatch) -> None:
    storage = LocalStorage(tmp_path)
    settings = _mock_settings(provider="mock")
    process_lecture_text(
        job_id="job-route",
        filename="sample_lecture.txt",
        text=_sample_text(),
        storage=storage,
        settings_override=settings,
    )

    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))

    # Flask route check
    client = flask_app_module.app.test_client()
    flask_resp = client.post(
        "/chat",
        json={"job_id": "job-route", "question": "What are the three states of a Raft node?"},
    )
    assert flask_resp.status_code == 200
    f_data = flask_resp.get_json()
    assert "answer" in f_data and len(f_data["sources"]) >= 1

    # Lambda route check (mocking S3Storage to return the same LocalStorage)
    with patch("lambda_api.S3Storage", return_value=storage):
        lambda_resp = lambda_api.lambda_handler(
            {
                "routeKey": "POST /chat",
                "rawPath": "/prod/chat",
                "requestContext": {"http": {"method": "POST"}},
                "body": json.dumps(
                    {"job_id": "job-route", "question": "What are the three states of a Raft node?"}
                ),
            },
            {},
        )
    assert lambda_resp["statusCode"] == 200
    l_data = json.loads(lambda_resp["body"])
    assert l_data["answer"] == f_data["answer"]
    assert l_data["model"] == "mock-study-model"
