import json
import os
import subprocess
import urllib.request
import boto3

BUCKET_NAME = os.environ["BUCKET_NAME"]
FRONTEND_API_URL = os.environ["FRONTEND_API_URL"]
FRONTEND_API_KEY = os.environ["FRONTEND_API_KEY"]
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "/opt/bin/ffmpeg")

INPUT_PATH = "/tmp/input_video"
OUTPUT_PATH = "/tmp/output_video.mp4"

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv"}

s3 = boto3.client("s3")


def _is_compressible(key: str) -> bool:
    """Returns True for raw video files that should be compressed."""
    lower = key.lower()
    if not any(lower.endswith(ext) for ext in VIDEO_EXTS):
        return False
    skip_prefixes = ["/compressed/", "/odm/", "/outputs/", "/georef/"]
    return not any(f"/{seg}/" in f"/{key}" for seg in ["compressed", "odm", "outputs", "georef"])


def _compressed_key(original_key: str) -> str:
    """Insert 'compressed/' before the filename in the S3 key."""
    parts = original_key.rsplit("/", 1)
    if len(parts) == 2:
        return f"{parts[0]}/compressed/{parts[1]}"
    return f"compressed/{original_key}"


def _notify_frontend(original_key: str, compressed_key: str | None, status: str):
    body = json.dumps({
        "originalKey": original_key,
        "compressedKey": compressed_key,
        "status": status,
    }).encode()
    req = urllib.request.Request(
        f"{FRONTEND_API_URL}/api/v1/files/compression-complete",
        data=body,
        headers={
            "Authorization": f"Bearer {FRONTEND_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"Frontend notified: {resp.status}")
    except Exception as e:
        print(f"[WARN] Failed to notify frontend: {e}")


def handler(event, _context):
    for record in event.get("Records", []):
        key = record["s3"]["object"]["key"]

        if not _is_compressible(key):
            print(f"Skipping non-video or excluded key: {key}")
            continue

        compressed = _compressed_key(key)
        print(f"Compressing: {key} → {compressed}")

        # Mark as pending so the UI can show a status indicator
        _notify_frontend(key, None, "pending")

        try:
            print(f"Downloading s3://{BUCKET_NAME}/{key}")
            s3.download_file(BUCKET_NAME, key, INPUT_PATH)

            cmd = [
                FFMPEG_PATH,
                "-i", INPUT_PATH,
                "-c:v", "libx264",
                "-crf", "22",
                "-preset", "veryfast",
                "-vf", "scale=-2:1080",
                "-r", "30",
                "-an",
                "-movflags", "+faststart",
                "-map_metadata", "0",
                "-y", OUTPUT_PATH,
            ]
            print(f"Running FFmpeg: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg exited {result.returncode}:\n{result.stderr[-2000:]}")

            print(f"Uploading compressed video to s3://{BUCKET_NAME}/{compressed}")
            s3.upload_file(
                OUTPUT_PATH, BUCKET_NAME, compressed,
                ExtraArgs={"ContentType": "video/mp4"},
            )

            _notify_frontend(key, compressed, "done")
            print(f"Compression complete: {compressed}")

        except Exception as e:
            print(f"COMPRESSION ERROR: {key} — {e}")
            _notify_frontend(key, None, "failed")

        finally:
            for path in (INPUT_PATH, OUTPUT_PATH):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
