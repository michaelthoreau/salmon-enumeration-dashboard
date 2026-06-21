"""
Salmon enumeration — ODM upload worker.

This Modal app handles the slow work of pulling flight images out of S3 and
streaming them into a NodeODM node, then committing the task so processing
begins.  Running on Modal gives us a generous timeout (up to 1 h), plenty of
memory, and proper async concurrency — none of which a Next.js API route can
offer for large flights.

Required Modal secrets
──────────────────────
salmon
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_REGION
  S3_BUCKET_NAME

salmon
  ODM_NODE_URL            NodeODM base URL, token included if required,
                          e.g. http://your-odm-server:3000?token=abc123
  MODAL_ODM_WORKER_TOKEN  shared bearer token; set the same value in your
                          Next.js MODAL_ODM_WORKER_TOKEN env var

Deploy
──────
  pip install modal
  modal deploy modal/odm_worker.py

Then copy the printed URL into MODAL_ODM_WORKER_URL in your Next.js env.
"""

import asyncio
import io
import os
from typing import Any

import modal
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

# ── Container image ────────────────────────────────────────────────────────────

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("gdal-bin", "python3-gdal", "libgl1", "libglib2.0-0")
    .pip_install(
        "fastapi[standard]",
        "boto3",
        "Pillow",
        "piexif",
        "pyproj",
        "cameratransform",
        "opencv-python-headless",
        "rasterio",
        "httpx",
    )
)

app = modal.App("salmon-odm-worker", image=image)

# ── Auth ───────────────────────────────────────────────────────────────────────

_auth_scheme = HTTPBearer()


def _require_auth(creds: HTTPAuthorizationCredentials = Depends(_auth_scheme)) -> None:
    token = os.environ.get("MODAL_ODM_WORKER_TOKEN", "")
    if not token or creds.credentials != token:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Request / response models ──────────────────────────────────────────────────

class ImageSpec(BaseModel):
    key: str      # S3 object key
    filename: str # filename as NodeODM will see it


class ProcessRequest(BaseModel):
    task_name: str
    images: list[ImageSpec]
    bucket: str  # S3 bucket name — passed from the Next.js app so both sides agree


class CollectRequest(BaseModel):
    odm_uuid: str
    flight_id: str
    project_id: str
    flight_plan_id: str
    bucket: str
    odm_node_url: str


# ── Persistent upload progress using modal.Dict ────────────────────────────────
# Keyed by odm_uuid. Shared across all worker containers.
_progress = modal.Dict.from_name("salmon-odm-progress", create_if_missing=True)

CONCURRENT_UPLOADS = 5  # simultaneous S3→ODM pipelines



# ── ASGI app ───────────────────────────────────────────────────────────────────

