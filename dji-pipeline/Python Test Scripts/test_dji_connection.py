"""
DJI FlightHub 2 OpenAPI connection test.
Real API domain discovered from browser network requests: es-flight-api-us.djigate.com
URL pattern: /{service}/api/v1/organizations/{org_uuid}/...?proj_uuid={proj_uuid}

Playground for exploring DJI API
"""

import os
import uuid
import json
import base64
import pathlib
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

try:
    from PIL import Image
    import piexif
    EXIF_AVAILABLE = True
except ImportError:
    EXIF_AVAILABLE = False

load_dotenv()

BASE_URL = "https://es-flight-api-us.djigate.com"
USER_TOKEN = os.getenv("DJI_OPENAPI_KEY", "")
PROJECT_UUID = os.getenv("DJI_PROJECT_UUID", "")

DOWNLOAD_DIR = pathlib.Path("downloads")

# file_type integers observed from the API
FILE_TYPE_FOLDER = 1
FILE_TYPE_IMAGE = 2
FILE_TYPE_VIDEO = 3


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(label: str):
    print(f"  [PASS] {label}")

def _fail(label: str, detail: str = ""):
    print(f"  [FAIL] {label}{': ' + detail if detail else ''}")

def _section(title: str):
    print(f"\n{'='*60}\n  {title}\n{'='*60}")

def _log(resp: requests.Response):
    print(f"  [DEBUG] {resp.request.method} {resp.url}")
    print(f"  [DEBUG] Status : {resp.status_code}")
    try:
        print(f"  [DEBUG] Body   : {json.dumps(resp.json())[:500]}")
    except Exception:
        print(f"  [DEBUG] Body   : {repr(resp.text[:500])}")

def _get(session: requests.Session, path: str, **kwargs) -> requests.Response:
    session.headers["X-Request-Id"] = str(uuid.uuid4())
    return session.get(f"{BASE_URL}{path}", timeout=15, **kwargs)

def decode_jwt_payload(token: str) -> dict:
    """Decode JWT payload without verifying signature."""
    try:
        payload_b64 = token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        return json.loads(base64.b64decode(padded))
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# 1. Auth + extract org UUID from JWT
# ---------------------------------------------------------------------------

def build_session() -> tuple:
    _section("1. Authentication")

    if not USER_TOKEN:
        _fail("DJI_OPENAPI_KEY not set in .env")
        return None, None

    payload = decode_jwt_payload(USER_TOKEN)
    org_uuid = payload.get("organization_uuid")
    if not org_uuid:
        _fail("Could not extract organization_uuid from JWT")
        return None, None
    _ok(f"Org UUID from JWT : {org_uuid}")

    exp = payload.get("exp")
    if exp:
        exp_dt = datetime.utcfromtimestamp(exp)
        _ok(f"Token expires     : {exp_dt.isoformat()} UTC")

    session = requests.Session()
    session.headers.update({
        "X-User-Token": USER_TOKEN,
        "Content-Type": "application/json",
        "X-Language": "en",
    })

    # Probe: list media files (known endpoint shape from browser)
    probe_path = f"/media/api/v1/organizations/{org_uuid}/data-hub/files"
    params = {"proj_uuid": PROJECT_UUID, "page": 1, "page_size": 1} if PROJECT_UUID else {"page": 1, "page_size": 1}
    resp = _get(session, probe_path, params=params)

    print(f"  [DEBUG] Status : {resp.status_code}")
    try:
        body = resp.json()
        print(f"  [DEBUG] Body   : {json.dumps(body)[:400]}")
    except Exception:
        print(f"  [DEBUG] Body   : {repr(resp.text[:400])}")
        _fail("Auth probe", "non-JSON response")
        return None, org_uuid

    if resp.status_code in (200, 401, 403):
        if resp.status_code == 200:
            _ok("X-User-Token accepted")
            return session, org_uuid
        else:
            _fail("Auth probe", f"HTTP {resp.status_code} — token may be invalid or lack permissions")
            return None, org_uuid

    _fail("Auth probe", f"HTTP {resp.status_code}")
    return None, org_uuid


# ---------------------------------------------------------------------------
# 2. List projects
# ---------------------------------------------------------------------------

