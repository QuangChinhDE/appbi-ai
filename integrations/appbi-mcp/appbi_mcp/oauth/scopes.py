"""MCP scopes and how they map onto AppBI PAT module caps.

MCP scopes are a ceiling the MCP enforces at its own boundary. AppBI still decides
every action with the user's live authority capped by the PAT (AppBI
`core/dependencies.py` applies min(user level, PAT cap) on every request).
"""

from __future__ import annotations

READ = "appbi.read"
AUTHOR = "appbi.author"
PUBLISH = "appbi.publish"
OFFLINE_ACCESS = "offline_access"

ALL_SCOPES = [READ, AUTHOR, PUBLISH]

# A broader scope implies the narrower ones (MCP authorization spec: servers MUST
# account for scope hierarchies).
_IMPLIES = {
    READ: {READ},
    AUTHOR: {AUTHOR, READ},
    PUBLISH: {PUBLISH, READ},
}

SCOPE_DESCRIPTIONS = {
    READ: "See your data sources, datasets and dashboards, and plan new ones",
    AUTHOR: "Create draft datasets, charts and dashboards that only you can see until published",
    PUBLISH: "Publish datasets and dashboards after you approve each publish in the browser",
}


def expand(scopes: list[str] | set[str]) -> set[str]:
    out: set[str] = set()
    for s in scopes:
        out |= _IMPLIES.get(s, set())
    return out


def satisfies(granted: list[str] | set[str], required: str) -> bool:
    return required in expand(granted)


def normalize(requested: list[str] | None) -> list[str]:
    """Unknown scopes are dropped; nothing requested means the full default set."""
    if not requested:
        return list(ALL_SCOPES)
    return [s for s in ALL_SCOPES if s in set(requested)]


def appbi_pat_scopes(mcp_scopes: list[str]) -> dict[str, str]:
    """The PAT module caps the AppBI connect page should request (a CEILING).

    The connect page lowers each cap to the user's own level before creating the
    PAT (and AppBI refuses a cap above it), so these never raise anyone's rights:
    an author with `edit` gets `edit` even when `full` is requested.

    * read    -> view everywhere
    * author  -> edit (drafts; on data sources only re-testing a saved source is
                 reachable through the allowlist)
    * publish -> full: AppBI requires full on the object to publish an AI Vibe
                 report or to share a resource; every such action still needs its
                 own browser approval
    """
    granted = set(mcp_scopes)
    level = "full" if PUBLISH in granted else "edit" if AUTHOR in granted else "view"
    return {"data_sources": "edit" if level != "view" else "view", "datasets": level,
            "explore_charts": level, "dashboards": level}