@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("salmon")
    ],
    timeout=3600,   # 1 hour ceiling; large flights can take a while
    memory=8192,    # 8 GB
    cpu=16,         # 16 CPUs
)
@modal.asgi_app()
def web() -> FastAPI:
    web_app = FastAPI(title="Salmon ODM Worker")

    # ── ODM URL helper (built once per request context) ────────────────────
    def _make_odm_url():
        from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
        raw = os.environ["ODM_NODE_URL"]
        parsed = urlparse(raw)
        base_params = dict(parse_qsl(parsed.query))
        origin = urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))

        def odm_url(path: str, extra: dict | None = None) -> str:
            params = {**base_params, **(extra or {})}
            qs = urlencode(params)
            return f"{origin}{path}{'?' + qs if qs else ''}"

        return odm_url

    # ── Background upload + commit ─────────────────────────────────────────
    async def _upload_and_commit(odm_uuid: str, images: list[ImageSpec], bucket: str) -> None:
        import boto3
        import httpx

        odm_url = _make_odm_url()
        s3 = boto3.client(
            "s3",
            region_name=os.environ["AWS_REGION"],
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        )
        loop = asyncio.get_event_loop()
        sem = asyncio.Semaphore(CONCURRENT_UPLOADS)
        progress_lock = asyncio.Lock()

        async def update_progress(uploaded_inc=0, new_error=None, new_err_msg=None, committed=False):
            async with progress_lock:
                entry = _progress.get(odm_uuid)
                if entry:
                    if uploaded_inc:
                        entry["uploaded"] += uploaded_inc
                    if new_error:
                        errors = list(entry.get("errors", []))
                        errors.append(new_error)
                        entry["errors"] = errors
                    if new_err_msg is not None:
                        entry["error"] = new_err_msg
                    if committed:
                        entry["committed"] = True
                    _progress[odm_uuid] = entry

        async def upload_one(img: ImageSpec) -> None:
            async with sem:
                try:
                    buf = io.BytesIO()
                    await loop.run_in_executor(
                        None,
                        lambda: s3.download_fileobj(bucket, img.key, buf),
                    )
                    buf.seek(0)
                    content_type = (
                        "image/png"
                        if img.filename.lower().endswith(".png")
                        else "image/jpeg"
                    )
                    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as c:
                        r = await c.post(
                            odm_url(f"/task/new/upload/{odm_uuid}"),
                            files={"images": (img.filename, buf.read(), content_type)},
                        )
                        if r.status_code != 200:
                            await update_progress(new_error=f"{img.filename}: ODM returned {r.status_code}")
                except Exception as exc:
                    await update_progress(new_error=f"{img.filename}: {exc}")
                finally:
                    await update_progress(uploaded_inc=1)

        await asyncio.gather(*[upload_one(img) for img in images])

        entry = _progress.get(odm_uuid)
        errors = entry.get("errors", []) if entry else []
        if errors:
            sample = "; ".join(errors[:5])
            await update_progress(new_err_msg=f"{len(errors)} upload error(s): {sample}")
            return

        # Commit — kicks off ODM processing
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.post(odm_url(f"/task/new/commit/{odm_uuid}"))
            if r.status_code != 200:
                await update_progress(new_err_msg=f"ODM commit failed ({r.status_code}): {r.text}")
                return

        await update_progress(committed=True)

    # ── POST /process ──────────────────────────────────────────────────────
    @web_app.post("/process")
    async def process(
        req: ProcessRequest,
        background_tasks: BackgroundTasks,
        _: None = Depends(_require_auth),
    ) -> dict:
        import httpx

        odm_url = _make_odm_url()

        # Init ODM task synchronously so we have a UUID to return immediately
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.post(
                odm_url("/task/new/init"),
                data={
                    "name": req.task_name,
                    "options": '[{"name":"cog","value":true},{"name":"fast-orthophoto","value":true},{"name":"skip-3dmodel","value":true},{"name":"orthophoto-resolution","value":1.0},{"name":"crop","value":0}]',
                    "outputs": '["odm_orthophoto/odm_orthophoto.tif","odm_report/report.pdf"]',
                },
            )
            if r.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"ODM init failed ({r.status_code}): {r.text}",
                )
            try:
                body = r.json()
            except Exception:
                raise HTTPException(
                    status_code=502,
                    detail=f"ODM init response is not valid JSON. Response: {r.text[:500]}",
                )
            odm_uuid: str = body.get("uuid", "")
            if not odm_uuid:
                raise HTTPException(
                    status_code=502,
                    detail=f"ODM init: no uuid returned. Response: {body}",
                )

        # Seed the progress entry before the background task touches it
        _progress[odm_uuid] = {
            "uploaded": 0,
            "total": len(req.images),
            "committed": False,
            "error": None,
            "errors": [],
        }

        # Kick off uploads in the background — response returns immediately
        background_tasks.add_task(_upload_and_commit, odm_uuid, req.images, req.bucket)

        return {"odm_uuid": odm_uuid, "total": len(req.images)}

    # ── GET /upload-progress/{odm_uuid} ───────────────────────────────────
    @web_app.get("/upload-progress/{odm_uuid}")
    async def upload_progress(
        odm_uuid: str,
        _: None = Depends(_require_auth),
    ) -> dict:
        entry = _progress.get(odm_uuid)
        if entry is None:
            # Unknown UUID — either never started or container was recycled
            raise HTTPException(status_code=404, detail="No progress record for this UUID")
        return {
            "uploaded": entry["uploaded"],
            "total": entry["total"],
            "committed": entry["committed"],
            "error": entry["error"],
        }

    # ── POST /collect-async and GET /collect-status ────────────────────────
    @web_app.post("/collect-async")
    async def collect_async(
        req: CollectRequest,
        background_tasks: BackgroundTasks,
        _: None = Depends(_require_auth),
    ) -> dict:
        print(f"[collect-async] odm_uuid={req.odm_uuid} flight_id={req.flight_id} bucket={req.bucket}")
        _progress[req.odm_uuid] = {
            "phase": "collecting",
            "status": "running",
            "processed": 0,
            "total": 100,
            "output_key": None,
            "report_key": None,
            "tiles_key": None,
            "error": None,
            "output": ["Initiating output collection..."],
        }
        background_tasks.add_task(
            _process_collect,
            req.odm_uuid,
            req.flight_id,
            req.project_id,
            req.flight_plan_id,
            req.bucket,
            req.odm_node_url,
        )
        return {"status": "running"}

    @web_app.get("/collect-status/{odm_uuid}")
    async def collect_status(
        odm_uuid: str,
        _: None = Depends(_require_auth),
    ) -> dict:
        entry = _progress.get(odm_uuid)
        if entry is None or entry.get("phase") != "collecting":
            raise HTTPException(status_code=404, detail="No collection progress record for this UUID")
        return {
            "status": entry["status"],
            "processed": entry["processed"],
            "total": entry["total"],
            "output_key": entry["output_key"],
            "report_key": entry["report_key"],
            "tiles_key": entry["tiles_key"],
            "max_zoom": entry.get("max_zoom"),
            "error": entry["error"],
            "output": entry.get("output", []),
        }

    return web_app


