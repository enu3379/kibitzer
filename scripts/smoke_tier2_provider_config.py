#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import sys

from apps.server.app.config import load_config
from apps.server.app.providers.judges.factory import create_tier2_judge_provider


def provider_label(provider: object) -> str:
    model = getattr(provider, "model", "<unknown>")
    api_url = getattr(provider, "api_url", None) or getattr(provider, "base_url", "<unknown>")
    return f"{provider.__class__.__name__} model={model} api_url={api_url}"


async def call_provider(provider: object) -> None:
    result = await provider.confirm_tier2(
        {
            "goal": "Verify Kibitzer Tier2 provider wiring",
            "current": {
                "title": "Cake recipe",
                "url_host": "example.com",
                "verdict": "DRIFT",
                "tier_reached": 0,
                "tier0_score": 0.1,
            },
            "recent": [{"title": "Kibitzer provider factory", "verdict": "OK"}],
            "page_excerpt": "This page explains cake frosting and oven temperature, unrelated to provider wiring.",
        }
    )
    if not isinstance(result.confirm_drift, bool):
        raise AssertionError("provider returned non-boolean confirm_drift")
    if result.confirm_drift and not result.message:
        raise AssertionError("confirmed drift must include a message")
    print(f"PASS real Tier2 provider call: confirm_drift={result.confirm_drift}")


def main() -> int:
    config = load_config()
    provider = create_tier2_judge_provider(config.tier2)
    if not provider:
        print("FAIL Tier2 provider is not configured", file=sys.stderr)
        return 1

    print(f"PASS Tier2 provider configured: {provider_label(provider)}")
    if "--call" in sys.argv:
        asyncio.run(call_provider(provider))
    else:
        print("PASS skipped real provider call; pass --call to exercise the network path")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
