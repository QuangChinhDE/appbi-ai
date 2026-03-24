"""AI Agent service application entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.clients.bi_client import bi_client
from app.config import settings
from app.routers.agent import router as agent_router

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("AI Agent service starting")
    logger.info("BI backend: %s", settings.bi_api_url)
    yield
    await bi_client.close()
    logger.info("AI Agent service stopped")


app = FastAPI(
    title="AppBI AI Agent",
    description="Autonomous dashboard report builder for AppBI",
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

app.include_router(agent_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "ai-agent"}
