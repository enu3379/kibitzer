from fastapi import APIRouter, Request

from ..build_info import build_info

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    runtime = getattr(request.app.state, "runtime", None)
    status = runtime.status() if runtime else {"mode": "unknown", "active_since": None}
    tiers = runtime.tier_status() if runtime else {}
    provider_calls = runtime.provider_call_status() if runtime else {}
    return {
        "ok": True,
        "service": "kibitzer-server",
        **build_info(),
        **status,
        "tiers": tiers,
        "provider_calls": provider_calls,
    }
