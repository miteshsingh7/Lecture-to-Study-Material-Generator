"""Stateless BM25-grounded 'Chat with this lecture' core service."""

from __future__ import annotations

from typing import Any, Optional

from config import Settings, get_settings
from llm_provider import LLMServiceError, TokenRateLimiter, chat_completion, estimate_tokens
from retrieval import retrieve_top_chunks
from storage import StorageBackend

MAX_QUESTION_CHARS = 500
MAX_HISTORY_TURNS = 4
MAX_INPUT_TOKENS_BUDGET = 2600
MAX_CHAT_OUTPUT_TOKENS = 500

_CHAT_SYSTEM_PROMPT = (
    "You are a strict lecture Q&A assistant. Answer ONLY from the numbered lecture excerpts below. "
    "If the answer is not explicitly present in the provided excerpts, say that the lecture does not cover it. "
    "Be concise, never invent outside facts, and cite excerpt numbers inline (for example, [Excerpt 2])."
)


def _normalize_history(raw_history: Any) -> list[dict[str, str]]:
    """Keep up to the last `MAX_HISTORY_TURNS` turns (user+assistant pairs = 8 msgs)."""
    if not isinstance(raw_history, list):
        return []
    cleaned: list[dict[str, str]] = []
    for item in raw_history:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        content = str(item.get("content", "")).strip()
        if role in ("user", "assistant") and content:
            cleaned.append({"role": role, "content": content[:600]})
    return cleaned[-(MAX_HISTORY_TURNS * 2) :]


def _make_snippet(text: str, max_chars: int = 220) -> str:
    compact = " ".join(text.split())
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 3].rstrip() + "..."


def _build_messages(
    *,
    excerpts_block: str,
    question: str,
    history: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Build chat messages while keeping total request tokens strictly under 3,000."""
    user_turn = f"EXCERPTS:\n{excerpts_block}\n\nQuestion: {question}"
    trimmed_history = list(history)

    while True:
        messages = [{"role": "system", "content": _CHAT_SYSTEM_PROMPT}]
        messages.extend(trimmed_history)
        messages.append({"role": "user", "content": user_turn})

        if estimate_tokens(messages, max_tokens=0) <= MAX_INPUT_TOKENS_BUDGET or not trimmed_history:
            return messages
        # Drop oldest pair/message first until safely within token budget
        trimmed_history = trimmed_history[1:]


def handle_chat(
    payload: dict[str, Any],
    storage: StorageBackend,
    *,
    settings_override: Optional[Settings] = None,
    limiter: Optional[TokenRateLimiter] = None,
) -> tuple[int, dict[str, Any]]:
    """Validate job, run BM25 retrieval over indexed chunks, and answer via LLM provider."""
    job_id = str(payload.get("job_id") or "").strip()
    raw_question = str(payload.get("question") or "").strip()

    if not job_id:
        return 400, {"error": "job_id is required."}
    if not raw_question:
        return 400, {"error": "Please enter a question about the lecture."}

    question = raw_question[:MAX_QUESTION_CHARS]
    history = _normalize_history(payload.get("history"))

    status_doc = storage.read_status(job_id)
    if not status_doc:
        return 404, {
            "error": "Lecture job not found. Please upload and process a lecture first."
        }

    job_status = status_doc.get("status")
    if job_status == "processing":
        return 409, {
            "error": "This lecture is still processing. Chat will unlock once processing completes."
        }
    if job_status == "error":
        return 400, {
            "error": "Processing failed for this lecture, so chat is unavailable."
        }
    if job_status != "complete":
        return 400, {"error": "This lecture is not ready for chat yet."}

    chunks = storage.read_chunks(job_id)
    if not chunks:
        return 404, {
            "error": "No retrieval index found for this lecture. Please re-process it to enable chat."
        }

    top_chunks = retrieve_top_chunks(chunks, question, history=history, top_k=4)
    excerpts_block = "\n\n".join(
        f"[Excerpt {c['chunk_number']}]\n{c['text']}" for c in top_chunks
    )

    messages = _build_messages(
        excerpts_block=excerpts_block,
        question=question,
        history=history,
    )

    try:
        llm_res = chat_completion(
            messages,
            max_tokens=MAX_CHAT_OUTPUT_TOKENS,
            temperature=0.1,
            max_retries=3,
            limiter=limiter,
            settings_override=settings_override,
        )
    except LLMServiceError as exc:
        status_code = 429 if exc.is_rate_limit else 502
        return status_code, {"error": str(exc)}

    answer = llm_res["content"].strip()
    lower_ans = answer.lower()
    not_covered = "does not cover" in lower_ans or "not covered" in lower_ans
    matched_chunks = [c for c in top_chunks if c.get("score", 0) > 0]
    sources_pool = [] if (not_covered and not matched_chunks) else (matched_chunks or top_chunks)

    sources = [
        {
            "chunk_number": int(c["chunk_number"]),
            "snippet": _make_snippet(c["text"]),
            "score": c["score"],
        }
        for c in sources_pool
    ]

    return 200, {
        "answer": answer,
        "sources": sources,
        "model": llm_res["model"],
        "provider": llm_res["provider"],
    }
