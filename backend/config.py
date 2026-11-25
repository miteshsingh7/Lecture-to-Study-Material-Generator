"""Runtime configuration loaded from environment variables and optional .env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv_file(env_path: Path | None = None) -> None:
    """Load key=value pairs from .env without overriding existing env vars."""
    target = env_path or (Path(__file__).resolve().parent / ".env")
    if not target.exists():
        return
    for raw_line in target.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv_file()


@dataclass(frozen=True)
class Settings:
    """Immutable configuration snapshot read from process environment."""

    llm_provider: str
    groq_api_key: str
    groq_model: str
    groq_fallback_model: str
    groq_endpoint: str
    groq_tpm_limit: int
    groq_rpm_limit: int
    bedrock_model_id: str
    aws_region: str
    bucket_name: str
    local_data_dir: str


def get_settings() -> Settings:
    """Read current environment variables into a typed Settings object."""
    return Settings(
        llm_provider=os.environ.get("LLM_PROVIDER", "groq").strip().lower() or "groq",
        groq_api_key=os.environ.get("GROQ_API_KEY", "").strip(),
        groq_model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
        or "llama-3.3-70b-versatile",
        groq_fallback_model=os.environ.get(
            "GROQ_FALLBACK_MODEL", "llama-3.1-8b-instant"
        ).strip()
        or "llama-3.1-8b-instant",
        groq_endpoint=os.environ.get(
            "GROQ_ENDPOINT", "https://api.groq.com/openai/v1/chat/completions"
        ).strip(),
        groq_tpm_limit=int(os.environ.get("GROQ_TPM_LIMIT", "12000")),
        groq_rpm_limit=int(os.environ.get("GROQ_RPM_LIMIT", "30")),
        bedrock_model_id=os.environ.get(
            "BEDROCK_MODEL_ID", "amazon.nova-micro-v1:0"
        ).strip(),
        aws_region=os.environ.get("AWS_REGION", "ap-southeast-2").strip(),
        bucket_name=os.environ.get(
            "BUCKET_NAME", "lecture-study-generator-790317642879"
        ).strip(),
        local_data_dir=os.environ.get("LOCAL_DATA_DIR", "local_data").strip(),
    )
