from __future__ import annotations

import json

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from ..core.logs import get_bus

router = APIRouter()


@router.get("/logs")
def list_logs():
    return {"items": get_bus().history()}


@router.get("/logs/stream")
async def stream_logs():
    async def gen():
        async for event in get_bus().subscribe():
            yield {"data": json.dumps(event)}
    return EventSourceResponse(gen())
