"""Pure-Python chunking and Okapi BM25 keyword retrieval (no heavy dependencies)."""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

_STOPWORDS = frozenset(
    {
        "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
        "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
        "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
        "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
        "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
        "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more",
        "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once",
        "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same",
        "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
        "them", "themselves", "then", "there", "these", "they", "this", "those", "through",
        "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
        "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you",
        "your", "yours", "yourself", "yourselves",
    }
)

_FOLLOW_UP_PREFIXES = (
    "what about",
    "how about",
    "tell me more",
    "explain more",
    "why does",
    "why is",
    "and ",
    "what else",
)


def tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, tokenize alphanumerics, and remove stopwords."""
    raw_tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [tok for tok in raw_tokens if tok not in _STOPWORDS and len(tok) > 1]


def _split_long_paragraph(para: str, max_chars: int) -> list[str]:
    """Split an oversized paragraph on sentence boundaries (or words if still too long)."""
    sentences = re.split(r"(?<=[.!?])\s+", para.strip())
    units: list[str] = []
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= max_chars:
            units.append(sent)
            continue
        # Hard wrap exceptionally long sentences cleanly at word boundaries
        words = sent.split()
        buf: list[str] = []
        buf_len = 0
        for w in words:
            if buf and buf_len + 1 + len(w) > max_chars:
                units.append(" ".join(buf))
                buf = [w]
                buf_len = len(w)
            else:
                buf.append(w)
                buf_len += (1 if buf_len else 0) + len(w)
        if buf:
            units.append(" ".join(buf))
    return units


def _take_overlap_suffix(text: str, overlap_chars: int) -> str:
    """Take a clean sentence-or-word aligned suffix up to `overlap_chars`."""
    if overlap_chars <= 0 or len(text) <= overlap_chars:
        return text if overlap_chars > 0 else ""
    tail = text[-overlap_chars:]
    space_idx = tail.find(" ")
    if space_idx != -1 and space_idx + 1 < len(tail):
        return tail[space_idx + 1 :].strip()
    return tail.strip()


def build_retrieval_chunks(
    text: str,
    *,
    target_chars: int = 1200,
    max_chars: int = 1500,
    overlap_chars: int = 180,
) -> list[dict[str, Any]]:
    """Split extracted lecture text into small numbered chunks (~1000-1500 chars) with overlap."""
    cleaned = text.replace("\r\n", "\n").strip()
    if not cleaned:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", cleaned) if p.strip()]
    segments: list[str] = []
    for para in paragraphs:
        if len(para) <= max_chars:
            segments.append(para)
        else:
            segments.extend(_split_long_paragraph(para, max_chars))

    raw_chunks: list[str] = []
    current_parts: list[str] = []
    current_len = 0

    for seg in segments:
        sep_len = 2 if current_parts else 0
        if current_parts and current_len + sep_len + len(seg) > target_chars:
            if current_len + sep_len + len(seg) <= max_chars and current_len < 1000:
                current_parts.append(seg)
                current_len += sep_len + len(seg)
                continue

            finished = "\n\n".join(current_parts)
            raw_chunks.append(finished)
            overlap = _take_overlap_suffix(finished, overlap_chars)
            current_parts = [overlap, seg] if overlap and len(overlap) + 2 + len(seg) <= max_chars else [seg]
            current_len = len("\n\n".join(current_parts))
        else:
            current_parts.append(seg)
            current_len += sep_len + len(seg)

    if current_parts:
        last_chunk = "\n\n".join(current_parts).strip()
        if last_chunk:
            raw_chunks.append(last_chunk)

    return [
        {
            "chunk_number": idx,
            "text": chunk_text,
            "char_count": len(chunk_text),
        }
        for idx, chunk_text in enumerate(raw_chunks, start=1)
    ]


class BM25Retriever:
    """Pure-Python Okapi BM25 retriever over numbered lecture chunks."""

    def __init__(
        self,
        chunks: list[dict[str, Any]],
        *,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> None:
        self.chunks = chunks
        self.k1 = k1
        self.b = b
        self._doc_tokens: list[list[str]] = [tokenize(c.get("text", "")) for c in chunks]
        self._doc_freqs: list[Counter[str]] = [Counter(toks) for toks in self._doc_tokens]
        self._doc_count = len(chunks)
        total_len = sum(len(t) for t in self._doc_tokens)
        self._avg_dl = (total_len / self._doc_count) if self._doc_count else 1.0

        df: Counter[str] = Counter()
        for counts in self._doc_freqs:
            for term in counts:
                df[term] += 1
        self._idf: dict[str, float] = {
            term: math.log(((self._doc_count - freq + 0.5) / (freq + 0.5)) + 1.0)
            for term, freq in df.items()
        }

    def score_query(self, query: str) -> list[tuple[int, float]]:
        """Score every chunk against `query` using Okapi BM25."""
        q_tokens = tokenize(query)
        if not q_tokens or self._doc_count == 0:
            return [(idx, 0.0) for idx in range(self._doc_count)]

        scores: list[tuple[int, float]] = []
        for idx in range(self._doc_count):
            doc_len = len(self._doc_tokens[idx]) or 1
            tf_map = self._doc_freqs[idx]
            score = 0.0
            for term in q_tokens:
                tf = tf_map.get(term, 0)
                if tf == 0:
                    continue
                idf = self._idf.get(term, 0.0)
                denom = tf + self.k1 * (1.0 - self.b + self.b * (doc_len / self._avg_dl))
                score += idf * ((tf * (self.k1 + 1.0)) / denom)
            scores.append((idx, score))
        return scores

    def search(self, query: str, *, top_k: int = 4) -> list[dict[str, Any]]:
        """Return up to `top_k` chunks ordered by descending BM25 relevance."""
        scored = self.score_query(query)
        ranked = sorted(
            scored,
            key=lambda item: (-item[1], self.chunks[item[0]].get("chunk_number", item[0] + 1)),
        )[:top_k]
        return [
            {
                "chunk_number": self.chunks[idx]["chunk_number"],
                "text": self.chunks[idx]["text"],
                "score": round(score, 4),
            }
            for idx, score in ranked
        ]


def build_search_query(question: str, history: list[dict[str, str]] | None = None) -> str:
    """Expand short follow-up questions with the previous user question for retrieval."""
    q_clean = question.strip()
    if not history:
        return q_clean

    q_tokens = tokenize(q_clean)
    lower = q_clean.lower()
    is_short_followup = (
        len(q_tokens) <= 4
        or len(q_clean) <= 40
        or any(lower.startswith(prefix) for prefix in _FOLLOW_UP_PREFIXES)
    )
    if not is_short_followup:
        return q_clean

    prev_user_q = ""
    for turn in reversed(history):
        if isinstance(turn, dict) and turn.get("role") == "user" and turn.get("content"):
            prev_user_q = str(turn["content"]).strip()
            break

    return f"{prev_user_q} {q_clean}".strip() if prev_user_q else q_clean


def retrieve_top_chunks(
    chunks: list[dict[str, Any]],
    question: str,
    *,
    history: list[dict[str, str]] | None = None,
    top_k: int = 4,
) -> list[dict[str, Any]]:
    """Retrieve top `top_k` lecture chunks for a question and optional chat history."""
    if not chunks:
        return []
    expanded_query = build_search_query(question, history)
    retriever = BM25Retriever(chunks)
    return retriever.search(expanded_query, top_k=top_k)
