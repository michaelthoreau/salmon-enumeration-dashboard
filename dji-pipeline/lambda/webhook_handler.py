#Imports
import json
import os
import re
import urllib.request
import urllib.parse
import boto3
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ["BUCKET_NAME"]
FRONTEND_API_URL = os.environ["FRONTEND_API_URL"]
FRONTEND_API_KEY = os.environ["FRONTEND_API_KEY"]
FRONTEND_PROJECT_ID = os.environ.get("FRONTEND_PROJECT_ID", "")

CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tiff": "image/tiff", ".tif": "image/tiff",
    ".dng": "application/octet-stream",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
}

s3 = boto3.client("s3")

_project_id_cache = ""

#Frontend API Helpers
def _frontend_get(path: str, params: dict = None):
    url = f"{FRONTEND_API_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {FRONTEND_API_KEY}",
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _frontend_post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{FRONTEND_API_URL}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {FRONTEND_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _get_project_id() -> str:
    global _project_id_cache
    if _project_id_cache:
        return _project_id_cache
    if FRONTEND_PROJECT_ID:
        _project_id_cache = FRONTEND_PROJECT_ID
        return _project_id_cache
    projects = _frontend_get("/api/v1/projects")
    if projects:
        _project_id_cache = projects[0]["id"]
        print(f"Auto-selected project: {_project_id_cache} ({projects[0].get('name')})")
    return _project_id_cache


def _slugify(name: str) -> str:
    """Match the frontend's slugify(): trim, lowercase, spaces→hyphens, strip non-alphanumeric."""
    name = name.strip().lower()
    name = re.sub(r"\s+", "-", name)
    name = re.sub(r"[^a-z0-9-]", "", name)
    return name


def _find_or_create_flight_plan(plan_name: str) -> str:
    project_id = _get_project_id()
    flight_plans = _frontend_get("/api/v1/flight-plans", {"projectId": project_id})

    slug = _slugify(plan_name)
    for fp in (flight_plans or []):
        if fp.get("name", "") == slug:
            print(f"Matched flight plan: {fp['id']} ({fp['name']})")
            return fp["id"]

    result = _frontend_post("/api/v1/flight-plans", {
        "projectId": project_id,
        "name": plan_name,
    })
    print(f"Created flight plan: {result['id']} ({result.get('name')})")
    return result["id"]


def _find_or_create_flight(flight_plan_id: str, timestamp: str, folder_name: str) -> str:
    """Find an existing flight by folder_name stored in notes, or create a new one.
    Using notes as a stable key prevents duplicate flights when multiple files
    from the same mission trigger separate Lambda invocations.
    """
    flights = _frontend_get("/api/v1/flights", {"flightPlanId": flight_plan_id})
    for f in (flights or []):
        if f.get("notes") == folder_name:
            print(f"Matched flight: {f['id']} ({f.get('timestamp')})")
            return f["id"]

    result = _frontend_post("/api/v1/flights", {
        "flightPlanId": flight_plan_id,
        "timestamp": timestamp,
        "notes": folder_name,
    })
    print(f"Created flight: {result['id']} at {result.get('timestamp')}")
    return result["id"]

#Functions for extracting plan name and timestamp
#WORKS FOR CHINOOK-1 NOT DRONE IN THE BOX YET
def _is_chinook_path(fh2_file_path: str) -> bool:
    """Chinook-1 paths are folder-style: 'DroneID/DJI_YYYYMMDDHHMM_NNN_RouteName'"""
    return "/" in fh2_file_path


def _parse_plan_name(fh2_file_path: str) -> str:
    if _is_chinook_path(fh2_file_path):
        # Right side: 'DJI_202606081426_001_TrainingArea-LinearRouteForTesting'
        right = fh2_file_path.split("/", 1)[1]
        parts = right.split("_")
        # Route name is everything after the first 3 underscore-delimited segments
        if len(parts) >= 4:
            return "_".join(parts[3:])
        return ""
    # Drone in the Box: 'MyPlan 2026-06-02 09:28:41 (UTC-08)' → 'MyPlan'
    match = re.match(r'^(.+?)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}', fh2_file_path)
    if match:
        return match.group(1).strip()
    return ""


def _parse_timestamp(fh2_file_path: str) -> str:
    if _is_chinook_path(fh2_file_path):
        # Right side: 'DJI_202606081426_001_...' → '2026-06-08T14:26:00'
        right = fh2_file_path.split("/", 1)[1]
        match = re.match(r'DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})', right)
        if match:
            y, mo, d, h, mi = match.groups()
            return f"{y}-{mo}-{d}T{h}:{mi}:00"
        return ""
    # Drone in the Box: 'MyPlan 2026-06-02 09:28:41 (UTC-08)' → '2026-06-02T09:28:41'
    match = re.match(r'^.+?\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})', fh2_file_path)
    if match:
        return f"{match.group(1)}T{match.group(2)}"
    return ""

#Main Handler - Webhook Flow
def handler(event, _context):
    print(f"Raw event: {json.dumps(event)}")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        body = {}

    print(f"Webhook payload: {json.dumps(body)}")

    if body.get("type") != "sync_file_success":
        print(f"Ignoring type: {body.get('type')!r}")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    data = body.get("data") or {}
    fh2_file_path = data.get("fh2_file_path", "")
    source_key = data.get("file_external_key", "")
    file_size = data.get("file_bytes_size", 0)

    if not source_key:
        print("No file_external_key in payload")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    folder_name = fh2_file_path
    plan_name = _parse_plan_name(fh2_file_path)
    timestamp = _parse_timestamp(fh2_file_path)
    filename = source_key.split("/")[-1]

    if not plan_name:
        print(f"Could not parse plan name from: {folder_name!r} — skipping")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    print(f"Plan: {plan_name!r} | Timestamp: {timestamp!r} | File: {filename}")

    flight_plan_id = _find_or_create_flight_plan(plan_name)
    if not flight_plan_id:
        print("ERROR: could not resolve flight plan ID")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    flight_id = _find_or_create_flight(flight_plan_id, timestamp, folder_name)
    if not flight_id:
        print("ERROR: could not resolve flight ID")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    ext = os.path.splitext(filename)[1].lower()
    upload_result = _frontend_post("/api/v1/upload", {
        "flightId": flight_id,
        "files": [{
            "name": filename,
            "type": CONTENT_TYPES.get(ext, "application/octet-stream"),
            "size": file_size,
        }]
    })

    uploads = upload_result.get("uploads", [])
    if not uploads:
        print("ERROR: no upload keys returned from frontend")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    dest_key = uploads[0]["fields"]["key"]
    print(f"Moving: {source_key} → {dest_key}")

    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=source_key)
        content_type = obj.get("ContentType", CONTENT_TYPES.get(ext, "application/octet-stream"))
        s3.upload_fileobj(
            obj["Body"],
            BUCKET_NAME,
            dest_key,
            ExtraArgs={"ContentType": content_type},
        )
        s3.delete_object(Bucket=BUCKET_NAME, Key=source_key)
        print("Done")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            print(f"SKIP: source key not found (already moved?): {source_key}")
        else:
            raise

    _frontend_post("/api/v1/files/register", {"key": dest_key, "flightId": flight_id})
    print(f"Registered: {dest_key}")

    return {"statusCode": 200, "body": json.dumps({"code": 0})}
