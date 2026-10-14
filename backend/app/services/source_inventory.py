"""Pre-deployment inventory of database sources against the outbound source policy.

    python -m app.services.source_inventory [--probe] [--json]
    (in the container: ``entrypoint.sh source-inventory [--probe]``)

Lists every PostgreSQL / MySQL data source and evaluates its host with the SAME
function the connector uses (``source_network_policy.resolve_and_check``) under
the CURRENT settings (``ALLOWED_PRIVATE_SOURCE_CIDRS`` /
``SOURCE_ALLOW_PRIVATE_NETWORK``). Nothing is relaxed here: a source the policy
refuses is reported as BLOCKED, and the exit status is non-zero, so a deployment
that would silently cut existing sources off stops before it starts.

``--probe`` additionally opens a TCP connection to the checked address (no
credentials, no query) to tell "allowed but unreachable from this host" apart.

Reads only ``id, name, type, config->host/port`` with raw SQL, so it runs against
the schema of the release being replaced as well as the new one. Never reads,
decrypts or prints a credential.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from dataclasses import asdict, dataclass

DB_TYPES = {"postgresql": 5432, "postgres": 5432, "mysql": 3306}

BLOCKED_EXIT = 4


@dataclass
class SourceVerdict:
    id: int
    name: str
    type: str
    host: str
    port: int | None
    verdict: str          # ALLOWED | BLOCKED | UNREACHABLE
    address: str | None = None
    reason: str | None = None


def evaluate(rows, *, check, probe=None) -> list[SourceVerdict]:
    """Pure core: ``rows`` are (id, name, type, config dict); ``check`` is the
    policy function (host, port) -> address or raises; ``probe`` optional
    (address, port) -> None or raises OSError."""
    out: list[SourceVerdict] = []
    for sid, name, stype, config in rows:
        t = str(stype or "").split(".")[-1].lower()
        if t not in DB_TYPES:
            continue
        cfg = config if isinstance(config, dict) else json.loads(config or "{}")
        host = str(cfg.get("host") or "")
        try:
            port = int(cfg.get("port") or DB_TYPES[t])
        except (TypeError, ValueError):
            port = DB_TYPES[t]
        v = SourceVerdict(id=sid, name=name, type=t, host=host, port=port, verdict="ALLOWED")
        try:
            v.address = check(host, port)
        except Exception as exc:  # the policy's own refusal message, never a credential
            v.verdict, v.reason = "BLOCKED", str(exc)
            out.append(v)
            continue
        if probe is not None:
            try:
                probe(v.address, port)
            except OSError as exc:
                v.verdict, v.reason = "UNREACHABLE", f"TCP {v.address}:{port}: {exc.__class__.__name__}"
        out.append(v)
    return out


def _tcp_probe(address: str, port: int) -> None:
    with socket.create_connection((address, port), timeout=5):
        pass


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return url
    from urllib.parse import quote
    return "postgresql+psycopg2://{u}:{p}@{h}:{port}/{d}".format(
        u=quote(os.environ.get("DB_USER", "appbi"), safe=""),
        p=quote(os.environ.get("DB_PASSWORD", ""), safe=""),
        h=os.environ.get("DB_HOST", "appbi-db"), port=os.environ.get("DB_PORT", "5432"),
        d=os.environ.get("DB_NAME", "appbi"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--probe", action="store_true", help="also TCP-connect to each allowed address")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    from sqlalchemy import create_engine, text
    from app.services.source_network_policy import resolve_and_check

    with create_engine(_database_url()).connect() as conn:
        rows = conn.execute(text(
            "SELECT id, name, type::text, config FROM data_sources ORDER BY id")).all()
    result = evaluate(rows, check=resolve_and_check, probe=_tcp_probe if args.probe else None)

    if args.json:
        print(json.dumps([asdict(v) for v in result], ensure_ascii=False))
    else:
        print(f"{'id':>5}  {'type':<10} {'verdict':<11} host:port -> address   name / reason")
        for v in result:
            print(f"{v.id:>5}  {v.type:<10} {v.verdict:<11} {v.host}:{v.port} -> {v.address or '-'}   "
                  f"{v.name}" + (f"  [{v.reason}]" if v.reason else ""))
    blocked = [v for v in result if v.verdict != "ALLOWED"]
    print(f"source inventory: {len(result)} database source(s), "
          f"{len(result) - len(blocked)} allowed, {len(blocked)} not usable", file=sys.stderr)
    return BLOCKED_EXIT if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
