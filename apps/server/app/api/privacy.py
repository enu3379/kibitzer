from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..storage.sqlite import SQLiteStore

router = APIRouter(prefix="/data")


class DeleteActivityRequest(BaseModel):
    confirm: Literal["DELETE"]


class DeleteActivityResponse(BaseModel):
    deleted: bool
    sessions: int
    events: int
    observations: int
    interventions: int
    feedback: int


@router.post("/delete", response_model=DeleteActivityResponse)
async def delete_all_activity(request: Request, body: DeleteActivityRequest) -> DeleteActivityResponse:
    del body
    store: SQLiteStore = request.app.state.store
    result = store.delete_all_activity_data()
    return DeleteActivityResponse(deleted=True, **result.__dict__)