def list_projects(session: requests.Session, org_uuid: str) -> list:
    _section("2. Projects")

    # Try a few candidate paths — actual path TBD from network inspection
    candidates = [
        f"/flight/api/v1/organizations/{org_uuid}/projects",
        f"/openapi/v0.1/project",
        f"/api/v1/organizations/{org_uuid}/projects",
    ]

    for path in candidates:
        resp = _get(session, path, params={"page": 1, "page_size": 20})
        if resp.status_code == 200:
            try:
                data = resp.json()
                projects = (
                    data.get("data", {}).get("list")
                    or data.get("list")
                    or data.get("data")
                    or []
                )
                if isinstance(projects, list):
                    _ok(f"Found {len(projects)} project(s) via {path}")
                    for p in projects[:5]:
                        print(f"      - [{p.get('uuid') or p.get('proj_uuid')}] {p.get('name')}")
                    return projects
            except Exception:
                pass
        _log(resp)

    _fail("List projects", "No candidate path worked — share a /project network request from DevTools")
    return []


# ---------------------------------------------------------------------------
# 3. Devices (needed to get SN for flight task queries)
# ---------------------------------------------------------------------------

def list_devices(session: requests.Session, proj_uuid: str) -> list:
    _section("3. Devices")

    session.headers["X-Project-Uuid"] = proj_uuid
    resp = _get(session, "/openapi/v0.1/project/device")

    if resp.status_code != 200:
        _fail("List devices", f"HTTP {resp.status_code}")
        _log(resp)
        return []

    try:
        data = resp.json()
    except Exception:
        _fail("List devices", "non-JSON response")
        _log(resp)
        return []

    if data.get("code") != 0:
        _fail("List devices", f"code={data.get('code')} msg={data.get('message')}")
        return []

    devices = data.get("data", {}).get("list") or []
    _ok(f"Found {len(devices)} device(s)")
    for d in devices[:10]:
        sn = d.get("sn", "unknown")
        model = d.get("device_model") or d.get("name", "unknown")
        online = d.get("device_online_status", "?")
        print(f"      - {model} | SN: {sn} | Online: {online}")
    return devices


# ---------------------------------------------------------------------------
# 4. List media files
# ---------------------------------------------------------------------------

def _fetch_media_page(session, org_uuid, proj_uuid, pid=None, page_size=20) -> list:
    """Fetch one page of media files, optionally scoped to a parent folder ID."""
    path = f"/media/api/v1/organizations/{org_uuid}/data-hub/files"
    params = {"proj_uuid": proj_uuid, "page": 1, "page_size": page_size}
    if pid is not None:
        params["pid"] = pid
    resp = _get(session, path, params=params)
    if resp.status_code != 200:
        return []
    try:
        data = resp.json()
        return data.get("data", {}).get("list") or data.get("list") or []
    except Exception:
        return []


def _fetch_all_media(session, org_uuid, proj_uuid, page_size=200) -> list:
    """Fetch every media item across all pages in a single flat list."""
    path = f"/media/api/v1/organizations/{org_uuid}/data-hub/files"
    all_items = []
    page = 1
    while True:
        params = {"proj_uuid": proj_uuid, "page": page, "page_size": page_size}
        resp = _get(session, path, params=params)
        if resp.status_code != 200:
            break
        try:
            data = resp.json()
            items = data.get("data", {}).get("list") or data.get("list") or []
        except Exception:
            break
        if not items:
            break
        all_items.extend(items)
        if len(items) < page_size:
            break
        page += 1
    return all_items


def list_media(session: requests.Session, org_uuid: str, proj_uuid: str) -> list:
    _section("4. Media Files (Photos & Videos)")

    if not proj_uuid:
        _fail("DJI_PROJECT_UUID not set in .env")
        return []

    # Get top-level items
    items = _fetch_media_page(session, org_uuid, proj_uuid)
    if not items:
        _fail("List media", "No items returned")
        return []

    # Separate folders from files at the root level
    folders = [f for f in items if f.get("file_type") == FILE_TYPE_FOLDER]
    files   = [f for f in items if f.get("file_type") != FILE_TYPE_FOLDER]

    # Recurse one level into each folder to find actual media
    for folder in folders[:3]:
        children = _fetch_media_page(session, org_uuid, proj_uuid, pid=folder.get("id"))
        child_files = [c for c in children if c.get("file_type") != FILE_TYPE_FOLDER]
        files.extend(child_files)

    # Deduplicate by file ID (root listing and subfolder listing can overlap)
    seen = set()
    unique_files = []
    for f in files:
        key = f.get("id") or f.get("uuid") or f.get("name")
        if key not in seen:
            seen.add(key)
            unique_files.append(f)
    files = unique_files

    _ok(f"Found {len(files)} media file(s) across {len(folders)} top-level folder(s)")
    for f in files[:10]:
        name  = f.get("name", "unknown")
        ftype = {FILE_TYPE_IMAGE: "image", FILE_TYPE_VIDEO: "video"}.get(f.get("file_type"), f"type={f.get('file_type')}")
        size  = f.get("size", 0)
        size_mb = f"{size / 1_000_000:.1f} MB" if size else "?"
        created = f.get("created_at") or f.get("create_at", "")
        print(f"      - {name} | {ftype} | {size_mb} | {created}")

    return files


