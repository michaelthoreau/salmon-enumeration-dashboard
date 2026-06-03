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
    .pip_install("fastapi[standard]", "boto3", "httpx")
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


# ── In-memory upload progress ──────────────────────────────────────────────────
# Keyed by odm_uuid.  Works reliably within a single warm container — good
# enough for our use case (one flight at a time, small team).

_progress: dict[str, dict[str, Any]] = {}

CONCURRENT_UPLOADS = 5  # simultaneous S3→ODM pipelines


# ── ASGI app ───────────────────────────────────────────────────────────────────

@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("salmon")
    ],
    timeout=3600,   # 1 hour ceiling; large flights can take a while
    memory=2048,    # 2 GB — comfortable for 5 concurrent image buffers
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
                    async with httpx.AsyncClient(timeout=300) as c:
                        r = await c.post(
                            odm_url(f"/task/new/upload/{odm_uuid}"),
                            files={"images": (img.filename, buf.read(), content_type)},
                        )
                        if r.status_code != 200:
                            _progress[odm_uuid]["errors"].append(
                                f"{img.filename}: ODM returned {r.status_code}"
                            )
                except Exception as exc:
                    _progress[odm_uuid]["errors"].append(f"{img.filename}: {exc}")
                finally:
                    _progress[odm_uuid]["uploaded"] += 1

        await asyncio.gather(*[upload_one(img) for img in images])

        errors = _progress[odm_uuid]["errors"]
        if errors:
            sample = "; ".join(errors[:5])
            _progress[odm_uuid]["error"] = f"{len(errors)} upload error(s): {sample}"
            return

        # Commit — kicks off ODM processing
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(odm_url(f"/task/new/commit/{odm_uuid}"))
            if r.status_code != 200:
                _progress[odm_uuid]["error"] = (
                    f"ODM commit failed ({r.status_code}): {r.text}"
                )
                return

        _progress[odm_uuid]["committed"] = True

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
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                odm_url("/task/new/init"),
                data={
                    "name": req.task_name,
                    "options": '[{"name":"cog","value":true},{"name":"fast-orthophoto","value":true},{"name":"skip-3dmodel","value":true}]',
                    "outputs": '["odm_orthophoto/odm_orthophoto.tif","odm_report/report.pdf"]',
                },
            )
            if r.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"ODM init failed ({r.status_code}): {r.text}",
                )
            body = r.json()
            odm_uuid: str = body.get("uuid", "")
            if not odm_uuid:
                raise HTTPException(status_code=502, detail="ODM init: no uuid returned")

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

    return web_app
