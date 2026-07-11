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
    lower = key.lower()
    if not any(lower.endswith(ext) for ext in VIDEO_EXTS):
        return False
    return not any(f"/{seg}/" in f"/{key}" for seg in ["compressed", "odm", "outputs", "georef"])


def _compressed_key(original_key: str) -> str:
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


def _run_ffmpeg(resolution: str, ffmpeg_timeout: float) -> None:
    cmd = [
        FFMPEG_PATH,
        "-i", INPUT_PATH,
        "-c:v", "libx264",
        "-crf", "22",
        "-preset", "ultrafast",
        "-vf", resolution,
        "-r", "30",
        "-an",
        "-movflags", "+faststart",
        "-map_metadata", "0",
        "-y", OUTPUT_PATH,
    ]
    print(f"Running FFmpeg ({resolution}): {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=ffmpeg_timeout)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg exited {result.returncode}:\n{result.stderr[-2000:]}")


def handler(event, context):
    for record in event.get("Records", []):
        key = record["s3"]["object"]["key"]

        if not _is_compressible(key):
            print(f"Skipping non-video or excluded key: {key}")
            continue

        compressed = _compressed_key(key)
        print(f"Compressing: {key} → {compressed}")

        _notify_frontend(key, None, "pending")

        try:
            print(f"Downloading s3://{BUCKET_NAME}/{key}")
            s3.download_file(BUCKET_NAME, key, INPUT_PATH)

            # Reserve 90s for upload + notify; remaining time drives FFmpeg timeout
            remaining_s = context.get_remaining_time_in_millis() / 1000
            ffmpeg_timeout = max(60, remaining_s - 90)

            try:
                _run_ffmpeg("scale=-2:1080", ffmpeg_timeout)
            except subprocess.TimeoutExpired:
                print(f"1080p timed out for {key}, retrying at 720p")
                remaining_s = context.get_remaining_time_in_millis() / 1000
                ffmpeg_timeout = max(60, remaining_s - 90)
                _run_ffmpeg("scale=-2:720", ffmpeg_timeout)

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