# ---------------------------------------------------------------------------
# 4. List flight tasks
# ---------------------------------------------------------------------------

def list_flight_tasks(session: requests.Session, proj_uuid: str, devices: list) -> list:
    _section("5. Flight Tasks / Logs")

    if not proj_uuid:
        _fail("DJI_PROJECT_UUID not set — skipping")
        return []

    if not devices:
        _fail("No devices found — cannot query flight tasks (SN required)")
        return []

    # X-Project-Uuid must be a header for /openapi/v0.1 endpoints
    session.headers["X-Project-Uuid"] = proj_uuid

    now = datetime.utcnow()
    begin_at = int((now - timedelta(days=180)).timestamp() * 1000)
    end_at   = int(now.timestamp() * 1000)

    all_tasks = []
    for device in devices[:3]:
        sn = device.get("sn")
        if not sn:
            continue
        resp = _get(session, "/openapi/v0.1/flight-task/list", params={
            "sn": sn,
            "begin_at": begin_at,
            "end_at": end_at,
            "page": 1,
            "page_size": 5,
        })
        if resp.status_code != 200:
            _log(resp)
            continue
        try:
            data = resp.json()
        except Exception:
            continue
        if data.get("code") != 0:
            _fail(f"Flight tasks for SN {sn}", f"code={data.get('code')} msg={data.get('message')}")
            continue
        tasks = data.get("data", {}).get("list") or []
        if tasks:
            print(f"  [DEBUG] Full first task: {json.dumps(tasks[0], default=str)}")
        _ok(f"SN {sn}: {len(tasks)} task(s)")
        for t in tasks[:5]:
            tid    = t.get("uuid", "?")
            name   = t.get("name", "unnamed")
            status = t.get("status", "?")
            run_at = t.get("run_at") or t.get("begin_at", "")
            if isinstance(run_at, (int, float)):
                run_at = datetime.utcfromtimestamp(run_at / 1000).isoformat()
            print(f"      - [{tid}] {name} | {status} | {run_at}")
        all_tasks.extend(tasks)

    if not all_tasks:
        _fail("No flight tasks found in last 180 days across all devices")
    return all_tasks


# ---------------------------------------------------------------------------
# 5. Wayline routes (flight plans)
# ---------------------------------------------------------------------------

def list_wayline_routes(session: requests.Session, org_uuid: str, proj_uuid: str) -> list:
    _section("5. Wayline Routes (Flight Plans)")

    if not proj_uuid:
        _fail("DJI_PROJECT_UUID not set")
        return []

    path = f"/wayline/api/v1/organizations/{org_uuid}/data-hub/web-waylines"

    # Step 1: get top-level folders (file_type=1)
    resp = _get(session, path, params={"proj_uuid": proj_uuid, "file_type": 1, "page": 1, "size": 50})
    if resp.status_code != 200:
        _fail("Wayline folders", f"HTTP {resp.status_code}")
        _log(resp)
        return []

    try:
        data = resp.json()
    except Exception:
        _fail("Wayline folders", "non-JSON response")
        return []

    folders = data.get("data", {}).get("list") or data.get("list") or []
    _ok(f"Found {len(folders)} top-level wayline folder(s)")
    if folders:
        print(f"  [DEBUG] First folder raw: {json.dumps(folders[0], default=str)}")

    # Step 2: for each folder, list actual route files (file_type=5)
    all_routes = []
    for folder in folders:
        folder_id = folder.get("uuid") or folder.get("id")
        folder_name = folder.get("name", "unnamed")

        resp2 = _get(session, path, params={
            "proj_uuid": proj_uuid,
            "file_type": 5,
            "parent_id": folder_id,
            "page": 1,
            "size": 50,
            "order_by": "update_time desc",
        })
        if resp2.status_code != 200:
            continue
        try:
            data2 = resp2.json()
        except Exception:
            continue

        routes = data2.get("data", {}).get("list") or data2.get("list") or []
        _ok(f"  [{folder_name}] → {len(routes)} route(s)")
        for r in routes[:10]:
            rid  = r.get("uuid") or r.get("id")
            name = r.get("name", "unnamed")
            print(f"      - [{rid}] {name}")
        if routes:
            print(f"  [DEBUG] First route raw: {json.dumps(routes[0], default=str)}")
        all_routes.extend(routes)

    if not all_routes:
        _fail("No wayline routes found")
    return all_routes


