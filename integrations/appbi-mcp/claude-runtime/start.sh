#!/bin/bash
# Fresh start of one pool runtime (home and /tmp are empty tmpfs here).
set -e
mkdir -p "$HOME/report"
# The public MCP's own origin, reachable as localhost inside the runtime (same URL as the
# viewer's browser sees, so the MCP's host checks pass unchanged).
socat TCP-LISTEN:${MCP_LOCAL_PORT:-18180},bind=127.0.0.1,fork,reuseaddr TCP:${MCP_UPSTREAM:-edge:80} &
exec python3 /opt/runtime/agent.py