def log_collect(odm_uuid: str, msg: str):
    print(f"[{odm_uuid}] {msg}")
    entry = dict(_progress.get(odm_uuid, {}))
    output = list(entry.get("output", []))
    output.append(msg)
    entry["output"] = output
    _progress[odm_uuid] = entry


async def _process_collect(
    odm_uuid: str,
    flight_id: str,
    project_id: str,
    flight_plan_id: str,
    bucket: str,
    odm_node_url: str,
) -> None:
    import zipfile
    import boto3
    import httpx
    import tempfile
    import os
    import io
    import asyncio
    import subprocess
    import concurrent.futures
    from PIL import Image

    s3 = boto3.client(
        "s3",
        region_name=os.environ["AWS_REGION"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )
    loop = asyncio.get_event_loop()

    prefix = f"projects/{project_id}/flight-plans/{flight_plan_id}/flights/{flight_id}/"
    log_collect(odm_uuid, f"[collect] Starting output collection for NodeODM uuid: {odm_uuid}")

    from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
    parsed = urlparse(odm_node_url)
    base_params = dict(parse_qsl(parsed.query))
    origin = urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))
    def odm_url(path: str, extra: dict | None = None) -> str:
        params = {**base_params, **(extra or {})}
        qs = urlencode(params)
        return f"{origin}{path}{'?' + qs if qs else ''}"

    try:
        log_collect(odm_uuid, f"[collect] Downloading output archive (all.zip) from NodeODM...")
        async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
            r = await client.get(odm_url(f"/task/{odm_uuid}/download/all.zip"))
            if r.status_code != 200:
                raise RuntimeError(f"Failed to download all.zip from ODM ({r.status_code}): {r.text[:300]}")
            zip_data = r.content

        log_collect(odm_uuid, f"[collect] Extracting output files...")
        with tempfile.TemporaryDirectory() as tmpdir:
            output_key = f"{prefix}outputs/orthophoto.tif"
            report_key = None
            cog_path = os.path.join(tmpdir, "orthophoto.tif")

            with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
                tif_entry = next(
                    (name for name in z.namelist() if "odm_orthophoto" in name and (name.endswith(".tif") or name.endswith(".tiff"))),
                    None
                )
                if not tif_entry:
                    raise RuntimeError("odm_orthophoto.tif not found in all.zip")

                with z.open(tif_entry) as f_in, open(cog_path, "wb") as f_out:
                    f_out.write(f_in.read())

                report_entry = next(
                    (name for name in z.namelist() if "report" in name and name.endswith(".pdf")),
                    None
                )
                if report_entry:
                    report_key = f"{prefix}odm/{flight_id}_report.pdf"
                    pdf_path = os.path.join(tmpdir, "report.pdf")
                    with z.open(report_entry) as f_in, open(pdf_path, "wb") as f_out:
                        f_out.write(f_in.read())

            log_collect(odm_uuid, f"[collect] Uploading orthophoto GeoTIFF to s3://{bucket}/{output_key}...")
            await loop.run_in_executor(
                None,
                lambda: s3.upload_file(
                    cog_path,
                    bucket,
                    output_key,
                    ExtraArgs={"ContentType": "image/tiff"}
                )
            )

            if report_key:
                log_collect(odm_uuid, f"[collect] Uploading PDF report to s3://{bucket}/{report_key}...")
                await loop.run_in_executor(
                    None,
                    lambda: s3.upload_file(
                        pdf_path,
                        bucket,
                        report_key,
                        ExtraArgs={"ContentType": "application/pdf"}
                    )
                )

            tiles_dir = os.path.join(tmpdir, "tiles")
            os.makedirs(tiles_dir, exist_ok=True)

            log_collect(odm_uuid, "[collect] Generating static map tiles with gdal2tiles (512px tiles, 32 processes)...")
            cmd_tiling = [
                "gdal2tiles.py",
                "--xyz",
                "--processes=32",
                "-w", "none",
                "--tilesize=512",
                cog_path,
                tiles_dir
            ]

            def run_tiling_with_progress():
                process = subprocess.Popen(
                    cmd_tiling,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in process.stdout:
                    log_collect(odm_uuid, f"[gdal2tiles] {line.rstrip()}")
                process.wait()
                if process.returncode != 0:
                    raise RuntimeError(f"Tiling failed (exit code {process.returncode})")
                log_collect(odm_uuid, "[collect] gdal2tiles complete.")

            await loop.run_in_executor(None, run_tiling_with_progress)

            tiles_key = f"{prefix}outputs/tiles-{odm_uuid}"
            tile_tasks = []
            for root_dir, _, files_list in os.walk(tiles_dir):
                for file_name in files_list:
                    if file_name.endswith('.png'):
                        png_path = os.path.join(root_dir, file_name)
                        rel_path = os.path.relpath(png_path, tiles_dir)
                        parts = rel_path.split(os.sep)
                        if len(parts) == 3:
                            z, x, y_png = parts
                            y = y_png.rsplit('.', 1)[0]
                            tile_tasks.append((png_path, z, x, y))

            total_tiles = len(tile_tasks)
            log_collect(odm_uuid, f"[collect] Found {total_tiles} generated tiles. Converting to WebP and uploading to S3...")

            if total_tiles > 0:
                # Update total in progress
                entry = dict(_progress.get(odm_uuid, {}))
                entry["total"] = total_tiles
                _progress[odm_uuid] = entry

                uploaded_tiles = 0

                def upload_one_tile(png_path, z, x, y):
                    nonlocal uploaded_tiles
                    w_key = f"{tiles_key}/{z}/{x}/{y}.webp"
                    try:
                        with Image.open(png_path) as im:
                            out_buf = io.BytesIO()
                            im.save(out_buf, format="WEBP", quality=80)
                            out_buf.seek(0)
                            s3.put_object(
                                Bucket=bucket,
                                Key=w_key,
                                Body=out_buf.read(),
                                ContentType="image/webp",
                            )
                    except Exception:
                        pass
                    
                    uploaded_tiles += 1
                    entry = dict(_progress.get(odm_uuid, {}))
                    entry["processed"] = uploaded_tiles
                    _progress[odm_uuid] = entry

                    if uploaded_tiles % 100 == 0 or uploaded_tiles == total_tiles:
                        log_collect(odm_uuid, f"[collect] Uploaded {uploaded_tiles}/{total_tiles} WebP tiles ({int(uploaded_tiles / total_tiles * 100)}%)")

                with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
                    await loop.run_in_executor(
                        None,
                        lambda: list(executor.map(lambda t: upload_one_tile(*t), tile_tasks))
                    )

            log_collect(odm_uuid, f"[collect] Output collection and static WebP tiling completed.")
            entry = dict(_progress.get(odm_uuid, {}))
            entry["status"] = "completed"
            entry["output_key"] = output_key
            entry["report_key"] = report_key
            entry["tiles_key"] = tiles_key
            entry["max_zoom"] = max(int(t[1]) for t in tile_tasks) if tile_tasks else None
            _progress[odm_uuid] = entry

    except Exception as exc:
        log_collect(odm_uuid, f"[collect] ERROR: {exc}")
        entry = dict(_progress.get(odm_uuid, {}))
        entry["status"] = "failed"
        entry["error"] = str(exc)
        _progress[odm_uuid] = entry
    finally:
        log_key = f"{prefix}outputs/orthophoto.log"
        logs_text = "\n".join(_progress.get(odm_uuid, {}).get("output", []))
        if s3 is not None and loop is not None:
            try:
                await loop.run_in_executor(
                    None,
                    lambda: s3.put_object(
                        Bucket=bucket,
                        Key=log_key,
                        Body=logs_text.encode('utf-8'),
                        ContentType='text/plain',
                    )
                )
                print(f"[collect] Uploaded task logs to s3://{bucket}/{log_key}")
            except Exception as log_exc:
                print(f"[collect] Failed to upload logs to S3: {log_exc}")