# ---------------------------------------------------------------------------
# 6. Print media folder tree (two levels deep)
# ---------------------------------------------------------------------------

def print_media_tree(session: requests.Session, org_uuid: str, proj_uuid: str):
    _section("5. Media Folder Tree")

    if not proj_uuid:
        _fail("DJI_PROJECT_UUID not set")
        return

    all_items = _fetch_all_media(session, org_uuid, proj_uuid)
    if not all_items:
        _fail("No items returned")
        return

    print(f"  Total items fetched: {len(all_items)}")

    # Build parent->children map using p_infos.pid
    children_of: dict = {}
    for item in all_items:
        pid = item.get("p_infos", {}).get("pid", 0)
        children_of.setdefault(pid, []).append(item)

    root_items = children_of.get(0, [])
    root_folders = [i for i in root_items if i.get("file_type") == FILE_TYPE_FOLDER]
    root_files   = [i for i in root_items if i.get("file_type") != FILE_TYPE_FOLDER]

    if root_files:
        print(f"  [root]  {len(root_files)} loose file(s) not inside any folder")

    for route_folder in root_folders:
        route_name = route_folder.get("name", "unnamed")
        route_id   = route_folder.get("id")
        print(f"\n  [{route_name}]  (id={route_id})")

        children      = children_of.get(route_id, [])
        child_folders = [c for c in children if c.get("file_type") == FILE_TYPE_FOLDER]
        child_files   = [c for c in children if c.get("file_type") != FILE_TYPE_FOLDER]

        if child_files:
            images = [f for f in child_files if f.get("file_type") == FILE_TYPE_IMAGE]
            videos = [f for f in child_files if f.get("file_type") == FILE_TYPE_VIDEO]
            print(f"    (loose files at this level: {len(images)} image(s), {len(videos)} video(s))")

        first_flight_printed = False
        for flight_folder in child_folders:
            flight_name = flight_folder.get("name", "unnamed")
            flight_id   = flight_folder.get("id")
            if not first_flight_printed:
                print(f"  [DEBUG] First flight folder raw: {json.dumps(flight_folder, default=str)}")
                first_flight_printed = True

            gc            = children_of.get(flight_id, [])
            gc_files      = [g for g in gc if g.get("file_type") != FILE_TYPE_FOLDER]
            gc_folders    = [g for g in gc if g.get("file_type") == FILE_TYPE_FOLDER]
            images        = [f for f in gc_files if f.get("file_type") == FILE_TYPE_IMAGE]
            videos        = [f for f in gc_files if f.get("file_type") == FILE_TYPE_VIDEO]
            if images:
                print(f"  [DEBUG] First image raw: {json.dumps(images[0], default=str)}")
            elif videos:
                print(f"  [DEBUG] First video raw: {json.dumps(videos[0], default=str)}")
            extra         = f"  +{len(gc_folders)} sub-folder(s)" if gc_folders else ""
            print(f"    [{flight_name}]  (id={flight_id})  →  {len(images)} image(s), {len(videos)} video(s){extra}")


# ---------------------------------------------------------------------------
# 6. Download media + EXIF for images
# ---------------------------------------------------------------------------

def _download_file(session: requests.Session, url: str, dest: pathlib.Path, size_bytes: int = 0):
    """Stream a file to disk with a simple progress indicator."""
    downloaded = 0
    with session.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in r.iter_content(chunk_size=131072):
                fh.write(chunk)
                downloaded += len(chunk)
                if size_bytes:
                    pct = downloaded / size_bytes * 100
                    print(f"\r    {downloaded / 1_000_000:.1f} / {size_bytes / 1_000_000:.1f} MB  ({pct:.0f}%)", end="", flush=True)
    print()  # newline after progress


