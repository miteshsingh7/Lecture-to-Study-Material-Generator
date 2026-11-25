"""Lecture processing pipeline: extracts text, builds retrieval index, generates study pack."""

from __future__ import annotations

import re
from io import BytesIO
from typing import Callable, Optional

from config import Settings, get_settings
from llm_provider import TokenRateLimiter, chat_completion
from retrieval import build_retrieval_chunks
from storage import StorageBackend

_SYSTEM_STUDY_PROMPT = (
    "You are an expert academic study assistant. Always provide structured, "
    "high-yield study material and completely finish all requested sections."
)


def extract_text_from_bytes(filename: str, raw_bytes: bytes) -> str:
    """Extract plain text from .txt or .pdf lecture payloads."""
    if filename.lower().endswith(".pdf"):
        import pypdf

        reader = pypdf.PdfReader(BytesIO(raw_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    return raw_bytes.decode("utf-8", errors="ignore")


def chunk_text_by_words(text: str, max_words: int = 1200) -> list[str]:
    """Split lecture text into larger synthesis chunks (~1200 words) for study pack creation."""
    paragraphs = re.split(r"\n\n+", text)
    chunks: list[str] = []
    current_paragraphs: list[str] = []
    current_word_count = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        words = para.split()
        para_word_count = len(words)

        if para_word_count > max_words:
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sentence in sentences:
                sent_words = len(sentence.split())
                if current_word_count + sent_words > max_words and current_paragraphs:
                    chunks.append("\n\n".join(current_paragraphs))
                    current_paragraphs = [sentence]
                    current_word_count = sent_words
                else:
                    current_paragraphs.append(sentence)
                    current_word_count += sent_words
        else:
            if current_word_count + para_word_count > max_words and current_paragraphs:
                chunks.append("\n\n".join(current_paragraphs))
                current_paragraphs = [para]
                current_word_count = para_word_count
            else:
                current_paragraphs.append(para)
                current_word_count += para_word_count

    if current_paragraphs:
        chunks.append("\n\n".join(current_paragraphs))

    return chunks if chunks else [text]


def process_lecture_text(
    *,
    job_id: str,
    filename: str,
    text: str,
    storage: StorageBackend,
    settings_override: Optional[Settings] = None,
    limiter: Optional[TokenRateLimiter] = None,
    sleep_fn: Optional[Callable[[float], None]] = None,
) -> str:
    """Generate a study pack via the unified LLM provider and build retrieval chunks."""
    settings = settings_override or get_settings()
    rate_limiter = limiter or TokenRateLimiter(
        tpm_limit=settings.groq_tpm_limit,
        rpm_limit=settings.groq_rpm_limit,
        **(
            {"sleep_fn": sleep_fn}
            if sleep_fn is not None
            else {}
        ),
    )

    if not text.strip():
        storage.write_status(
            job_id,
            "error",
            "No readable text could be extracted from the file.",
            filename=filename,
        )
        raise ValueError("No readable text could be extracted from the file.")

    # Build and persist small retrieval chunks (~1000-1500 chars) for "Chat with this lecture"
    retrieval_chunks = build_retrieval_chunks(text)
    storage.save_chunks(job_id, retrieval_chunks)

    synthesis_chunks = chunk_text_by_words(text, max_words=1200)
    total_chunks = len(synthesis_chunks)
    call_kwargs = {"limiter": rate_limiter, "max_retries": 5, "settings_override": settings}
    if sleep_fn is not None:
        call_kwargs["sleep_fn"] = sleep_fn

    if total_chunks == 1:
        storage.write_status(
            job_id,
            "processing",
            f"Generating comprehensive study pack with {settings.llm_provider.upper()}...",
            filename=filename,
        )
        prompt = f"""You are an expert academic study assistant. Based on this lecture transcript:

{synthesis_chunks[0]}

Produce a complete study pack in Markdown format with exactly these four sections:

# Summary
(A concise 4-5 sentence summary covering the core concepts and thesis of the lecture.)

# Topic Notes
(Concise, well-organized bullet points categorized under topic headings covering all core concepts.)

# Key Definitions
(6-8 key terms and concepts in 'Term: Definition' format with clear explanations.)

# Revision Questions
(Exactly 15 concise questions with clear, direct answers, numbered 1 to 15. Keep questions and answers concise to ensure all 15 are completed.)
"""
        res = chat_completion(
            [
                {"role": "system", "content": _SYSTEM_STUDY_PROMPT},
                {"role": "user", "content": prompt},
            ],
            max_tokens=2200,
            temperature=0.3,
            **call_kwargs,
        )
        study_pack = res["content"]
    else:
        chunk_summaries: list[str] = []
        for idx, chunk in enumerate(synthesis_chunks):
            storage.write_status(
                job_id,
                "processing",
                f"Summarizing chunk {idx + 1}/{total_chunks}...",
                filename=filename,
            )
            chunk_prompt = (
                f"Summarize the key concepts, main topics, and essential definitions from this "
                f"lecture excerpt (part {idx + 1} of {total_chunks}) concisely in about 150-200 words.\n\n"
                f"Lecture Excerpt:\n{chunk}"
            )
            part_res = chat_completion(
                [
                    {"role": "system", "content": _SYSTEM_STUDY_PROMPT},
                    {"role": "user", "content": chunk_prompt},
                ],
                max_tokens=1200,
                temperature=0.3,
                **call_kwargs,
            )
            chunk_summaries.append(f"### Part {idx + 1} Summary:\n{part_res['content'].strip()}")

        storage.write_status(
            job_id,
            "processing",
            "Synthesizing full study pack from combined summaries...",
            filename=filename,
        )
        combined = "\n\n".join(chunk_summaries)
        final_prompt = f"""You are an expert academic study assistant. Based on these compiled summaries covering the entire lecture:

{combined}

Produce a complete, comprehensive study pack in Markdown format with exactly these four sections:

# Summary
(A cohesive 4-5 sentence summary covering the core concepts and thesis of the entire lecture.)

# Topic Notes
(Concise, well-organized bullet points categorized under 3-4 topic headings covering major concepts.)

# Key Definitions
(6-8 essential terms across the lecture in 'Term: Definition' format.)

# Revision Questions
(Exactly 15 concise revision questions with clear, direct answers, numbered 1 to 15. Keep each question and answer concise to ensure all 15 are completely written.)
"""
        final_res = chat_completion(
            [
                {"role": "system", "content": _SYSTEM_STUDY_PROMPT},
                {"role": "user", "content": final_prompt},
            ],
            max_tokens=2200,
            temperature=0.3,
            **call_kwargs,
        )
        study_pack = final_res["content"]

    result_key = storage.save_study_pack(job_id, study_pack, filename=filename)
    storage.write_status(job_id, "complete", result_key, filename=filename)
    return result_key
