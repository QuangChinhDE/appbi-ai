"""In-process token buckets. The service runs as one process, so this is exact."""

from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, per_minute: int, burst: int | None = None):
        self.rate = per_minute / 60.0
        self.capacity = float(burst or max(1, per_minute))
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> tuple[bool, float]:
        """Return (allowed, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.rate)
            if tokens >= 1.0:
                self._buckets[key] = (tokens - 1.0, now)
                return True, 0.0
            self._buckets[key] = (tokens, now)
            return False, (1.0 - tokens) / self.rate if self.rate else 60.0


def client_ip(scope_headers: dict[str, str], peer: str | None) -> str:
    """nginx (on the host) sets X-Real-IP; only trust it from a private peer."""
    import ipaddress

    real = scope_headers.get("x-real-ip")
    if real and peer:
        try:
            if ipaddress.ip_address(peer).is_private or ipaddress.ip_address(peer).is_loopback:
                return real
        except ValueError:
            pass
    return peer or "unknown"
