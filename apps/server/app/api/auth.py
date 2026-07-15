from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import LoopbackAuthenticator, PairingError

router = APIRouter(prefix="/auth")


class PairingRequest(BaseModel):
    client_nonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    wrapped_secret: str = Field(pattern=r"^[0-9a-f]{64}$")
    tag: str = Field(pattern=r"^[0-9a-f]{64}$")


class PairingResponse(BaseModel):
    paired: bool
    proof: str


class AuthStatusResponse(BaseModel):
    enabled: bool
    paired: bool


def _authenticator(request: Request) -> LoopbackAuthenticator:
    return request.app.state.authenticator


@router.get("/status", response_model=AuthStatusResponse)
async def auth_status(request: Request) -> AuthStatusResponse:
    return AuthStatusResponse(**_authenticator(request).status())


@router.post("/pair", response_model=PairingResponse)
async def pair_extension(request: Request, body: PairingRequest) -> PairingResponse:
    try:
        proof = _authenticator(request).pair(
            client_nonce=body.client_nonce,
            wrapped_secret=body.wrapped_secret,
            tag=body.tag,
        )
    except PairingError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return PairingResponse(paired=True, proof=proof)
