"""OAuth: discovery, connect binding, PKCE, refresh rotation, reuse/replay revocation, revocation."""

from __future__ import annotations

import json

import pytest
import sqlite3

from .conftest import MCP_HEADERS, PUBLIC, REDIRECT, connect, pkce, register, rpc


async def test_protected_resource_and_as_metadata(client):
    prm = (await client.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert prm["resource"] == f"{PUBLIC}/mcp"
    assert prm["authorization_servers"] == [f"{PUBLIC}/mcp-oauth"]
    assert "offline_access" not in prm["scopes_supported"]
    asm = (await client.get("/.well-known/oauth-authorization-server/mcp-oauth")).json()
    assert asm["issuer"] == f"{PUBLIC}/mcp-oauth"
    assert asm["code_challenge_methods_supported"] == ["S256"]
    # Claude uses CIMD only when both are advertised.
    assert asm["client_id_metadata_document_supported"] is True
    assert "none" in asm["token_endpoint_auth_methods_supported"]
    assert asm["authorization_response_iss_parameter_supported"] is True


async def test_unauthenticated_mcp_is_401_with_resource_metadata(client):
    r = await client.post("/mcp", json=rpc("whoami"), headers=MCP_HEADERS)
    assert r.status_code == 401
    www = r.headers["www-authenticate"]
    assert f'resource_metadata="{PUBLIC}/.well-known/oauth-protected-resource/mcp"' in www
    assert 'scope="appbi.read appbi.author appbi.publish"' in www


async def test_registration_refuses_foreign_redirects_and_accepts_offline_access(client):
    r = await client.post("/mcp-oauth/register", json={"redirect_uris": ["https://evil.example.com/cb"], "token_endpoint_auth_method": "none",
                                                       "grant_types": ["authorization_code"], "response_types": ["code"]})
    assert r.status_code == 400 and r.json()["error"] == "invalid_redirect_uri"
    r = await client.post("/mcp-oauth/register", json={"redirect_uris": ["https://claude.ai/api/mcp/auth_callback"], "token_endpoint_auth_method": "none",
                                                       "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
                                                       "scope": "appbi.read appbi.author appbi.publish offline_access"})
    assert r.status_code == 201, r.text


async def test_full_connect_flow_and_tool_call(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    assert set(tok["scope"].split()) == {"appbi.read", "appbi.author", "appbi.publish"}
    r = await client.post("/mcp", json=rpc("whoami"), headers={**MCP_HEADERS, "Authorization": f"Bearer {tok['access_token']}"})
    assert r.status_code == 200, r.text
    body = json.loads(r.json()["result"]["content"][0]["text"])
    assert body["user"]["email"] == "a@example.com"


async def test_loopback_redirect_matches_on_any_port(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    client_id = await register(client, "http://localhost:5000/callback")
    # Claude Code registers one port and comes back on another.
    tok = await connect(client, pat, client_id=client_id, redirect="http://localhost:6123/callback")
    assert tok["access_token"].startswith("amcp_at_")


async def test_callback_requires_the_browser_that_started_the_flow(client, fake_appbi):
    pat = fake_appbi.add_user("victim@example.com")
    client_id = await register(client)
    _, challenge = pkce()
    r = await client.get("/mcp-oauth/authorize", params={"client_id": client_id, "response_type": "code", "code_challenge": challenge,
                                                         "code_challenge_method": "S256", "redirect_uri": REDIRECT, "resource": f"{PUBLIC}/mcp"})
    start = r.headers["location"]
    txn = start.split("txn=")[1].split("&")[0]
    # The attacker never visits connect/start in the victim's browser: no binding cookie.
    client.cookies.clear()
    r = await client.post("/mcp-oauth/appbi-callback", data={"txn": txn, "decision": "allow", "pat": pat, "granted": "full"})
    assert r.status_code == 400
    assert ("GET", "/auth/me") not in fake_appbi.calls  # the PAT was never even used


async def test_foreign_resource_is_invalid_target(client):
    client_id = await register(client)
    _, challenge = pkce()
    r = await client.get("/mcp-oauth/authorize", params={"client_id": client_id, "response_type": "code", "code_challenge": challenge,
                                                         "code_challenge_method": "S256", "redirect_uri": REDIRECT, "state": "s",
                                                         "resource": "https://other.example.com/mcp"})
    assert r.status_code == 302 and "error=invalid_target" in r.headers["location"]


async def test_wrong_pkce_verifier_is_refused(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    # A second code for the same client, exchanged with the wrong verifier.
    r = await client.post("/mcp-oauth/token", data={"grant_type": "authorization_code", "code": tok["code"], "redirect_uri": REDIRECT,
                                                    "client_id": tok["client_id"], "code_verifier": "wrong" * 10})
    assert r.status_code == 400


async def test_code_replay_revokes_what_it_issued(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    r = await client.post("/mcp-oauth/token", data={"grant_type": "authorization_code", "code": tok["code"], "redirect_uri": REDIRECT,
                                                    "client_id": tok["client_id"], "code_verifier": tok["verifier"]})
    assert r.status_code == 400
    r = await client.post("/mcp", json=rpc("whoami"), headers={**MCP_HEADERS, "Authorization": f"Bearer {tok['access_token']}"})
    assert r.status_code == 401


async def test_refresh_rotates_and_reuse_revokes_the_family(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    r = await client.post("/mcp-oauth/token", data={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": tok["client_id"]})
    assert r.status_code == 200
    new = r.json()
    assert new["refresh_token"] != tok["refresh_token"]
    # The old access token stopped at rotation; the new one works.
    old = await client.post("/mcp", json=rpc("whoami"), headers={**MCP_HEADERS, "Authorization": f"Bearer {tok['access_token']}"})
    assert old.status_code == 401
    # Replaying the rotated refresh token kills the family, including the new tokens.
    r = await client.post("/mcp-oauth/token", data={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": tok["client_id"]})
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    r = await client.post("/mcp", json=rpc("whoami"), headers={**MCP_HEADERS, "Authorization": f"Bearer {new['access_token']}"})
    assert r.status_code == 401


async def test_revoked_appbi_pat_ends_the_connection(client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    fake_appbi.revoke(pat)
    h = {**MCP_HEADERS, "Authorization": f"Bearer {tok['access_token']}"}
    r = await client.post("/mcp", json=rpc("whoami"), headers=h)
    assert json.loads(r.json()["result"]["content"][0]["text"])["status"] == "credential_revoked"
    r = await client.post("/mcp", json=rpc("whoami"), headers=h)
    assert r.status_code == 401


@pytest.mark.parametrize("tool,args", [("execute_plan", {"plan_id": "plan_x"}), ("publish", {"plan_id": "plan_x"})])
async def test_read_only_grant_is_refused_by_the_tool_with_a_clear_message(client, fake_appbi, tool, args):
    """P8 (real Claude Desktop pilot): an HTTP 403 insufficient_scope is a step-up challenge;
    for a read-only grant no step-up can succeed and the Desktop bridge waited until it
    timed out. The call is refused by the tool layer instead: a normal result the user can
    read, and nothing reaches AppBI."""
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat, granted="read")
    assert tok["scope"] == "appbi.read"
    before = list(fake_appbi.calls)
    r = await client.post("/mcp", json=rpc(tool, args),
                          headers={**MCP_HEADERS, "Authorization": f"Bearer {tok['access_token']}"})
    assert r.status_code == 200 and "www-authenticate" not in r.headers
    out = json.loads(r.json()["result"]["content"][0]["text"])
    assert out["status"] == "insufficient_scope"
    assert out["message"].startswith("This AppBI connection has read-only access.")
    assert fake_appbi.calls == before          # refused before any AppBI request


async def test_an_invalid_token_is_still_a_401_challenge(client, fake_appbi):
    r = await client.post("/mcp", json=rpc("execute_plan", {"plan_id": "plan_x"}),
                          headers={**MCP_HEADERS, "Authorization": "Bearer not-a-token"})
    assert r.status_code == 401 and 'error="invalid_token"' in r.headers["www-authenticate"]


async def test_tokens_and_pats_are_not_stored_in_clear(app, client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    tok = await connect(client, pat)
    db = sqlite3.connect(app.state.ctx.store.path)
    dump = "\n".join(str(row) for table in ("grants", "tokens", "auth_codes", "auth_txns")
                     for row in db.execute(f"SELECT * FROM {table}"))
    db.close()
    for secret in (pat, tok["access_token"], tok["refresh_token"], tok["code"]):
        assert secret not in dump
