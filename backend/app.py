"""Local Flask backend calling the shared pipeline, retrieval, and chat core."""

from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

from chat_service import handle_chat
from config import get_settings
from pipeline import extract_text_from_bytes, process_lecture_text
from storage import LocalStorage

app = Flask(__name__)
CORS(app)


def get_storage() -> LocalStorage:
    """Resolve LocalStorage rooted under LOCAL_DATA_DIR."""
    settings = get_settings()
    base = Path(settings.local_data_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent / base
    return LocalStorage(base)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "provider": get_settings().llm_provider}), 200


@app.post("/upload")
def upload_lecture():
    """Upload a .txt/.pdf locally, start background processing, and return job_id."""
    if "file" not in request.files:
        return jsonify({"error": "No file part provided"}), 400
    uploaded = request.files["file"]
    filename = os.path.basename(uploaded.filename or "").strip() or "lecture.txt"
    raw_bytes = uploaded.read()
    job_id = str(uuid.uuid4())

    storage = get_storage()
    storage.save_upload(job_id, filename, raw_bytes)
    storage.write_status(job_id, "processing", "Queued for processing...", filename=filename)

    def _run_job() -> None:
        try:
            text = extract_text_from_bytes(filename, raw_bytes)
            process_lecture_text(
                job_id=job_id,
                filename=filename,
                text=text,
                storage=storage,
            )
        except Exception as exc:
            storage.write_status(
                job_id,
                "error",
                f"Processing failed: {exc}",
                filename=filename,
            )

    threading.Thread(target=_run_job, daemon=True).start()
    return jsonify({"jobId": job_id, "filename": filename}), 202


@app.get("/status/<job_id>")
def get_status(job_id: str):
    status = get_storage().read_status(job_id)
    if not status:
        return jsonify({"status": "not_found"}), 404
    return jsonify(status), 200


@app.get("/library")
def list_library():
    items = get_storage().list_library()
    return jsonify({"items": items, "count": len(items)}), 200


@app.get("/library/<job_id>")
def get_library_item(job_id: str):
    pack = get_storage().read_study_pack(job_id)
    if not pack:
        return jsonify({"status": "not_found", "message": "Study pack not found"}), 404
    return jsonify(pack), 200


@app.post("/chat")
def chat_route():
    """Grounded chat endpoint delegating to shared `chat_service.handle_chat`."""
    payload = request.get_json(silent=True) or {}
    status_code, body = handle_chat(payload, get_storage())
    return jsonify(body), status_code


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
