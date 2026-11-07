"""Public Read MCP: a customer's own Claude reading ONE AppBI public link.

A separate trust boundary from the author MCP (`appbi_mcp.server`): its own process,
own state file and key, own OAuth resource (`/public-mcp`) and issuer
(`/public-mcp-oauth`). There is no AppBI user, no PAT and no write tool here. The
only credential it ever holds is the link-bound grant AppBI minted for one viewer
session of one public link, and AppBI re-checks that grant on every call.
"""
