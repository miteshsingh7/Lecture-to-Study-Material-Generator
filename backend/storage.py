"""Storage backends (S3 for AWS Lambda, local filesystem for Flask dev/tests)."""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def safe_download_filename(display_name: str | None) -> str:
    """Build an ASCII-safe Content-Disposition markdown filename."""
    if not display_name:
        return "lecture_study_pack.md"
    base = os.path.splitext(os.path.basename(display_name))[0]
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("_.-")
    return f"{cleaned or 'lecture'}_study_pack.md"


def extract_summary_snippet(markdown_head: str) -> str:
    """Extract a concise plain-text snippet from the top of study_pack.md."""
    lines: list[str] = []
    for raw in markdown_head.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line == "---":
            continue
        plain = re.sub(r"[*`_>#]+", "", line).strip()
        if plain:
            lines.append(plain)
        if len(" ".join(lines)) >= 180:
            break
    snippet = " ".join(lines)
    if len(snippet) > 190:
        snippet = snippet[:187].rstrip() + "..."
    return snippet


class StorageBackend(ABC):
    """Unified storage interface for lecture status, study packs, and retrieval chunks."""

    @abstractmethod
    def read_status(self, job_id: str) -> Optional[dict[str, Any]]: ...

    @abstractmethod
    def write_status(
        self,
        job_id: str,
        status: str,
        message: str = "",
        filename: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    def save_study_pack(
        self,
        job_id: str,
        markdown: str,
        filename: Optional[str] = None,
    ) -> str: ...

    @abstractmethod
    def save_chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None: ...

    @abstractmethod
    def read_chunks(self, job_id: str) -> Optional[list[dict[str, Any]]]: ...

    @abstractmethod
    def read_study_pack(self, job_id: str) -> Optional[dict[str, Any]]: ...

    @abstractmethod
    def list_library(self) -> list[dict[str, Any]]: ...


class LocalStorage(StorageBackend):
    """Filesystem storage under `base_dir` for local Flask execution and unit tests."""

    def __init__(self, base_dir: str | Path = "local_data") -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _status_path(self, job_id: str) -> Path:
        return self.base_dir / "status" / f"{job_id}.json"

    def _result_dir(self, job_id: str) -> Path:
        return self.base_dir / "results" / job_id

    def save_upload(self, job_id: str, filename: str, content: bytes) -> Path:
        safe_name = os.path.basename(filename).strip() or "lecture.txt"
        dest = self.base_dir / "uploads" / job_id / safe_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return dest

    def read_status(self, job_id: str) -> Optional[dict[str, Any]]:
        path = self._status_path(job_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def write_status(
        self,
        job_id: str,
        status: str,
        message: str = "",
        filename: Optional[str] = None,
    ) -> None:
        path = self._status_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {"status": status, "message": message}
        if filename:
            payload["filename"] = filename
        path.write_text(json.dumps(payload), encoding="utf-8")

    def save_study_pack(
        self,
        job_id: str,
        markdown: str,
        filename: Optional[str] = None,
    ) -> str:
        res_dir = self._result_dir(job_id)
        res_dir.mkdir(parents=True, exist_ok=True)
        md_path = res_dir / "study_pack.md"
        md_path.write_text(markdown, encoding="utf-8")

        json_payload: dict[str, Any] = {"content": markdown}
        if filename:
            json_payload["filename"] = filename
        (res_dir / "study_pack.json").write_text(
            json.dumps(json_payload), encoding="utf-8"
        )
        return f"results/{job_id}/study_pack.md"

    def save_chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None:
        res_dir = self._result_dir(job_id)
        res_dir.mkdir(parents=True, exist_ok=True)
        (res_dir / "chunks.json").write_text(
            json.dumps({"job_id": job_id, "chunks": chunks}),
            encoding="utf-8",
        )

    def read_chunks(self, job_id: str) -> Optional[list[dict[str, Any]]]:
        chunks_path = self._result_dir(job_id) / "chunks.json"
        if not chunks_path.exists():
            return None
        data = json.loads(chunks_path.read_text(encoding="utf-8"))
        return data.get("chunks", []) if isinstance(data, dict) else data

    def read_study_pack(self, job_id: str) -> Optional[dict[str, Any]]:
        md_path = self._result_dir(job_id) / "study_pack.md"
        if not md_path.exists():
            return None
        content = md_path.read_text(encoding="utf-8")
        status = self.read_status(job_id) or {}
        filename = status.get("filename") or f"Lecture {job_id[:8]}"
        stat = md_path.stat()
        modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        return {
            "jobId": job_id,
            "filename": filename,
            "title": os.path.splitext(filename)[0],
            "lastModified": modified,
            "sizeBytes": stat.st_size,
            "content": content,
            "downloadUrl": "",
        }

    def list_library(self) -> list[dict[str, Any]]:
        results_root = self.base_dir / "results"
        if not results_root.exists():
            return []
        items: list[dict[str, Any]] = []
        for md_path in results_root.glob("*/study_pack.md"):
            job_id = md_path.parent.name
            pack = self.read_study_pack(job_id)
            if not pack:
                continue
            items.append(
                {
                    "jobId": job_id,
                    "filename": pack["filename"],
                    "title": pack["title"],
                    "summarySnippet": extract_summary_snippet(pack["content"][:1200]),
                    "lastModified": pack["lastModified"],
                    "sizeBytes": pack["sizeBytes"],
                    "downloadUrl": "",
                }
            )
        items.sort(key=lambda item: item["lastModified"], reverse=True)
        return items


class S3Storage(StorageBackend):
    """Amazon S3 storage backend used by AWS Lambda handlers."""

    def __init__(self, bucket_name: str, region_name: str = "ap-southeast-2") -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket_name
        self.s3 = boto3.client(
            "s3",
            region_name=region_name,
            endpoint_url=f"https://s3.{region_name}.amazonaws.com",
            config=Config(signature_version="s3v4"),
        )

    def presign_study_pack(
        self,
        result_key: str,
        display_name: str | None = None,
    ) -> str:
        dl_name = safe_download_filename(display_name)
        return self.s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": result_key,
                "ResponseContentDisposition": f'attachment; filename="{dl_name}"',
                "ResponseContentType": "text/markdown; charset=utf-8",
            },
            ExpiresIn=3600,
        )

    def _find_job_filename(self, job_id: str) -> Optional[str]:
        from botocore.exceptions import ClientError

        resp = self.s3.list_objects_v2(
            Bucket=self.bucket, Prefix=f"uploads/{job_id}/", MaxKeys=5
        )
        for obj in resp.get("Contents", []):
            key = obj.get("Key", "")
            parts = key.split("/", 2)
            if len(parts) == 3 and parts[2]:
                return parts[2]
        try:
            st = self.read_status(job_id)
            if st and st.get("filename"):
                return str(st["filename"])
        except ClientError:
            pass
        return None

    def read_status(self, job_id: str) -> Optional[dict[str, Any]]:
        from botocore.exceptions import ClientError

        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=f"status/{job_id}.json")
            status = json.loads(obj["Body"].read())
            if status.get("status") == "complete":
                result_key = status.get("message")
                filename = status.get("filename") or self._find_job_filename(job_id)
                if filename:
                    status["filename"] = filename
                if result_key:
                    status["downloadUrl"] = self.presign_study_pack(result_key, filename)
            return status
        except ClientError:
            return None

    def write_status(
        self,
        job_id: str,
        status: str,
        message: str = "",
        filename: Optional[str] = None,
    ) -> None:
        payload: dict[str, Any] = {"status": status, "message": message}
        if filename:
            payload["filename"] = filename
        self.s3.put_object(
            Bucket=self.bucket,
            Key=f"status/{job_id}.json",
            Body=json.dumps(payload),
            ContentType="application/json; charset=utf-8",
        )

    def save_study_pack(
        self,
        job_id: str,
        markdown: str,
        filename: Optional[str] = None,
    ) -> str:
        result_key = f"results/{job_id}/study_pack.md"
        self.s3.put_object(
            Bucket=self.bucket,
            Key=result_key,
            Body=markdown.encode("utf-8"),
            ContentType="text/markdown; charset=utf-8",
        )
        json_payload: dict[str, Any] = {"content": markdown}
        if filename:
            json_payload["filename"] = filename
        self.s3.put_object(
            Bucket=self.bucket,
            Key=f"results/{job_id}/study_pack.json",
            Body=json.dumps(json_payload),
            ContentType="application/json; charset=utf-8",
        )
        return result_key

    def save_chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None:
        self.s3.put_object(
            Bucket=self.bucket,
            Key=f"results/{job_id}/chunks.json",
            Body=json.dumps({"job_id": job_id, "chunks": chunks}),
            ContentType="application/json; charset=utf-8",
        )

    def read_chunks(self, job_id: str) -> Optional[list[dict[str, Any]]]:
        from botocore.exceptions import ClientError

        try:
            obj = self.s3.get_object(
                Bucket=self.bucket, Key=f"results/{job_id}/chunks.json"
            )
            data = json.loads(obj["Body"].read())
            return data.get("chunks", []) if isinstance(data, dict) else data
        except ClientError:
            return None

    def read_study_pack(self, job_id: str) -> Optional[dict[str, Any]]:
        from botocore.exceptions import ClientError

        result_key = f"results/{job_id}/study_pack.md"
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=result_key)
        except ClientError:
            return None

        content = obj["Body"].read().decode("utf-8", errors="ignore")
        filename = self._find_job_filename(job_id) or f"Lecture {job_id[:8]}"
        return {
            "jobId": job_id,
            "filename": filename,
            "title": os.path.splitext(filename)[0],
            "lastModified": obj["LastModified"].isoformat(),
            "sizeBytes": int(obj.get("ContentLength", len(content.encode("utf-8")))),
            "content": content,
            "downloadUrl": self.presign_study_pack(result_key, filename),
        }

    def _list_upload_filenames(self) -> dict[str, str]:
        mapping: dict[str, str] = {}
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix="uploads/"):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                parts = key.split("/", 2)
                if len(parts) == 3 and parts[1] and parts[2]:
                    mapping[parts[1]] = parts[2]
        return mapping

    def list_library(self) -> list[dict[str, Any]]:
        from botocore.exceptions import ClientError

        paginator = self.s3.get_paginator("list_objects_v2")
        entries: list[dict[str, Any]] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix="results/"):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                if not key.endswith("/study_pack.md"):
                    continue
                parts = key.split("/")
                if len(parts) != 3 or not parts[1]:
                    continue
                entries.append(
                    {
                        "jobId": parts[1],
                        "key": key,
                        "lastModified": obj["LastModified"].isoformat(),
                        "sizeBytes": int(obj.get("Size", 0)),
                    }
                )

        entries.sort(key=lambda item: item["lastModified"], reverse=True)
        recent = entries[:40]
        if not recent:
            return []

        upload_names = self._list_upload_filenames()

        def _enrich(entry: dict[str, Any]) -> dict[str, Any]:
            job_id = entry["jobId"]
            key = entry["key"]
            filename = upload_names.get(job_id) or f"Lecture {job_id[:8]}"
            snippet = ""
            try:
                head_obj = self.s3.get_object(
                    Bucket=self.bucket, Key=key, Range="bytes=0-1200"
                )
                head_text = head_obj["Body"].read().decode("utf-8", errors="ignore")
                snippet = extract_summary_snippet(head_text)
            except ClientError:
                snippet = ""
            return {
                "jobId": job_id,
                "filename": filename,
                "title": os.path.splitext(filename)[0],
                "summarySnippet": snippet,
                "lastModified": entry["lastModified"],
                "sizeBytes": entry["sizeBytes"],
                "downloadUrl": self.presign_study_pack(key, upload_names.get(job_id)),
            }

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            return list(pool.map(_enrich, recent))
