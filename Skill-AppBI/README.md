# Skill-AppBI

This folder keeps the AppBI skill assets and the AppBI MCP package together in one place, but they are intentionally independent.

## Structure

```text
Skill-AppBI/
├── excel-to-appbi-dashboard/   # Claude skill for generating AppBI Import Plan v1 HTML
├── appbi-import-mcp/           # MCP package for importing HTML into AppBI
└── excel-to-appbi-dashboard.zip
```

## Choose what you need

### 1. Skill only

Use [excel-to-appbi-dashboard](d:/Appv2/appbi-ai/Skill-AppBI/excel-to-appbi-dashboard).

Use this when you want Claude to generate AppBI-compatible HTML/metadata but do not want to run an MCP server.

### 2. MCP only

Use [appbi-import-mcp](d:/Appv2/appbi-ai/Skill-AppBI/appbi-import-mcp).

Use this when you already have AppBI-compatible HTML and want Claude/Desktop or another MCP client to import it into AppBI.

### 3. Both together

Use the skill to generate the HTML, then use the MCP to validate/import it.

## Configuration model

The MCP package follows an env-based configuration style similar to n8n MCP setups:

- AppBI base URL/domain is provided by the user
- AppBI personal access token is provided by the user
- configuration can point to either local or online AppBI

Examples:

- Local: `http://localhost:8000`
- Online: `https://bi.example.com`

The MCP package provides:

- `setup-mcp.ps1` and `setup-mcp.sh` to generate `.env`
- `.mcp.json.example` for env-driven MCP client configuration
- `claude_desktop_config.sample.json` for Claude Desktop style wiring

## Independence guarantee

- The skill does not require the MCP package.
- The MCP package does not require the skill to be installed.
- They are stored under the same parent folder only for repository organization.