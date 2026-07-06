#!/usr/bin/env python
"""Mint an AppBI Personal Access Token and write it into .env — run once.

The MCP authenticates to AppBI with a PAT. A PAT cannot mint itself, so this
one-time helper logs in with an AppBI account (email + password) and creates
the token, then saves APPBI_PAT + APPBI_BASE_URL into .env so `run-mcp` just
works afterwards.

    python bootstrap_pat.py
    python bootstrap_pat.py --base-url http://localhost:8000 --email you@co.vn
    python bootstrap_pat.py --print-only        # don't touch .env, just show it

Everything can also be done from inside the MCP with the
bootstrap_personal_access_token tool; this CLI is for the pre-server / CI path.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

import appbi_wb_patkit as patkit

ROOT = Path(__file__).resolve().parent


def _prompt(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mint an AppBI PAT for the Workboard MCP.")
    parser.add_argument("--base-url", help="AppBI base URL, e.g. http://localhost:8000")
    parser.add_argument("--email", help="AppBI account email")
    parser.add_argument("--password", help="AppBI account password (omit to be prompted securely)")
    parser.add_argument("--name", default="workboard-mcp", help="Token label in AppBI")
    parser.add_argument("--expires-in-days", type=int, default=None, help="Optional expiry")
    parser.add_argument("--print-only", action="store_true", help="Print the token; do not write .env")
    parser.add_argument("--no-verify-tls", action="store_true", help="Skip TLS verification (self-signed dev)")
    args = parser.parse_args(argv)

    # Fill from flags -> existing .env/env -> interactive prompt.
    env_base = os.getenv("APPBI_BASE_URL")
    base_url = args.base_url or _prompt("AppBI base URL", env_base or "http://localhost:8000")
    email = args.email or _prompt("AppBI email")
    if not email:
        print("An email is required.", file=sys.stderr)
        return 2
    password = args.password or getpass.getpass("AppBI password: ")
    if not password:
        print("A password is required.", file=sys.stderr)
        return 2

    verify_tls = not args.no_verify_tls and str(
        os.getenv("APPBI_VERIFY_TLS") or "false"
    ).strip().lower() in {"1", "true", "yes", "y", "on"}

    print(f"Logging in to {base_url} and minting a PAT...")
    try:
        minted = patkit.mint_pat(
            base_url,
            email,
            password,
            name=args.name,
            expires_in_days=args.expires_in_days,
            verify_tls=verify_tls,
        )
    except (RuntimeError, ValueError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1

    token = minted["token"]
    api_base = minted["base_url"]
    print(f"  [ok] minted PAT {patkit.mask_token(token)} with scopes {minted['scopes']}")

    if args.print_only:
        print("\nAPPBI_PAT=" + token)
        print("APPBI_BASE_URL=" + api_base)
        print("\n(Not written to .env because --print-only was set.)")
        return 0

    path = patkit.upsert_env_vars(
        ROOT / ".env", {"APPBI_PAT": token, "APPBI_BASE_URL": api_base}
    )
    print(f"  [ok] wrote APPBI_PAT + APPBI_BASE_URL to {path}")
    print("\nDone. Start the server with run-mcp.ps1 / run-mcp.sh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
