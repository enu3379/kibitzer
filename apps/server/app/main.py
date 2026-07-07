import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .api.feedback import router as feedback_router
from .api.health import router as health_router
from .api.observations import router as observations_router
from .api.settings import router as settings_router
from .api.sessions import router as sessions_router
from .config import AppConfig
from .config import load_config
from .core.personas import load_personas, resolve_persona
from .privacy.domain_filter import load_sensitive_domain_rules
from .providers.embeddings.base import EmbeddingProvider
from .providers.embeddings.factory import create_embedding_provider
from .providers.judges.base import JudgeProvider
from .providers.judges.factory import create_tier1_judge_provider, create_tier2_judge_provider
from .storage.sqlite import SQLiteStore


def create_app(
    config: AppConfig | None = None,
    store: SQLiteStore | None = None,
    embedding_provider: EmbeddingProvider | None = None,
    tier1_provider: JudgeProvider | None = None,
    tier2_provider: JudgeProvider | None = None,
) -> FastAPI:
    config = config or load_config()
    store = store or SQLiteStore(config.server.db_path)
    embedding_provider = embedding_provider or create_embedding_provider(config.embedding)
    tier1_provider = tier1_provider if tier1_provider is not None else create_tier1_judge_provider(config.tier1)
    tier2_provider = tier2_provider if tier2_provider is not None else create_tier2_judge_provider(config.tier2)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        logger = logging.getLogger("kibitzer")
        app.state.config = config
        app.state.store = store
        app.state.embedding_provider = embedding_provider
        app.state.tier1_provider = tier1_provider
        app.state.tier2_provider = tier2_provider
        app.state.sensitive_domain_rules = load_sensitive_domain_rules(config.privacy.sensitive_domains_file)
        app.state.persona_set = _load_persona_set(config, logger)
        # A tier that is enabled in config but has no resolvable provider degrades
        # silently at judge time; make the degradation visible at startup.
        for tier, enabled, provider in (
            (1, config.tier1.enabled, tier1_provider),
            (2, config.tier2.enabled, tier2_provider),
        ):
            if enabled and provider is None:
                logger.warning(
                    "Tier %d is enabled but no provider credentials resolved; running without it",
                    tier,
                )
                store.record_provider_degraded(tier=tier, reason="credentials_missing")
        yield

    app = FastAPI(title="Kibitzer Local Server", lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(sessions_router)
    app.include_router(observations_router)
    app.include_router(feedback_router)
    app.include_router(settings_router)
    return app


def _load_persona_set(config: AppConfig, logger: logging.Logger):
    try:
        persona_set = load_personas(config.delivery.personas_file)
    except Exception as exc:
        logger.warning(
            "Persona file %s could not be loaded (%s); using built-in Tier 2 prompt",
            config.delivery.personas_file,
            type(exc).__name__,
        )
        return None

    if not resolve_persona(persona_set, {}, config.delivery.persona):
        logger.warning(
            "No configured persona key resolved from %s; using built-in Tier 2 prompt",
            config.delivery.personas_file,
        )
        return None
    return persona_set


app = create_app()
