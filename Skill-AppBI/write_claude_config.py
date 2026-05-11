"""Write Claude Desktop config files with correct Windows backslash escaping.

Lesson learned 2026-05-11: passing backslash strings through inline Bash
heredoc + Python `-c` triple-escapes wrong. `\\A` in source becomes `\A`
which json.loads then turns into a single backslash + literal 'A' — but
the path also has `\a` which Python escape-decodes to BEL (\x07) BEFORE
JSON even sees it. Result: paths like "D:\\Appv2\\appbi-ai" silently
turned into "D:\\Appv2\x07ppbi-ai" and Claude Desktop choked.

This script uses raw strings + forward slashes (Windows accepts them in
command/args) so the escape problem cannot recur.
"""
import json
from pathlib import Path

PAT_LOCAL = "appbi_pat_4acc6f79cec14f0da0fba0b56d7bc324.pByQ0xH0y42PHqGY6NwXyQFg4Gs1QajFFU2rKP9LSk4"
PAT_HOSTED = "appbi_pat_41f3f5c133134ca58d28f8f8dd548b4b.D5D4l5X19HQK42ksmRRkXmfof7h1iGWQY4FxVp0crSI"
N8N_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkYmE3ZWI5NC02NDllLTQ2ZWItYTk2OC01Yzg5MWM0MTVjNmIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMjZmY2E4NDctYjdjNC00ODMxLTlkMzctZWQ5MjZmNzA4OTQ1IiwiaWF0IjoxNzc2NDE1NDIxLCJleHAiOjE3NzcwMDMyMDB9.JteVYSy59ZPfX64_3vOoU5-MXu5p-ZYFsMSY3x9bE_M"

config = {
    "mcpServers": {
        "powerbi-modeling": {
            "command": r"C:\nvm4w\nodejs\node_modules\@microsoft\powerbi-modeling-mcp\node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe",
            "args": ["--start"],
        },
        "appbi-import-source": {
            "command": r"D:\Appv2\appbi-ai\Skill-AppBI\appbi-import-source-mcp\dist\portable\appbi-source-import-mcp.exe",
            "env": {
                "APPBI_BASE_URL": "https://report.base-datateam.com/",
                "APPBI_PAT": PAT_HOSTED,
                "APPBI_VERIFY_TLS": "true",
            },
        },
        "n8n-mcp": {
            "command": r"C:\nvm4w\nodejs\node.exe",
            "args": [r"C:\nvm4w\nodejs\node_modules\n8n-mcp\dist\mcp\stdio-wrapper.js"],
            "env": {
                "MCP_MODE": "stdio",
                "LOG_LEVEL": "error",
                "DISABLE_CONSOLE_OUTPUT": "true",
                "N8N_API_URL": "https://n8n.base-datateam.com/",
                "N8N_API_KEY": N8N_KEY,
            },
        },
        "appbi-dashboard": {
            "command": r"D:\Appv2\appbi-ai\Skill-AppBI\appbi-dashboard-mcp\.venv\Scripts\python.exe",
            "args": [r"D:\Appv2\appbi-ai\Skill-AppBI\appbi-dashboard-mcp\appbi_orchestrator_mcp.py"],
            "env": {
                "APPBI_BASE_URL": "http://localhost:8000",
                "APPBI_PAT": PAT_LOCAL,
                "APPBI_TIMEOUT_SECONDS": "120",
                "APPBI_LONG_TIMEOUT_SECONDS": "300",
                "APPBI_VERIFY_TLS": "true",
                "APPBI_MCP_LOG_LEVEL": "INFO",
            },
        },
        "appbi-workboard": {
            "command": r"D:\Appv2\appbi-ai\Skill-AppBI\appbi-workboard-mcp\.venv\Scripts\python.exe",
            "args": [r"D:\Appv2\appbi-ai\Skill-AppBI\appbi-workboard-mcp\appbi_workboard_mcp.py"],
            "env": {
                "APPBI_BASE_URL": "http://localhost:8000",
                "APPBI_PAT": PAT_LOCAL,
                "APPBI_TIMEOUT_SECONDS": "120",
                "APPBI_MCP_LOG_LEVEL": "INFO",
            },
        },
    }
}

paths = [
    Path(r"C:\Users\Admin\AppData\Roaming\Claude\claude_desktop_config.json"),
    Path(r"C:\Users\Admin\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"),
]

text = json.dumps(config, indent=2, ensure_ascii=False)
for p in paths:
    p.write_text(text + "\n", encoding="utf-8", newline="\n")
    with open(p, "rb") as f:
        raw = f.read()
    parsed = json.loads(raw.decode("utf-8"))
    # Sanity: every command path must contain "appbi-ai" or "nodejs" or "powerbi", no \x07
    for name, srv in parsed["mcpServers"].items():
        cmd = srv["command"]
        assert "\x07" not in cmd, f"BELL in {name}: {cmd!r}"
        assert "\x0a" not in cmd, f"NEWLINE in {name}: {cmd!r}"
    print(f"OK {p.name} @ {p.parent} — {len(raw)} bytes, {len(parsed['mcpServers'])} servers")
    for name, srv in parsed["mcpServers"].items():
        print(f"   {name}: {srv['command']}")
