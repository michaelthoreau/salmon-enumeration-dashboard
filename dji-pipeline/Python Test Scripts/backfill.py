"""
Backfill DJI FlightHub 2 media files to S3 and trigger the webhook Lambda.

Lists all flights for a project, lets you pick which ones to sync, then
streams each file from DJI → S3 landing zone and fires the webhook so the
Lambda handles Project Kiwi creation exactly as if DJI had synced it live.

Usage:
    python backfill.py                          # interactive, uses .env
    python backfill.py --project-uuid <uuid>    # override project
    python backfill.py --dry-run                # preview without uploading
"""

import argparse
import base64
import json
import os
import sys
import urllib.request
import uuid as uuid_lib

import boto3
import requests
from dotenv import load_dotenv

load_dotenv()

BASE_URL    = "https://es-flight-api-us.djigate.com"
USER_TOKEN  = os.getenv("DJI_OPENAPI_KEY", "")
DEFAULT_PROJECT_UUID = os.getenv("DJI_PROJECT_UUID", "")
BUCKET_NAME = "salmon-enumeration-ml-prod"
WEBHOOK_URL = os.getenv(
    "WEBHOOK_URL",
    "https://dohhl47k9d.execute-api.us-east-1.amazonaws.com/prod/dji/notify",
)

FILE_TYPE_FOLDER = 1
FILE_TYPE_IMAGE  = 2
FILE_TYPE_VIDEO  = 3


# ---------------------------------------------------------------------------
# DJI API helpers
# ---------------------------------------------------------------------------

def _decode_jwt(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.b64decode(part))
    except Exception:
        return {}


def build_session() -> tuple[requests.Session, str]:
    payload  = _decode_jwt(USER_TOKEN)
    org_uuid = payload.get("organization_uuid", "")
    session  = requests.Session()
    session.headers.update({
        "X-User-Token": USER_TOKEN,
        "Content-Type": "application/json",
        "X-Language":   "en",
    })
    return session, org_uuid


def _get(session: requests.Session, path: str, **kwargs) -> requests.Response:
    session.headers["X-Request-Id"] = str(uuid_lib.uuid4())
    return session.get(f"{BASE_URL}{path}", timeout=15, **kwargs)


def list_projects(session: requests.Session, org_uuid: str) -> list:
    resp = _get(session, "/openapi/v0.1/project", params={"page": 1, "page_size": 50})
    if resp.status_code != 200:
        return []
    try:
        return resp.json().get("data", {}).get("list") or []
    except Exception:
        return []


def select_project(session: requests.Session, org_uuid: str, default_uuid: str) -> str:
    projects = list_projects(session, org_uuid)
    if not projects:
        print("  Could not fetch project list — using UUID from .env")
        return default_uuid

    print(f"\n{'─'*70}")
    print(f"  {'#':>3}  {'Project Name':40}  UUID")
    print(f"{'─'*70}")
    for i, p in enumerate(projects, 1):
        name = p.get("name", "unnamed")[:40]
        uid  = p.get("uuid", "")
        marker = "  ← default" if uid == default_uuid else ""
        print(f"  {i:>3}  {name:40}  {uid}{marker}")
    print(f"{'─'*70}\n")

    raw = input("Select project number (or press Enter for default): ").strip()
    if not raw:
        return default_uuid
    try:
        idx = int(raw) - 1
        if 0 <= idx < len(projects):
            chosen = projects[idx].get("uuid", "")
            print(f"  Using: {projects[idx].get('name')} ({chosen})")
            return chosen
    except ValueError:
        pass
    print("  Invalid selection — using default")
    return default_uuid


def fetch_all_media(session: requests.Session, org_uuid: str, proj_uuid: str) -> list:
    """Fetch every media item by paginating until no new items appear.

    The DJI API ignores the pid filter and caps pages at 100 items regardless
    of page_size, so we paginate by unique ID rather than page count.
    """
    path     = f"/media/api/v1/organizations/{org_uuid}/data-hub/files"
    all_items, seen_ids, page = [], set(), 1

    while True:
        resp = _get(session, path, params={"proj_uuid": proj_uuid, "page": page, "page_size": 100})
        if resp.status_code != 200:
            print(f"  [WARN] Media API returned {resp.status_code} on page {page}")
            break
        try:
            batch = resp.json().get("data", {}).get("list") or resp.json().get("list") or []
        except Exception:
            break
        new_items = [i for i in batch if i.get("id") not in seen_ids]
        if not new_items:
            break
        for item in new_items:
            seen_ids.add(item.get("id"))
        all_items.extend(new_items)
        page += 1

    return all_items


