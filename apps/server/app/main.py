import asyncio
import logging
from contextlib import asynccontextmanager
from contextlib import suppress

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api.auth import router as auth_router
from .api.feedback import router as feedback_router
from .api.health import router as health_router
from .api.observations import router as observations_router
from .api.privacy import router as privacy_router
from .api.settings import router as settings_router
from .api.sessions import router as sessions_router
from .config import AppConfig
from .config import load_config
from .auth import LoopbackAuthenticator
from .core.personas import load_personas, resolve_persona
from .core.runtime_resources import RuntimeResources
from .privacy.domain_filter import load_sensitive_domain_rules
from .providers.embeddings.base import EmbeddingProvider
from .providers.judges.base import JudgeProvider
from .security import AuthenticatedApiMiddleware, LocalRequestSecurityMiddleware
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
    authenticator = LoopbackAuthenticator(
        enabled=config.server.auth_enabled,
        key_path=config.server.auth_key_path,
        pairing_code_path=config.server.pairing_code_path,
        timestamp_tolerance_seconds=config.server.auth_timestamp_tolerance_seconds,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        purged = store.purge_expired_data(config.privacy.retention_days)
        authenticator.initialize()
        logger = logging.getLogger("kibitzer")
        _log_purge(logger, purged.total)
        app.state.config = config
        app.state.store = store
        app.state.runtime = runtime
        app.state.authenticator = authenticator
        app.state.sensitive_domain_rules = load_sensitive_domain_rules(config.privacy.sensitive_domains_file)
        app.state.persona_set = _load_persona_set(config, logger)
        retention_task = asyncio.create_task(
            _retention_worker(store, config.privacy.retention_days, logger)
        )
        try:
            yield
        finally:
            retention_task.cancel()
            with suppress(asyncio.CancelledError):
                await retention_task

    app = FastAPI(
        title="Kibitzer Local Server",
        lifespan=lifespan,
        docs_url="/docs" if config.server.docs_enabled else None,
        redoc_url="/redoc" if config.server.docs_enabled else None,
        openapi_url="/openapi.json" if config.server.docs_enabled else None,
    )
    allowed_origins = {
        *config.server.allowed_origins,
        f"http://127.0.0.1:{config.server.port}",
        f"http://localhost:{config.server.port}",
    }
    app.add_middleware(AuthenticatedApiMiddleware, authenticator=authenticator)
    app.add_middleware(
        LocalRequestSecurityMiddleware,
        allowed_origins=allowed_origins,
        max_body_bytes=config.server.max_request_body_bytes,
    )
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=config.server.allowed_hosts,
        www_redirect=False,
    )
    app.include_router(auth_router)
    app.include_router(health_router)
    app.include_router(sessions_router)
    app.include_router(observations_router)
    app.include_router(feedback_router)
    app.include_router(settings_router)
    app.include_router(privacy_router)
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


async def _retention_worker(store: SQLiteStore, retention_days: int, logger: logging.Logger) -> None:
    while True:
        await asyncio.sleep(24 * 60 * 60)
        try:
            purged = await asyncio.to_thread(store.purge_expired_data, retention_days)
        except Exception:
            logger.exception("Periodic local activity retention failed")
            continue
        _log_purge(logger, purged.total)


def _log_purge(logger: logging.Logger, total: int) -> None:
    if total:
        logger.info("Purged %d expired local activity records", total)


app = create_app()
