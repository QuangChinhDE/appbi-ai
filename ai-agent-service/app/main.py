"""AI Agent service application entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.clients.bi_client import bi_client
from app.config import settings
from app.config import validate_security_settings
from app.routers.agent import router as agent_router

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Fail-fast if production uses insecure defaults
validate_security_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("AI Agent service starting")
    logger.info("BI backend: %s", settings.bi_api_url)
    logger.info(
        "Active LLM: provider=%s model=%s timeout=%ss",
        settings.active_llm_provider,
        settings.active_llm_model,
        settings.active_llm_timeout_seconds,
    )
    logger.info("AI report phase models: %s", settings.ai_agent_phase_models)
    if settings.active_llm_fallback_chain:
        logger.info("Active fallback chain: %s", settings.active_llm_fallback_chain)
    yield
    await bi_client.close()
    logger.info("AI Agent service stopped")


_is_dev = settings.environment.lower() in ("dev", "development", "test")

app = FastAPI(
    title="AppBI AI Agent",
    description="Autonomous dashboard report builder for AppBI",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _is_dev else None,
    redoc_url="/redoc" if _is_dev else None,
    openapi_url="/openapi.json" if _is_dev else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router)


@app.get("/health")
def health():
    # Only expose service name publicly; sensitive details (model, provider,
    # fallback chain, timeout) are omitted in production to prevent info leakage.
    if _is_dev:
        return {
            "status": "ok",
            "service": "ai-agent",
            "provider": settings.active_llm_provider,
            "model": settings.active_llm_model,
            "phase_models": settings.ai_agent_phase_models,
            "fallback_chain": settings.active_llm_fallback_chain,
            "timeout_seconds": settings.active_llm_timeout_seconds,
        }
    return {"status": "ok"}
