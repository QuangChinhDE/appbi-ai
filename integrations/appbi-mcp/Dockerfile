# AppBI MCP integration — an independent service. It talks to AppBI only over
# HTTP and holds no AppBI database credentials or Core secrets.
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.lock ./
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-hashes --no-deps -r requirements.lock

FROM python:3.12-slim
ARG APPBI_MCP_BUILD_SHA=unknown
LABEL org.opencontainers.image.title="appbi-mcp" \
      org.opencontainers.image.revision="${APPBI_MCP_BUILD_SHA}"
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APPBI_MCP_BUILD_SHA=${APPBI_MCP_BUILD_SHA} \
    MCP_STATE_DIR=/data
RUN groupadd --system --gid 10001 appbi \
 && useradd --system --uid 10001 --gid appbi --no-create-home appbi \
 && mkdir -p /data && chown appbi:appbi /data
COPY --from=build /opt/venv /opt/venv
COPY --chown=root:root appbi_mcp /opt/app/appbi_mcp
WORKDIR /opt/app
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/mcp-oauth/healthz', timeout=2).status == 200 else 1)"]
# One process by design: OAuth state and per-grant rate limits live in this
# process and its SQLite volume. Scale vertically, not with replicas.
CMD ["python", "-m", "appbi_mcp"]
