"""AWS Lambda HTTP API router handling /status, /library, and POST /chat."""

from __future__ import annotations

import json

from chat_service import handle_chat
from config import get_settings
from storage import S3Storage

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
}


def _json_response(status_code: int, payload: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(payload),
    }


def lambda_handler(event: dict, context: object) -> dict:
    """Route API Gateway HTTP API requests to shared status, library, and chat services."""
    settings = get_settings()
    storage = S3Storage(settings.bucket_name, settings.aws_region)

    route_key = event.get("routeKey") or ""
    raw_path = event.get("rawPath") or ""
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or ("POST" if route_key.startswith("POST") else "GET")
    ).upper()
    path_params = event.get("pathParameters") or {}

    if method == "OPTIONS":
        return _json_response(200, {"ok": True})

    if route_key == "POST /chat" or (method == "POST" and raw_path.rstrip("/").endswith("/chat")):
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return _json_response(400, {"error": "Invalid JSON request body."})
        status_code, resp_body = handle_chat(body, storage, settings_override=settings)
        return _json_response(status_code, resp_body)

    if route_key == "GET /library" or raw_path.rstrip("/").endswith("/library"):
        if "jobId" in path_params:
            pack = storage.read_study_pack(path_params["jobId"])
            if not pack:
                return _json_response(404, {"status": "not_found", "message": "Study pack not found"})
            return _json_response(200, pack)
        items = storage.list_library()
        return _json_response(200, {"items": items, "count": len(items)})

    if route_key == "GET /library/{jobId}" or "/library/" in raw_path:
        job_id = path_params.get("jobId") or raw_path.rstrip("/").split("/")[-1]
        if not job_id:
            return _json_response(400, {"status": "error", "message": "Missing jobId"})
        pack = storage.read_study_pack(job_id)
        if not pack:
            return _json_response(404, {"status": "not_found", "message": "Study pack not found"})
        return _json_response(200, pack)

    job_id = path_params.get("jobId")
    if not job_id:
        return _json_response(400, {"status": "error", "message": "Missing jobId"})

    status_doc = storage.read_status(job_id)
    if not status_doc:
        return _json_response(404, {"status": "not_found"})
    return _json_response(200, status_doc)
