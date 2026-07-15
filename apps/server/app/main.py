import asyncio
import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api.data import router as data_router
from .api.feedback import router as feedback_router
from .api.health import router as health_router
from .api.observations import router as observations_router
from .api.settings import router as settings_router
from .api.sessions import router as sessions_router
from .config import AppConfig
from .config import load_config
from .core.personas import load_personas, resolve_persona
from .core.runtime_resources import RuntimeResources
from .core.security import OriginBoundaryMiddleware
from .privacy.domain_filter import load_sensitive_domain_rules
from .ports import identity_payload
from .providers.embeddings.base import EmbeddingProvider
from .providers.judges.base import JudgeProvider
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
    runtime = RuntimeResources(
        config=config,
        store=store,
        embedding_provider=embedding_provider,
        tier1_provider=tier1_provider,
        tier2_provider=tier2_provider,
    )
    instance_id = uuid4().hex

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        logger = logging.getLogger("kibitzer")
        app.state.config = config
        app.state.store = store
        app.state.runtime = runtime
        app.state.browser_nav_lock = asyncio.Lock()
        app.state.sensitive_domain_rules = load_sensitive_domain_rules(config.privacy.sensitive_domains_file)
        app.state.persona_set = _load_persona_set(config, logger)
        yield

    app = FastAPI(title="Kibitzer Local Server", lifespan=lifespan)
    app.add_middleware(
        OriginBoundaryMiddleware,
        allowed_extension_ids=config.security.allowed_extension_ids,
    )
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["127.0.0.1", "localhost"],
        www_redirect=False,
    )

    @app.get("/identity")
    async def identity() -> dict[str, str | int]:
        return identity_payload(instance_id)

    app.include_router(health_router)
    app.include_router(sessions_router)
    app.include_router(observations_router)
    app.include_router(feedback_router)
    app.include_router(settings_router)
    app.include_router(data_router)
    return app


def _load_persona_set(config: AppConfig, logger: logging.Logger):
    try:
        persona_set = load_personas(
            config.delivery.personas_file,
            user_path=config.delivery.custom_personas_file,
            logger=logger,
        )
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
