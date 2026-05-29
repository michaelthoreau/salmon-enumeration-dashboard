"""
Salmon enumeration — COG tile server.

Serves XYZ PNG tiles and bounding-box metadata from Cloud-Optimised GeoTIFFs
stored in S3, using rio_tiler + rasterio.  MapLibre on the frontend points at
the Next.js proxy (/api/tiles/...) which forwards requests here with an auth
header.

Required Modal secrets
──────────────────────
salmon
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_REGION
  S3_BUCKET_NAME

salmon
  MODAL_TILE_TOKEN  shared bearer token; set the same value in your
                    Next.js MODAL_TILE_TOKEN env var

Deploy
──────
  modal deploy modal/tile_server.py

Copy the printed web-endpoint URL into MODAL_TILE_SERVER_URL in your Next.js env.
"""

import os

import modal
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# ── Image ──────────────────────────────────────────────────────────────────────

image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]", "rio-tiler[http]")
)

app = modal.App("salmon-tile-server", image=image)

# ── Auth ───────────────────────────────────────────────────────────────────────

_auth_scheme = HTTPBearer()


def _require_auth(
    creds: HTTPAuthorizationCredentials = Depends(_auth_scheme),
) -> None:
    token = os.environ.get("MODAL_TILE_TOKEN", "")
    if not token or creds.credentials != token:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── ASGI app ───────────────────────────────────────────────────────────────────

@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("salmon"),
    ],
    memory=1024,
)
@modal.asgi_app()
def web() -> FastAPI:
    import rasterio

    web_app = FastAPI(title="Salmon Tile Server")

    # GDAL environment tweaks for fast COG access over S3.
    # Values must be native Python types (int/bool/str) — rasterio's Cython
    # layer rejects strings for options it expects as integers.
    _gdal_env: dict[str, object] = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "GDAL_CACHEMAX": 512,               # MB, int
        "VSI_CACHE": True,                  # bool
        "VSI_CACHE_SIZE": 536870912,        # 512 MB, int (bytes)
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF,.tiff",
        # GDAL uses AWS_DEFAULT_REGION; Modal provides AWS_REGION from the secret
        "AWS_DEFAULT_REGION": os.environ.get("AWS_REGION", "us-east-1"),
    }

    def _s3_url(key: str) -> str:
        bucket = os.environ["S3_BUCKET_NAME"]
        return f"s3://{bucket}/{key}"

    # ── GET /info ──────────────────────────────────────────────────────────────

    @web_app.get("/info")
    async def info(
        key: str = Query(...),
        _: None = Depends(_require_auth),
    ) -> dict:
        from rio_tiler.io import COGReader

        with rasterio.Env(**_gdal_env):
            with COGReader(_s3_url(key)) as cog:
                meta = cog.info()
                bounds = list(cog.geographic_bounds)  # [W, S, E, N] in WGS-84

        return {
            "bounds": bounds,
            "minzoom": meta.minzoom,
            "maxzoom": meta.maxzoom,
        }

    # ── GET /tiles/{z}/{x}/{y} ─────────────────────────────────────────────────

    @web_app.get("/tiles/{z}/{x}/{y}")
    async def tile(
        z: int,
        x: int,
        y: int,
        key: str = Query(...),
        _: None = Depends(_require_auth),
    ) -> Response:
        from rio_tiler.errors import TileOutsideBounds
        from rio_tiler.io import COGReader

        try:
            with rasterio.Env(**_gdal_env):
                with COGReader(_s3_url(key)) as cog:
                    img = cog.tile(x, y, z)
                    content = img.render(img_format="PNG")
        except TileOutsideBounds:
            # Transparent tile — MapLibre treats 204 as empty
            return Response(status_code=204)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        return Response(content=content, media_type="image/png")

    return web_app
