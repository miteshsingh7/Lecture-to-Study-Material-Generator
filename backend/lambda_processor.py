"""AWS Lambda S3-event processor entrypoint calling shared `pipeline.py`."""

from __future__ import annotations

import os
import urllib.parse

from config import get_settings
from pipeline import extract_text_from_bytes, process_lecture_text
from storage import S3Storage


def lambda_handler(event: dict, context: object) -> None:
    """Process an uploaded lecture from S3, build retrieval chunks, and write study pack."""
    settings = get_settings()
    storage = S3Storage(settings.bucket_name, settings.aws_region)

    record = event["Records"][0]
    raw_key = record["s3"]["object"]["key"]
    key = urllib.parse.unquote_plus(raw_key)
    key_parts = key.split("/", 2)
    job_id = key_parts[1]
    filename = os.path.basename(key_parts[2]) if len(key_parts) > 2 else os.path.basename(key)

    storage.write_status(job_id, "processing", "Extracting text from transcript...", filename=filename)

    try:
        obj = storage.s3.get_object(Bucket=settings.bucket_name, Key=key)
        raw_bytes = obj["Body"].read()
        text = extract_text_from_bytes(filename, raw_bytes)
        process_lecture_text(
            job_id=job_id,
            filename=filename,
            text=text,
            storage=storage,
            settings_override=settings,
        )
    except Exception as exc:
        error_msg = f"Processing failed: {exc}"
        print(error_msg)
        storage.write_status(job_id, "error", error_msg, filename=filename)