# ---------------------------------------------------------------------------
# Build the flight tree from raw media items
# ---------------------------------------------------------------------------

def build_flight_tree(all_items: list) -> list:
    """
    Returns a list of flights sorted newest-first, each with:
        fh2_file_path  – passed to the webhook as fh2_file_path
        display_name   – shown in the selection UI
        files          – list of DJI media file records
    """
    children_of: dict = {}
    for item in all_items:
        pid = (item.get("p_infos") or {}).get("pid", 0)
        children_of.setdefault(pid, []).append(item)

    flights = []
    root_folders = [i for i in children_of.get(0, []) if i.get("file_type") == FILE_TYPE_FOLDER]

    for root_folder in root_folders:
        root_name = root_folder.get("name", "")
        root_id   = root_folder.get("id")
        children  = children_of.get(root_id, [])

        child_folders = [c for c in children if c.get("file_type") == FILE_TYPE_FOLDER]
        child_files   = [c for c in children if c.get("file_type") != FILE_TYPE_FOLDER]

        if child_folders:
            # Chinook: root = drone ID, children = flight folders
            for flight_folder in child_folders:
                flight_name = flight_folder.get("name", "")
                flight_id   = flight_folder.get("id")
                gc_files    = [f for f in children_of.get(flight_id, [])
                               if f.get("file_type") != FILE_TYPE_FOLDER]
                if gc_files:
                    flights.append({
                        "fh2_file_path": f"{root_name}/{flight_name}",
                        "display_name":  f"{root_name}  /  {flight_name}",
                        "files":         gc_files,
                    })
        elif child_files:
            # Drone in the Box: root folder name IS the fh2_file_path
            flights.append({
                "fh2_file_path": root_name,
                "display_name":  root_name,
                "files":         child_files,
            })

    # Newest first (folder name contains timestamp so lexicographic sort works)
    flights.sort(key=lambda f: f["fh2_file_path"], reverse=True)
    return flights


# ---------------------------------------------------------------------------
# Interactive selection
# ---------------------------------------------------------------------------

def display_flights(flights: list):
    print(f"\n{'─'*70}")
    print(f"  {'#':>3}  {'Flight':50}  {'Files':>8}")
    print(f"{'─'*70}")
    for i, flight in enumerate(flights, 1):
        n_img = sum(1 for f in flight["files"] if f.get("file_type") == FILE_TYPE_IMAGE)
        n_vid = sum(1 for f in flight["files"] if f.get("file_type") == FILE_TYPE_VIDEO)
        parts = []
        if n_img:
            parts.append(f"{n_img} img")
        if n_vid:
            parts.append(f"{n_vid} vid")
        label = ", ".join(parts)
        name  = flight["display_name"][:50]
        print(f"  {i:>3}  {name:50}  {label:>8}")
    print(f"{'─'*70}\n")


def select_flights(flights: list) -> list:
    print("Enter flight numbers to sync (comma-separated), a range (e.g. 1-3), or 'all':")
    raw = input("> ").strip()
    if raw.lower() == "all":
        return flights

    selected = []
    seen     = set()
    for part in raw.split(","):
        part = part.strip()
        if "-" in part:
            try:
                lo, hi = part.split("-", 1)
                for idx in range(int(lo) - 1, int(hi)):
                    if 0 <= idx < len(flights) and idx not in seen:
                        selected.append(flights[idx])
                        seen.add(idx)
            except ValueError:
                print(f"  Warning: could not parse range '{part}', skipping")
        else:
            try:
                idx = int(part) - 1
                if 0 <= idx < len(flights) and idx not in seen:
                    selected.append(flights[idx])
                    seen.add(idx)
                elif idx not in seen:
                    print(f"  Warning: {part} out of range, skipping")
            except ValueError:
                print(f"  Warning: '{part}' is not a number, skipping")
    return selected


# ---------------------------------------------------------------------------
# Sync a single flight
# ---------------------------------------------------------------------------

