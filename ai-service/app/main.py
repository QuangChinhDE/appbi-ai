"""
AI Chat service - FastAPI application entry point.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers.chat import router as chat_router

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"AI Chat service starting - provider={settings.llm_provider} model={settings.llm_model}")
    logger.info(f"BI backend: {settings.bi_api_url}")
    if settings.fallback_chain:
        logger.info(f"Fallback chain: {settings.fallback_chain}")
    yield
    from app.clients.bi_client import bi_client
    await bi_client.close()
    logger.info("AI Chat service stopped")


app = FastAPI(
    title="AppBI AI Chat Service",
    description="AI-powered chat assistant for the AppBI BI platform",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ai-chat",
        "provider": settings.llm_provider,
        "model": settings.llm_model,
    }
