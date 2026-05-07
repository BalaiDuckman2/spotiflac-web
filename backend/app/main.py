from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import (
    download as api_download,
    history as api_history,
    jobs as api_jobs,
    library as api_library,
    logs as api_logs,
    modules as api_modules,
    preview as api_preview,
    settings as api_settings,
    status as api_status,
)
from .core.library import init_library
from .core.logs import emit_log, get_bus, install_log_bridge
from .core.queue import get_queue
from .core.worker import start_worker, stop_worker

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    install_log_bridge()
    get_bus().attach_loop(asyncio.get_running_loop())
    emit_log("info", "spotiflac-web starting")

    # Reclaim orphan jobs (not applicable here since queue is in-memory and
    # would be empty on cold start). Kept as a hook in case persistence is
    # added later.
    init_library()
    start_worker()
    emit_log("info", "worker started, library indexed")

    yield

    stop_worker()
    emit_log("info", "spotiflac-web stopping")


def create_app() -> FastAPI:
    app = FastAPI(title="SpotiFLAC Web", lifespan=lifespan)

    # API routers
    app.include_router(api_preview.router, prefix="/api")
    app.include_router(api_download.router, prefix="/api")
    app.include_router(api_jobs.router, prefix="/api")
    app.include_router(api_library.router, prefix="/api")
    app.include_router(api_history.router, prefix="/api")
    app.include_router(api_settings.router, prefix="/api")
    app.include_router(api_logs.router, prefix="/api")
    app.include_router(api_status.router, prefix="/api")
    app.include_router(api_modules.router, prefix="/api")

    @app.get("/api/health")
    def health():
        return {"ok": True}

    # Serve frontend (built React SPA) from /static, with SPA fallback to index.html
    if STATIC_DIR.exists():
        assets_dir = STATIC_DIR / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}")
        def spa_fallback(full_path: str):
            # /api/* are handled by routers above. For everything else, serve SPA.
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="Not Found")
            target = STATIC_DIR / full_path
            if full_path and target.is_file():
                return FileResponse(target)
            index = STATIC_DIR / "index.html"
            if index.exists():
                return FileResponse(index)
            raise HTTPException(status_code=404, detail="frontend not built")

    return app


app = create_app()
