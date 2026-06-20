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
    Matches by Chinook flight name suffix so root-level and Matrice-prefixed
    paths for the same flight are treated as identical.
    """
    chinook_seg = _chinook_segment(folder_name) if "/" in folder_name else None
    flights = _frontend_get("/api/v1/flights", {"flightPlanId": flight_plan_id})
    for f in (flights or []):
        notes = f.get("notes") or ""
        if notes == folder_name:
            print(f"Matched flight: {f['id']} ({f.get('timestamp')})")
            return f["id"]
        if chinook_seg and notes.endswith(chinook_seg):
            print(f"Matched flight by Chinook suffix: {f['id']} ({f.get('timestamp')})")
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


_wayline_list_cache: dict = {}  # dji_project_id → {slugified_name: wayline_name}


def _get_wayline_list(dji_project_id: str) -> dict:
    """Fetch and cache all wayline names for a project. Returns {slug: name}."""
    if dji_project_id not in _wayline_list_cache:
        try:
            wr = _dji_get("/openapi/v0.1/wayline", project_uuid=dji_project_id)
            waylines = ((wr.get("data") or {}).get("list") or [])
            _wayline_list_cache[dji_project_id] = {
                _slugify(w.get("name", "")): w.get("name", "")
                for w in waylines if w.get("name")
            }
        except Exception as e:
            print(f"[WARN] Wayline list fetch failed: {e}")
            _wayline_list_cache[dji_project_id] = {}
    return _wayline_list_cache[dji_project_id]


def _get_plan_name(dji_project_id: str, created_at: int, fh2_file_path: str) -> str:
    """
    Resolve the route (wayline) name via the DJI API.

    Chinook: matches parsed name against wayline list.
    DITB: task → wayline_uuid → wayline name.

    Returns empty string if no wayline is found.
    """
    if not DJI_OPENAPI_KEY or not dji_project_id:
        return ""

    parsed = _parse_plan_name(fh2_file_path)

    if _is_chinook_path(fh2_file_path):
        if not parsed:
            return ""
        waylines = _get_wayline_list(dji_project_id)
        slug = _slugify(parsed)
        match = waylines.get(slug)
        if match:
            print(f"Wayline matched: {fh2_file_path!r} → {match!r}")
        return match or ""

    # DITB: task → wayline lookup
    if not created_at:
        return ""

    task_name = re.sub(r'[-\s]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}.*$', '', fh2_file_path).strip()
    if not task_name:
        return ""

    try:
        if dji_project_id not in _dji_device_cache:
            resp = _dji_get("/openapi/v0.1/project/device", project_uuid=dji_project_id)
            _dji_device_cache[dji_project_id] = (resp.get("data") or {}).get("list") or []

        begin_at = (created_at - 86400) * 1000
        end_at   = (created_at + 3600) * 1000

        for device in _dji_device_cache[dji_project_id]:
            sn = device.get("sn")
            if not sn:
                continue
            tasks_resp = _dji_get(
                "/openapi/v0.1/flight-task/list",
                project_uuid=dji_project_id,
                params={"sn": sn, "begin_at": begin_at, "end_at": end_at},
            )
            for task in ((tasks_resp.get("data") or {}).get("list") or []):
                if task.get("name") != task_name:
                    continue
                wayline_uuid = task.get("wayline_uuid")
                if not wayline_uuid:
                    continue
                if wayline_uuid not in _dji_wayline_cache:
                    wr = _dji_get(f"/openapi/v0.1/wayline/{wayline_uuid}", project_uuid=dji_project_id)
                    _dji_wayline_cache[wayline_uuid] = (wr.get("data") or {}).get("name") or ""
                name = _dji_wayline_cache.get(wayline_uuid, "")
                if name:
                    print(f"Task→wayline resolved: {fh2_file_path!r} → {name!r}")
                    return name

    except Exception as e:
        print(f"[WARN] Task wayline lookup failed: {e}")

    return ""


#Functions for extracting plan name and timestamp
_CHINOOK_RE = re.compile(r'^DJI_\d{12}_\d{3}_')

def _is_chinook_path(fh2_file_path: str) -> bool:
    """Chinook paths: 'DroneID/DJI_YYYYMMDDHHMM_NNN_RouteName' or root-level 'DJI_YYYYMMDDHHMM_NNN_RouteName'"""
    if "/" in fh2_file_path:
        right = fh2_file_path.split("/", 1)[1]
        return bool(_CHINOOK_RE.match(right))
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
    # Drone in the Box: 'MyPlan 2026-06-02 09:28:41 (UTC-08)' or 'spawner-FLY-TO-2026-06-18 ...'
    match = re.match(r'^(.+?)[\s-]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}', fh2_file_path)
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
    # Drone in the Box: 'MyPlan 2026-06-02 09:28:41 (UTC-08)' or 'spawner-FLY-TO-2026-06-18 ...'
    match = re.match(r'^.+?[\s-](\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})', fh2_file_path)
    if match:
        return f"{match.group(1)}T{match.group(2)}"
    return ""

#Shared: resolve plan name, flight plan, and flight from fh2_file_path
def _resolve_flight(fh2_file_path: str, dji_project_id: str = "", created_at: int = 0):
    """Returns (plan_name, flight_plan_id, flight_id) or raises on failure."""
    plan_name = _get_plan_name(dji_project_id, created_at, fh2_file_path)
    timestamp = _parse_timestamp(fh2_file_path)

    if not plan_name and timestamp:
        plan_name = f"{timestamp[:16].replace('T', '-').replace(':', '')}-no-route-flight"
    elif not plan_name:
        plan_name = _parse_plan_name(fh2_file_path)

    if not plan_name:
        raise ValueError(f"Could not parse plan name from: {fh2_file_path!r}")

    flight_plan_id = _find_or_create_flight_plan(plan_name)
    if not flight_plan_id:
        raise ValueError("Could not resolve flight plan ID")

    flight_id = _find_or_create_flight(flight_plan_id, timestamp, fh2_file_path)
    if not flight_id:
        raise ValueError("Could not resolve flight ID")

    print(f"Plan: {plan_name!r} | Timestamp: {timestamp!r} | Flight: {flight_id}")
    return plan_name, flight_plan_id, flight_id


def _upload_and_register(flight_id: str, filename: str, file_size: int, body_stream):
    """Upload a file body to S3 (via presigned key) and register it."""
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
        raise ValueError(f"No upload key returned for {filename}")

    dest_key = uploads[0]["fields"]["key"]
    content_type = CONTENT_TYPES.get(ext, "application/octet-stream")
    s3.upload_fileobj(
        body_stream,
        BUCKET_NAME,
        dest_key,
        ExtraArgs={"ContentType": content_type},
    )

    _frontend_post("/api/v1/files/register", {"key": dest_key, "flightId": flight_id})
    print(f"Registered: {dest_key}")
    return dest_key


#Handler: sync_flight — download files from DJI and register them
def _handle_sync_flight(body: dict) -> dict:
    data = body.get("data") or {}
    fh2_file_path = data.get("fh2_file_path", "")
    files = data.get("files") or []
    dji_project_id = body.get("project_id", "")

    if not fh2_file_path or not files:
        print("sync_flight: missing fh2_file_path or files")
        return {"statusCode": 200, "body": json.dumps({"code": 0, "error": "missing data"})}

    plan_name, flight_plan_id, flight_id = _resolve_flight(fh2_file_path, dji_project_id)

    succeeded = 0
    failed = []

    for f in files:
        name = f.get("name", "")
        suffix = f.get("suffix", "")
        if suffix and not name.lower().endswith(f".{suffix.lower().lstrip('.')}"):
            name = f"{name}.{suffix.lstrip('.')}"
        download_url = f.get("download_url", "")
        file_size = f.get("size", 0)

        if not download_url:
            failed.append(f"{name}: no download URL")
            continue

        try:
            print(f"Downloading: {name} ({file_size} bytes)")
            req = urllib.request.Request(download_url)
            with urllib.request.urlopen(req, timeout=300) as resp:
                _upload_and_register(flight_id, name, file_size, resp)
            succeeded += 1
        except Exception as e:
            print(f"FAILED {name}: {e}")
            failed.append(f"{name}: {e}")

    print(f"sync_flight complete: {succeeded}/{len(files)} succeeded, {len(failed)} failed")
    return {
        "statusCode": 200,
        "body": json.dumps({
            "code": 0,
            "succeeded": succeeded,
            "failed": failed,
            "total": len(files),
        }),
    }


#Handler: sync_file_success — existing webhook flow (S3 landing → final)
def _handle_sync_file_success(body: dict) -> dict:
    data = body.get("data") or {}
    fh2_file_path = data.get("fh2_file_path", "")
    source_key = data.get("file_external_key", "")
    file_size = data.get("file_bytes_size", 0)

    if not source_key:
        print("No file_external_key in payload")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}

    dji_project_id = body.get("project_id", "")
    created_at = body.get("created_at", 0)

    filename = source_key.split("/")[-1]

    try:
        plan_name, flight_plan_id, flight_id = _resolve_flight(
            fh2_file_path, dji_project_id, created_at
        )
    except ValueError as e:
        print(f"ERROR: {e}")
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


#Main Handler - Webhook Flow
def handler(event, _context):
    print(f"Raw event: {json.dumps(event)}")

    # Async Lambda invoke (InvocationType=Event) passes the payload directly,
    # not wrapped in an API Gateway event with "body".
    if isinstance(event, dict) and "type" in event:
        body = event
    else:
        try:
            body = json.loads(event.get("body") or "{}")
        except Exception:
            body = {}

    print(f"Webhook payload: {json.dumps(body)}")

    event_type = body.get("type", "")

    if event_type == "sync_flight":
        return _handle_sync_flight(body)
    elif event_type == "sync_file_success":
        return _handle_sync_file_success(body)
    else:
        print(f"Ignoring type: {event_type!r}")
        return {"statusCode": 200, "body": json.dumps({"code": 0})}
