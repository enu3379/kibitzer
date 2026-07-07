from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "service": "kibitzer-server"}