def _resolve_filename(f: dict) -> str:
    name   = f.get("name", f"file_{f.get('id', 'unknown')}")
    suffix = f.get("suffix", "")
    if suffix and not name.lower().endswith(f".{suffix.lower().lstrip('.')}"):
        name = f"{name}.{suffix.lstrip('.')}"
    return name


def sync_flight(
    session:   requests.Session,
    org_uuid:  str,
    proj_uuid: str,
    flight:    dict,
    dry_run:   bool,
):
    fh2_path = flight["fh2_file_path"]
    files    = flight["files"]
    s3       = boto3.client("s3", region_name="us-east-1")

    print(f"\n  ── {flight['display_name']} ({len(files)} file(s)) ──")

    for f in files:
        file_id      = f.get("id", str(uuid_lib.uuid4()))
        name         = _resolve_filename(f)
        size         = f.get("size", 0)
        download_url = f.get("original_url") or f.get("download_url") or f.get("url")
        s3_key       = f"landing/fh_sync/{org_uuid}/{proj_uuid}/media/{file_id}/{name}"
        size_label   = f"{size / 1_000_000:.1f} MB" if size else "?"

        print(f"    {name}  ({size_label})")

        if dry_run:
            print(f"      [DRY RUN] s3://{BUCKET_NAME}/{s3_key}")
            continue

        if not download_url:
            print(f"      [SKIP] no download URL in API response")
            continue

        # Stream DJI → S3
        print(f"      uploading...", end="", flush=True)
        try:
            with session.get(download_url, stream=True, timeout=300) as r:
                r.raise_for_status()
                r.raw.decode_content = True
                s3.upload_fileobj(r.raw, BUCKET_NAME, s3_key)
            print(" ok")
        except Exception as e:
            print(f" FAILED: {e}")
            continue

        # Fire webhook → Lambda processes it just like a live sync
        payload = json.dumps({
            "type":       "sync_file_success",
            "org_id":     org_uuid,
            "project_id": proj_uuid,
            "data": {
                "fh2_file_path":    fh2_path,
                "file_bytes_size":  size,
                "file_external_key": s3_key,
                "file_id":          file_id,
                "file_type":        "media",
            },
        }).encode()

        req = urllib.request.Request(
            WEBHOOK_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read())
            print(f"      webhook: {body}")
        except Exception as e:
            print(f"      webhook FAILED: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Backfill DJI media to S3 + Project Kiwi")
    parser.add_argument("--project-uuid", default=None,
                        help="DJI project UUID (defaults to interactive project picker)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List files without uploading or firing webhooks")
    args = parser.parse_args()

    if not USER_TOKEN:
        print("ERROR: DJI_OPENAPI_KEY not set in .env")
        sys.exit(1)

    session, org_uuid = build_session()

    if args.project_uuid:
        proj_uuid = args.project_uuid
    else:
        print(f"\nFetching DJI projects...")
        proj_uuid = select_project(session, org_uuid, DEFAULT_PROJECT_UUID)

    if not proj_uuid:
        print("ERROR: no project selected")
        sys.exit(1)

    print(f"\nFetching media from DJI FlightHub 2...")
    print(f"  Org:     {org_uuid}")
    print(f"  Project: {proj_uuid}")
    if args.dry_run:
        print(f"  Mode:    DRY RUN — nothing will be uploaded")

    all_items = fetch_all_media(session, org_uuid, proj_uuid)
    print(f"  Items:   {len(all_items)}")

    flights = build_flight_tree(all_items)
    if not flights:
        print("\nNo flights found for this project.")
        return

    display_flights(flights)
    selected = select_flights(flights)

    if not selected:
        print("No flights selected. Exiting.")
        return

    total_files = sum(len(f["files"]) for f in selected)
    print(f"\nSelected {len(selected)} flight(s), {total_files} file(s)"
          + (" [DRY RUN]" if args.dry_run else "") + ":")
    for f in selected:
        print(f"  - {f['display_name']}")

    if not args.dry_run:
        confirm = input("\nProceed? [y/N] ").strip().lower()
        if confirm != "y":
            print("Aborted.")
            return

    for flight in selected:
        sync_flight(session, org_uuid, proj_uuid, flight, args.dry_run)

    print(f"\nDone.")


if __name__ == "__main__":
    main()
