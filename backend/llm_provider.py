"""Unified LLM provider layer supporting Groq, Amazon Bedrock, and Mock modes."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Callable, Optional

from config import Settings, get_settings


class LLMServiceError(RuntimeError):
    """User-safe LLM failure with optional rate-limit indicator."""

    def __init__(self, message: str, *, is_rate_limit: bool = False) -> None:
        super().__init__(message)
        self.is_rate_limit = is_rate_limit


def estimate_tokens(messages: list[dict[str, str]], max_tokens: int = 0) -> int:
    """Approximate token budget from message character counts plus output cap."""
    chars = sum(len(str(m.get("content", ""))) + 16 for m in messages)
    return max(1, (chars // 4) + max_tokens)


class TokenRateLimiter:
    """Sliding 60-second TPM and RPM throttle for consecutive Groq pipeline calls."""

    def __init__(
        self,
        *,
        tpm_limit: int = 12000,
        rpm_limit: int = 30,
        clock_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.tpm_limit = max(500, tpm_limit)
        self.rpm_limit = max(1, rpm_limit)
        self._clock = clock_fn
        self._sleep = sleep_fn
        self._events: deque[tuple[float, int]] = deque()

    def _prune(self, now: float) -> None:
        cutoff = now - 60.0
        while self._events and self._events[0][0] <= cutoff:
            self._events.popleft()

    def wait_if_needed(self, estimated_tokens: int) -> float:
        """Sleep only when adding `estimated_tokens` would breach the 60s budget."""
        waited = 0.0
        while True:
            now = self._clock()
            self._prune(now)
            used_tokens = sum(tok for _, tok in self._events)
            used_requests = len(self._events)

            over_tpm = self._events and (used_tokens + estimated_tokens > self.tpm_limit)
            over_rpm = self._events and (used_requests >= self.rpm_limit)
            if not over_tpm and not over_rpm:
                self._events.append((now, estimated_tokens))
                return waited

            oldest_ts = self._events[0][0]
            sleep_for = max(0.05, (oldest_ts + 60.05) - now)
            self._sleep(sleep_for)
            waited += sleep_for


_DEFAULT_LIMITER = TokenRateLimiter()


def _is_daily_limit_error(error_body: str) -> bool:
    lower = error_body.lower()
    return (
        "tokens per day" in lower
        or "requests per day" in lower
        or "tpd" in lower
        or "rpd" in lower
        or "daily" in lower
    )


def _parse_retry_after(headers: Any, default_seconds: float) -> float:
    if not headers:
        return default_seconds
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if not raw:
        return default_seconds
    try:
        return max(0.1, min(float(raw), 120.0))
    except (TypeError, ValueError):
        return default_seconds


def _call_groq_model(
    *,
    api_key: str,
    endpoint: str,
    model_name: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    max_retries: int,
    limiter: Optional[TokenRateLimiter],
    sleep_fn: Callable[[float], None],
) -> dict[str, Any]:
    """Execute one Groq chat completion with retry/backoff on 429 and 5xx."""
    payload: dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if "gpt-oss" in model_name:
        payload["reasoning_effort"] = "low"

    encoded = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "SmartLectureStudyGenerator/1.0 (Python; Cloud)",
    }

    last_rate_limit = False
    for attempt in range(max_retries):
        if limiter is not None:
            limiter.wait_if_needed(estimate_tokens(messages, max_tokens))

        req = urllib.request.Request(endpoint, data=encoded, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                content = data["choices"][0]["message"]["content"]
                return {
                    "content": content,
                    "model": data.get("model", model_name),
                    "provider": "groq",
                    "usage": data.get("usage") or {},
                }
        except urllib.error.HTTPError as exc:
            code = exc.code
            body = exc.read().decode("utf-8", errors="ignore")

            if code == 404 and "model_not_found" in body:
                raise LookupError(f"Groq model '{model_name}' unavailable") from exc

            if code == 429:
                last_rate_limit = True
                if _is_daily_limit_error(body):
                    raise LLMServiceError(
                        "Daily rate limit reached on primary Groq model.",
                        is_rate_limit=True,
                    ) from exc

            if code in (413, 429) or code >= 500:
                if attempt < max_retries - 1:
                    backoff = min(60.0, 2.0 * (2**attempt))
                    wait_seconds = _parse_retry_after(exc.headers, backoff)
                    sleep_fn(wait_seconds)
                    continue
                if code in (413, 429):
                    raise LLMServiceError(
                        "Groq rate limit exceeded after retries. Please wait a moment and try again.",
                        is_rate_limit=True,
                    ) from exc
                raise LLMServiceError(
                    f"Groq service temporarily unavailable (HTTP {code})."
                ) from exc

            if code in (401, 403):
                raise LLMServiceError(
                    "Groq API authentication failed. Please check your GROQ_API_KEY configuration."
                ) from exc

            raise LLMServiceError(f"Groq request failed (HTTP {code}).") from exc
        except urllib.error.URLError as exc:
            if attempt < max_retries - 1:
                sleep_fn(min(15.0, 2.0 * (attempt + 1)))
                continue
            raise LLMServiceError(
                "Could not reach the Groq API service. Please try again shortly."
            ) from exc

    raise LLMServiceError(
        "Groq API rate limit exceeded." if last_rate_limit else "Groq request failed.",
        is_rate_limit=last_rate_limit,
    )


def _call_bedrock(
    *,
    settings: Settings,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """Call Amazon Bedrock Converse API behind the unified chat interface."""
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    system_prompts = [
        {"text": m["content"]} for m in messages if m.get("role") == "system" and m.get("content")
    ]
    converse_messages = [
        {"role": m["role"], "content": [{"text": m["content"]}]}
        for m in messages
        if m.get("role") in ("user", "assistant")
    ]
    if not converse_messages:
        converse_messages = [{"role": "user", "content": [{"text": "Hello"}]}]

    client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    kwargs: dict[str, Any] = {
        "modelId": settings.bedrock_model_id,
        "messages": converse_messages,
        "inferenceConfig": {"maxTokens": max_tokens, "temperature": temperature},
    }
    if system_prompts:
        kwargs["system"] = system_prompts

    try:
        response = client.converse(**kwargs)
        blocks = response["output"]["message"]["content"]
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        return {
            "content": text,
            "model": settings.bedrock_model_id,
            "provider": "bedrock",
            "usage": response.get("usage") or {},
        }
    except (BotoCoreError, ClientError, KeyError, IndexError, TypeError) as exc:
        raise LLMServiceError(f"Bedrock invocation failed: {type(exc).__name__}") from exc


def _call_mock(messages: list[dict[str, str]]) -> dict[str, Any]:
    """Deterministic local mock responses for unit tests and offline mode."""
    last_user = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user = str(msg.get("content", ""))
            break

    # Chat prompt format includes numbered excerpts: "[Excerpt N]"
    if "[Excerpt" in last_user or "EXCERPTS:" in last_user:
        from retrieval import tokenize

        excerpts_part, _, question_part = last_user.partition("\n\nQuestion:")
        excerpts = re.findall(r"\[Excerpt\s+(\d+)\]\s*\n([^\[]+)", excerpts_part)
        question = question_part.strip()
        q_tokens = set(tokenize(question))

        best_num = None
        best_snippet = ""
        best_overlap = 0
        for num, body in excerpts:
            body_tokens = set(tokenize(body))
            overlap = len(q_tokens & body_tokens)
            if overlap > best_overlap:
                best_overlap = overlap
                best_num = num
                best_snippet = " ".join(body.strip().split())[:180]

        if best_num and best_overlap >= 1:
            return {
                "content": f"Based on the lecture [Excerpt {best_num}]: {best_snippet}",
                "model": "mock-study-model",
                "provider": "mock",
                "usage": {},
            }
        return {
            "content": "The provided lecture does not cover this question.",
            "model": "mock-study-model",
            "provider": "mock",
            "usage": {},
        }

    # Study pack / chunk summary mock fallback
    if "Lecture Excerpt:" in last_user:
        return {
            "content": "Summary of core lecture excerpt concepts and definitions.",
            "model": "mock-study-model",
            "provider": "mock",
            "usage": {},
        }

    return {
        "content": (
            "# Summary\nMock study summary covering core lecture ideas.\n\n"
            "# Topic Notes\n### 1. Core Concepts\n- Key idea from lecture.\n\n"
            "# Key Definitions\n- **Mock Term**: Clear definition from the lecture.\n\n"
            "# Revision Questions\n1. **What is the core topic?**\n   *The core topic explained in the lecture.*"
        ),
        "model": "mock-study-model",
        "provider": "mock",
        "usage": {},
    }


def chat_completion(
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 500,
    temperature: float = 0.2,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    max_retries: int = 3,
    limiter: Optional[TokenRateLimiter] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    settings_override: Optional[Settings] = None,
) -> dict[str, Any]:
    """Send a chat completion to the active LLM provider (groq | bedrock | mock).

    Automatically handles throttling, 429 retry-after backoff, and fallback to
    GROQ_FALLBACK_MODEL when daily limits or unavailable models are hit.
    """
    settings = settings_override or get_settings()
    active_provider = (provider or settings.llm_provider).strip().lower()

    if active_provider == "mock":
        return _call_mock(messages)

    if active_provider == "bedrock":
        return _call_bedrock(
            settings=settings,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    if active_provider != "groq":
        raise LLMServiceError(f"Unsupported LLM_PROVIDER: {active_provider}")

    if not settings.groq_api_key:
        raise LLMServiceError("GROQ_API_KEY is not configured.")

    primary_model = model or settings.groq_model
    candidate_models = [primary_model]
    if settings.groq_fallback_model and settings.groq_fallback_model not in candidate_models:
        candidate_models.append(settings.groq_fallback_model)

    active_limiter = limiter if limiter is not None else _DEFAULT_LIMITER
    last_error: Optional[LLMServiceError] = None

    for idx, candidate in enumerate(candidate_models):
        try:
            return _call_groq_model(
                api_key=settings.groq_api_key,
                endpoint=settings.groq_endpoint,
                model_name=candidate,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                max_retries=max_retries,
                limiter=active_limiter,
                sleep_fn=sleep_fn,
            )
        except LookupError as exc:
            last_error = LLMServiceError(str(exc))
            if idx < len(candidate_models) - 1:
                continue
            raise last_error from exc
        except LLMServiceError as exc:
            last_error = exc
            if idx < len(candidate_models) - 1 and (exc.is_rate_limit or "unavailable" in str(exc).lower()):
                continue
            raise

    raise last_error or LLMServiceError("All Groq models failed.")
