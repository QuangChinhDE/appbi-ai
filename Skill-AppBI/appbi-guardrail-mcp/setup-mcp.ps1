# One-time setup for the AppBI Engineering Guardrail MCP (Windows PowerShell).
# Creates the venv + installs deps. No PAT/.env required (read-only local analyzer).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv .venv }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { python -m venv .venv }
    else { Write-Error 'Python 3.10+ not found.'; exit 1 }
}
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')

Write-Host ''
Write-Host 'Setup complete. Register the MCP with your client, e.g. (.mcp.json / Claude):' -ForegroundColor Green
Write-Host @'
{
  "mcpServers": {
    "appbi-guardrail": {
      "command": "pwsh",
      "args": ["-File", "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-guardrail-mcp\\run-mcp.ps1"]
    }
  }
}
'@
Write-Host 'Smoke test:  .\.venv\Scripts\python.exe -c "import guardrail_core as c; print(c.get_module_boundaries()[''layers''][0])"'
