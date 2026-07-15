from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel


router = APIRouter(prefix="/data")


class DeleteActivityRequest(BaseModel):
    confirm: Literal["DELETE"]


class DeleteActivityResponse(BaseModel):
    deleted: bool


@router.post("/delete", response_model=DeleteActivityResponse)
async def delete_activity_data(
    request: Request,
    body: DeleteActivityRequest,
) -> DeleteActivityResponse:
    del body
    async with request.app.state.browser_nav_lock:
        request.app.state.store.delete_all_activity_data()
    return DeleteActivityResponse(deleted=True)
