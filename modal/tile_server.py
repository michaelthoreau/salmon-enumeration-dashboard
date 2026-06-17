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
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]", "rio-tiler[http]", "Pillow")
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

    def _s3_url(key: str, bucket: str | None = None) -> str:
        b = bucket or os.environ["S3_BUCKET_NAME"]
        return f"s3://{b}/{key}"

    # ── GET /info ──────────────────────────────────────────────────────────────

    @web_app.get("/info")
    async def info(
        key: str = Query(...),
        bucket: str | None = Query(None),
        _: None = Depends(_require_auth),
    ) -> dict:
        import time
        from rio_tiler.io import COGReader

        start_time = time.time()
        print(f"[INFO] Started metadata read for S3 key: {key}")
        with rasterio.Env(**_gdal_env):
            with COGReader(_s3_url(key, bucket)) as cog:
                meta = cog.info()
                bounds = list(cog.geographic_bounds)  # [W, S, E, N] in WGS-84

        duration = (time.time() - start_time) * 1000
        print(f"[INFO] Completed metadata read for S3 key: {key} in {duration:.1f}ms (bounds: {bounds}, minzoom: {meta.minzoom}, maxzoom: {meta.maxzoom})")
        return {
            "bounds": bounds,
            "minzoom": meta.minzoom,
            "maxzoom": meta.maxzoom,
        }

    # ── GET /preview ───────────────────────────────────────────────────────────

    @web_app.get("/preview")
    async def preview(
        key: str = Query(...),
        max_size: int = Query(256),
        bucket: str | None = Query(None),
        _: None = Depends(_require_auth),
    ) -> Response:
        import time
        from rio_tiler.io import COGReader

        start_time = time.time()
        print(f"[PREVIEW] Started preview for key: {key} (max_size: {max_size})")
        try:
            with rasterio.Env(**_gdal_env):
                with COGReader(_s3_url(key, bucket)) as cog:
                    read_start = time.time()
                    img = cog.preview(max_size=max_size)
                    read_duration = (time.time() - read_start) * 1000

                    render_start = time.time()
                    content = img.render(img_format="PNG")
                    render_duration = (time.time() - render_start) * 1000
        except Exception as exc:
            total_duration = (time.time() - start_time) * 1000
            print(f"[PREVIEW] Error generating preview for key: {key} after {total_duration:.1f}ms: {exc}")
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        total_duration = (time.time() - start_time) * 1000
        print(f"[PREVIEW] Completed preview for key: {key} in {total_duration:.1f}ms (COG read: {read_duration:.1f}ms, PNG render: {render_duration:.1f}ms)")
        return Response(content=content, media_type="image/png")

    # ── GET /tiles/{z}/{x}/{y} ─────────────────────────────────────────────────

    @web_app.get("/tiles/{z}/{x}/{y}")
    async def tile(
        z: int,
        x: int,
        y: int,
        key: str = Query(...),
        bucket: str | None = Query(None),
        _: None = Depends(_require_auth),
    ) -> Response:
        import time
        from rio_tiler.errors import TileOutsideBounds
        from rio_tiler.io import COGReader

        start_time = time.time()
        try:
            with rasterio.Env(**_gdal_env):
                with COGReader(_s3_url(key, bucket)) as cog:
                    read_start = time.time()
                    img = cog.tile(x, y, z)
                    read_duration = (time.time() - read_start) * 1000

                    render_start = time.time()
                    content = img.render(img_format="PNG")
                    render_duration = (time.time() - render_start) * 1000
        except TileOutsideBounds:
            # Transparent tile — MapLibre treats 204 as empty
            total_duration = (time.time() - start_time) * 1000
            # Logging 204s is useful but keep it minimal to avoid spam
            # We can log at debug/info level
            print(f"[TILE] Tile {z}/{x}/{y} outside bounds for key {key} (took {total_duration:.1f}ms) -> 204")
            return Response(status_code=204)
        except Exception as exc:
            total_duration = (time.time() - start_time) * 1000
            print(f"[TILE] Error loading tile {z}/{x}/{y} for key {key} after {total_duration:.1f}ms: {exc}")
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        total_duration = (time.time() - start_time) * 1000
        print(f"[TILE] Tile {z}/{x}/{y} loaded for key {key} in {total_duration:.1f}ms (COG read: {read_duration:.1f}ms, PNG render: {render_duration:.1f}ms)")
        return Response(content=content, media_type="image/png")

    # ── GET /diff-tiles/{z}/{x}/{y} ───────────────────────────────────────────

    @web_app.get("/diff-tiles/{z}/{x}/{y}")
    async def diff_tile(
        z: int,
        x: int,
        y: int,
        key1: str = Query(...),
        key2: str = Query(...),
        colormap: str = Query("red-green"),
        threshold: float = Query(15.0),
        max_diff: float = Query(120.0),
        bucket: str | None = Query(None),
        _: None = Depends(_require_auth),
    ) -> Response:
        import time
        from rio_tiler.errors import TileOutsideBounds
        from rio_tiler.io import COGReader
        import numpy as np
        from PIL import Image
        import io

        start_time = time.time()

        # Fetch Left Tile (key1)
        t1_start = time.time()
        try:
            with rasterio.Env(**_gdal_env):
                with COGReader(_s3_url(key1, bucket)) as cog1:
                    img1 = cog1.tile(x, y, z)
        except TileOutsideBounds:
            img1 = None
        except Exception as exc:
            total_duration = (time.time() - start_time) * 1000
            print(f"[DIFF_TILE] Error reading key1: {exc} after {total_duration:.1f}ms")
            raise HTTPException(status_code=500, detail=f"Error reading key1: {exc}") from exc
        t1_duration = (time.time() - t1_start) * 1000

        # Fetch Right Tile (key2)
        t2_start = time.time()
        try:
            with rasterio.Env(**_gdal_env):
                with COGReader(_s3_url(key2, bucket)) as cog2:
                    img2 = cog2.tile(x, y, z)
        except TileOutsideBounds:
            img2 = None
        except Exception as exc:
            total_duration = (time.time() - start_time) * 1000
            print(f"[DIFF_TILE] Error reading key2: {exc} after {total_duration:.1f}ms")
            raise HTTPException(status_code=500, detail=f"Error reading key2: {exc}") from exc
        t2_duration = (time.time() - t2_start) * 1000

        # If both are outside bounds, return transparent (empty tile)
        if img1 is None and img2 is None:
            total_duration = (time.time() - start_time) * 1000
            print(f"[DIFF_TILE] Tile {z}/{x}/{y} both outside bounds (took {total_duration:.1f}ms) -> 204")
            return Response(status_code=204)

        diff_start = time.time()
        # Standard width/height of tiles (typically 256)
        width = img1.width if img1 else img2.width
        height = img1.height if img1 else img2.height
        count = img1.count if img1 else img2.count

        # Extract data & masks
        if img1:
            data1 = img1.data.astype(np.float32)
            mask1 = img1.mask
        else:
            data1 = np.zeros((count, height, width), dtype=np.float32)
            mask1 = np.zeros((height, width), dtype=np.uint8)

        if img2:
            data2 = img2.data.astype(np.float32)
            mask2 = img2.mask
        else:
            data2 = np.zeros((count, height, width), dtype=np.float32)
            mask2 = np.zeros((height, width), dtype=np.uint8)

        # Convert to Grayscale
        if count >= 3:
            gray1 = 0.2989 * data1[0] + 0.5870 * data1[1] + 0.1140 * data1[2]
            gray2 = 0.2989 * data2[0] + 0.5870 * data2[1] + 0.1140 * data2[2]
        else:
            gray1 = data1[0]
            gray2 = data2[0]

        # Diff calculation: Right - Left
        diff = gray2 - gray1
        diff_abs = np.abs(diff)

        # Filter noise below threshold
        diff_sig = np.where(diff_abs < threshold, 0.0, diff)
        diff_sig_abs = np.abs(diff_sig)

        # Output mask: only show diff where both orthophotos overlap
        out_mask = ((mask1 > 0) & (mask2 > 0)).astype(np.uint8) * 255

        # Check if the output is completely transparent
        if not np.any(out_mask):
            total_duration = (time.time() - start_time) * 1000
            print(f"[DIFF_TILE] Tile {z}/{x}/{y} diff mask is fully transparent (took {total_duration:.1f}ms) -> 204")
            return Response(status_code=204)

        # Map to Alpha: opacity scales with diff magnitude
        alpha_channel = np.clip((diff_sig_abs / max_diff) * 255.0, 0, 255).astype(np.uint8)
        alpha_channel = np.minimum(alpha_channel, out_mask)

        # Map color channels based on selected colormap
        out_r = np.zeros((height, width), dtype=np.uint8)
        out_g = np.zeros((height, width), dtype=np.uint8)
        out_b = np.zeros((height, width), dtype=np.uint8)

        if colormap == "red-blue":
            out_r = np.where(diff_sig < 0, np.clip(100 + diff_sig_abs * 1.5, 0, 255), 0).astype(np.uint8)
            out_b = np.where(diff_sig > 0, np.clip(100 + diff_sig_abs * 1.5, 0, 255), 0).astype(np.uint8)
        elif colormap == "grayscale":
            val = np.clip(diff_sig_abs * 2.0, 0, 255).astype(np.uint8)
            out_r = val
            out_g = val
            out_b = val
        else:  # Default: red-green
            out_r = np.where(diff_sig < 0, np.clip(100 + diff_sig_abs * 1.5, 0, 255), 0).astype(np.uint8)
            out_g = np.where(diff_sig > 0, np.clip(100 + diff_sig_abs * 1.5, 0, 255), 0).astype(np.uint8)

        diff_duration = (time.time() - diff_start) * 1000

        # Merge channels into RGBA PNG
        png_start = time.time()
        rgba = np.stack([out_r, out_g, out_b, alpha_channel], axis=-1)
        pil_img = Image.fromarray(rgba, mode="RGBA")

        buf = io.BytesIO()
        pil_img.save(buf, format="PNG")
        content = buf.getvalue()
        png_duration = (time.time() - png_start) * 1000

        total_duration = (time.time() - start_time) * 1000
        print(f"[DIFF_TILE] Tile {z}/{x}/{y} diff for key1: {key1}, key2: {key2} finished in {total_duration:.1f}ms "
              f"(Read1: {t1_duration:.1f}ms, Read2: {t2_duration:.1f}ms, Calc: {diff_duration:.1f}ms, PNG: {png_duration:.1f}ms)")
        return Response(content=content, media_type="image/png")

    return web_app
