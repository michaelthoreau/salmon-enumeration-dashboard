#Imports
import json
import os
import re
import uuid as _uuid
import urllib.request
import urllib.parse
import boto3
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ["BUCKET_NAME"]
FRONTEND_API_URL = os.environ["FRONTEND_API_URL"]
FRONTEND_API_KEY = os.environ["FRONTEND_API_KEY"]
FRONTEND_PROJECT_ID = os.environ.get("FRONTEND_PROJECT_ID", "")

DJI_OPENAPI_KEY = os.environ.get("DJI_OPENAPI_KEY", "")
DJI_BASE_URL = os.environ.get("DJI_BASE_URL", "https://es-flight-api-us.djigate.com")

# Module-level caches — persist across warm Lambda invocations
_dji_device_cache: dict = {}   # dji_project_id → [device, ...]
_dji_wayline_cache: dict = {}  # wayline_uuid → name

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

#DJI API helpers for DITB route name lookup
def _dji_get(path: str, project_uuid: str = "", params: dict = None) -> dict:
    url = f"{DJI_BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {
        "X-User-Token": DJI_OPENAPI_KEY,
        "Content-Type": "application/json",
        "X-Language": "en",
        "X-Request-Id": str(_uuid.uuid4()),
    }
    if project_uuid:
        headers["X-Project-Uuid"] = project_uuid
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _get_ditb_plan_name(dji_project_id: str, created_at: int, fh2_file_path: str) -> str:
    """
    Resolve the route (wayline) name for a Drone in the Box flight via the DJI API.

    DJI task names (e.g. "Ians-requested-flight 2") differ from the underlying
    wayline/route name (e.g. "TrainingArea-LinearRouteForTesting"). This function
    looks up the task by name + timestamp window, then follows the wayline_uuid to
    get the actual route name so DITB and Chinook-1 flights map to the same plan.

    Chain: project/device → flight-task/list (match by task name) → wayline/{uuid}
    Returns empty string if the lookup fails or DJI_OPENAPI_KEY is not set.
    """
    if not DJI_OPENAPI_KEY or not dji_project_id:
        return ""

    # Strip timestamp from fh2_file_path to recover the DJI task name
    # e.g. "Ians-requested-flight 2 2026-06-02 12:02:45 (UTC-08)" → "Ians-requested-flight 2"
    task_name = re.sub(r'\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}.*$', '', fh2_file_path).strip()
    if not task_name:
        return ""

    try:
        # Step 1: Get dock devices for this project (cached per warm instance)
        if dji_project_id not in _dji_device_cache:
            resp = _dji_get("/openapi/v0.1/project/device", project_uuid=dji_project_id)
            _dji_device_cache[dji_project_id] = (resp.get("data") or {}).get("list") or []
        devices = _dji_device_cache[dji_project_id]

        # Step 2: Search tasks in a 24h-before to 1h-after window around the sync event
        # created_at is in seconds; DJI task list API uses milliseconds
        begin_at = (created_at - 86400) * 1000
        end_at   = (created_at + 3600) * 1000

        for device in devices:
            sn = device.get("sn")
            if not sn:
                continue
            tasks_resp = _dji_get(
                "/openapi/v0.1/flight-task/list",
                project_uuid=dji_project_id,
                params={"sn": sn, "begin_at": begin_at, "end_at": end_at},
            )
            tasks = (tasks_resp.get("data") or {}).get("list") or []

            for task in tasks:
                if task.get("name") != task_name:
                    continue
                wayline_uuid = task.get("wayline_uuid")
                if not wayline_uuid:
                    continue

                # Step 3: Resolve wayline name (cached)
                if wayline_uuid not in _dji_wayline_cache:
                    wr = _dji_get(f"/openapi/v0.1/wayline/{wayline_uuid}", project_uuid=dji_project_id)
                    _dji_wayline_cache[wayline_uuid] = (wr.get("data") or {}).get("name") or ""
                name = _dji_wayline_cache.get(wayline_uuid, "")
                if name:
                    print(f"DITB route resolved: {task_name!r} → {name!r}")
                    return name

    except Exception as e:
        print(f"[WARN] DITB wayline lookup failed: {e}")

    return ""


#Functions for extracting plan name and timestamp
_CHINOOK_RE = re.compile(r'^DJI_\d{12}_\d{3}_')

def _is_chinook_path(fh2_file_path: str) -> bool:
    """Chinook paths: 'DroneID/DJI_YYYYMMDDHHMM_NNN_RouteName' or root-level 'DJI_YYYYMMDDHHMM_NNN_RouteName'"""
    if "/" in fh2_file_path:
        return True
    return bool(_CHINOOK_RE.match(fh2_file_path))


def _chinook_segment(fh2_file_path: str) -> str:
    """Return the Chinook flight segment (after '/' if present, else the whole string)."""
    return fh2_file_path.split("/", 1)[1] if "/" in fh2_file_path else fh2_file_path


def _parse_plan_name(fh2_file_path: str) -> str:
    if _is_chinook_path(fh2_file_path):
        right = _chinook_segment(fh2_file_path)
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
        right = _chinook_segment(fh2_file_path)
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
    if _is_chinook_path(fh2_file_path):
        plan_name = _parse_plan_name(fh2_file_path)
    else:
        dji_project_id = body.get("project_id", "")
        created_at     = body.get("created_at", 0)
        plan_name = _get_ditb_plan_name(dji_project_id, created_at, fh2_file_path)
        if not plan_name:
            # Fallback: use task name minus timestamp
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
