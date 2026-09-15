# Skill-AppBI

MCP servers that sit alongside AppBI. They are not part of the running product —
the stack in `docker-compose.yml` does not import anything here.

```text
Skill-AppBI/
└── appbi-guardrail-mcp/    read-only engineering guardrail for editing this codebase
```

## `appbi-guardrail-mcp`

An engineering-safety advisor: architecture layering, protected subsystems, impact
scope, required tests, and invariant checks on a diff — all answered from
`guardrail_rules.yaml`, never invented. It reads; it never writes code, calls the
AppBI API, or applies a fix.

It is **load-bearing for the development workflow**, not optional tooling:

- `scripts/ci/guardrail_check.py` imports `guardrail_core.py` directly
- `scripts/ci/verify.sh task` runs it on the working diff
- `.github/workflows/preflight.yml` runs `--health` on every push, so the rules
  cannot quietly stop describing the code
- `.claude/CLAUDE.md` and the scoped rules in `.claude/rules/` treat
  `guardrail_rules.yaml` as the source of truth for documented invariants

See [`appbi-guardrail-mcp/README.md`](appbi-guardrail-mcp/README.md) for the tool
list, the verdict model (`block` / `warn` / `ok` / `unknown`), and how to extend
the rules. To register it with an MCP client, copy
[`.mcp.example.json`](../.mcp.example.json) at the repo root.

You do not need the MCP server for the gates to work — `scripts/ci/guardrail_check.py`
runs the same rule base deterministically, which is what the hooks and CI use.

## Removed

`appbi-dashboard-mcp` and `appbi-workboard-mcp` were removed from the repository.
They were never imported by the product, and they are recoverable from git history:

```bash
git log --oneline --diff-filter=D -- Skill-AppBI/appbi-dashboard-mcp
git checkout <commit>^ -- Skill-AppBI/appbi-dashboard-mcp
```
