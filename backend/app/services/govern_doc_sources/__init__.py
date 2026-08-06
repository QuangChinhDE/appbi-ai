"""External source connectors for Govern Knowledge Docs — Google Docs, uploaded
files (PDF/DOCX/XLSX), and crawled web pages. Kept separate from
`app.services.dashboard_ai_bot` because this is doc-authoring/ingestion, not
bot-retrieval logic; each fetcher is a pure `(...) -> {ok, text, error, ...}`
function that never raises, so callers (the sync service, API routes, the
scheduler) can treat every source type uniformly.
"""
