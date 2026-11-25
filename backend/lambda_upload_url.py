"""AWS Lambda handler for generating presigned S3 upload URLs (`POST /upload-url`)."""

import json
import os
import uuid

import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION", "ap-southeast-2"),
    endpoint_url=f"https://s3.{os.environ.get('AWS_REGION', 'ap-southeast-2')}.amazonaws.com",
    config=Config(signature_version="s3v4"),
)
BUCKET = os.environ["BUCKET_NAME"]


def lambda_handler(event: dict, context: object) -> dict:
    """Return a presigned S3 PUT URL and generated jobId for lecture uploads."""
    body = json.loads(event.get("body") or "{}")
    raw_filename = body.get("filename", "transcript.txt")
    filename = os.path.basename(str(raw_filename)).strip() or "transcript.txt"
    job_id = str(uuid.uuid4())
    key = f"uploads/{job_id}/{filename}"

    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=300,
    )

    return {
        "statusCode": 200,
        "headers": {"Access-Control-Allow-Origin": "*"},
        "body": json.dumps({"uploadUrl": url, "jobId": job_id, "key": key}),
    }