def _extract_exif(dest: pathlib.Path):
    if not EXIF_AVAILABLE:
        return
    try:
        img = Image.open(dest)
        _ok(f"Image dimensions: {img.size[0]}x{img.size[1]} px, mode={img.mode}")

        exif = piexif.load(str(dest))
        gps = exif.get("GPS", {})

        def dms_to_dec(dms, ref):
            if not dms:
                return None
            d, m, s = [n / d for n, d in dms]
            v = d + m / 60 + s / 3600
            return round(-v if ref in (b"S", b"W") else v, 7)

        lat = dms_to_dec(gps.get(piexif.GPSIFD.GPSLatitude), gps.get(piexif.GPSIFD.GPSLatitudeRef, b"N"))
        lon = dms_to_dec(gps.get(piexif.GPSIFD.GPSLongitude), gps.get(piexif.GPSIFD.GPSLongitudeRef, b"E"))
        if lat and lon:
            _ok(f"GPS: lat={lat}, lon={lon}")
        else:
            print("  [INFO] No GPS EXIF in this image.")

        dt = exif.get("Exif", {}).get(piexif.ExifIFD.DateTimeOriginal)
        if dt:
            _ok(f"Capture time: {dt.decode()}")
    except Exception as e:
        _fail("EXIF extraction", str(e))


def download_media(session: requests.Session, files: list):
    _section("6. Download Media Files")

    if not files:
        print("  [SKIP] No media files to download.")
        return

    # Show available URL fields from the first record for debugging
    first = files[0]
    url_fields = [k for k in first.keys() if "url" in k.lower()]
    print(f"  [DEBUG] URL fields in media record: {url_fields}")
    print(f"  [DEBUG] Full first record: {json.dumps(first, default=str)[:600]}")

    DOWNLOAD_DIR.mkdir(exist_ok=True)
    downloaded_count = 0

    for f in files:
        name  = f.get("name", f"file_{f.get('id', 'unknown')}")
        ftype = f.get("file_type")
        size  = f.get("size", 0)
        url   = f.get("original_url") or f.get("download_url") or f.get("url")

        if not url:
            print(f"  [SKIP] {name} — no download URL found (keys: {list(f.keys())})")
            continue

        # Add suffix if missing
        suffix = f.get("suffix", "")
        if suffix and not name.endswith(suffix):
            name = f"{name}.{suffix.lstrip('.')}"

        dest = DOWNLOAD_DIR / name
        if dest.exists():
            _ok(f"Already exists, skipping: {dest}")
            downloaded_count += 1
            continue

        type_label = {FILE_TYPE_IMAGE: "image", FILE_TYPE_VIDEO: "video"}.get(ftype, f"type={ftype}")
        size_mb = f"{size / 1_000_000:.1f} MB" if size else "?"
        print(f"\n  Downloading {type_label}: {name} ({size_mb})")

        try:
            _download_file(session, url, dest, size)
            _ok(f"Saved → {dest}")
            downloaded_count += 1
        except Exception as e:
            _fail(f"Download failed: {name}", str(e))
            continue

        if ftype == FILE_TYPE_IMAGE:
            _extract_exif(dest)

    print(f"\n  {downloaded_count}/{len(files)} file(s) downloaded to {DOWNLOAD_DIR.resolve()}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"\nDJI FlightHub 2 — OpenAPI Connection Test")
    print(f"Base URL    : {BASE_URL}")
    print(f"Project UUID: {PROJECT_UUID or '(not set — will be discovered)'}")

    session, org_uuid = build_session()
    if not session:
        print("\n[ABORT] Fix auth before continuing.\n")
        return

    proj_uuid = PROJECT_UUID

    projects = list_projects(session, org_uuid)
    if not proj_uuid and projects:
        proj_uuid = projects[0].get("uuid") or projects[0].get("proj_uuid", "")
        if proj_uuid:
            print(f"\n  Auto-selected project UUID: {proj_uuid}")
            print(f"  Tip: add DJI_PROJECT_UUID={proj_uuid} to your .env to pin this project.")

    devices = list_devices(session, proj_uuid)
    files   = list_media(session, org_uuid, proj_uuid)
    list_flight_tasks(session, proj_uuid, devices)
    list_wayline_routes(session, org_uuid, proj_uuid)
    print_media_tree(session, org_uuid, proj_uuid)
    # download_media(session, files)

    print(f"\n{'='*60}\n  Test run complete.\n{'='*60}\n")


if __name__ == "__main__":
    main()
