-- AGENT FLOW V1 — PILOT FUNNEL. Read-only, from data the product already keeps.
--
-- WHY THIS IS SQL AND NOT AN ANALYTICS INTEGRATION.
--
-- Every number below already exists in `agent_flow_runs`, written by the runtime
-- on every turn: which flow, which version, which binding and link, whether the
-- turn was a test or a real reader, how it ended, what it cost, and the reader's
-- rating. Adding Segment/PostHog/Mixpanel would create a second source of truth
-- for facts the database already holds, and the two would disagree the first time
-- an event failed to send. The gap in the pilot was never storage; it was that
-- nobody had written the query.
--
-- WHY IT IS SAFE TO RUN AGAINST A PILOT DATABASE.
--
-- SELECT only. No DDL, no writes, no temp tables. Every scan is bounded either by
-- a time window or by a small GROUP BY over one table. It touches three tables and
-- reads no question text, no answer text and no session key, so running it does
-- not put a reader's words on an operator's screen.
--
-- HOW TO RUN IT.
--
--   docker exec -i appbi-ai-db-1 psql -U appbi -d appbi -f - < scripts/ops/pilot_funnel.sql
--
-- or, with the file already inside the container:
--
--   docker exec appbi-ai-db-1 psql -U appbi -d appbi -f /tmp/pilot_funnel.sql
--
-- NOT through `docker exec ... python`. The backend image derives DATABASE_URL in
-- `entrypoint.sh` and exports it into the server process only, so a shell opened
-- with `docker exec` has an EMPTY DATABASE_URL and any Python that imports
-- `app.core` dies on `create_engine('')`. That is why this report talks to the
-- database service directly.
--
-- WHAT `rating` MEANS. `up` / `down`, written by the reader's thumb on the answer.
-- NULL means the reader did not rate — which is most of them, and is the number
-- the pilot is trying to move.

\echo '== AGENT FLOW V1 — PILOT FUNNEL =='
\echo ''
\echo '-- Authoring: flows, versions, and what is actually live'

SELECT
    count(DISTINCT brain_key)                                        AS flows_total,
    count(DISTINCT brain_key) FILTER (WHERE status = 'published')    AS flows_published,
    count(*)                                                         AS versions_saved,
    count(*) FILTER (WHERE status = 'published')                     AS versions_published
FROM agent_brain_versions;

\echo ''
\echo '-- Activation: a published flow a reader can actually reach'

SELECT
    count(*)                                        AS bindings_total,
    count(*) FILTER (WHERE status = 'active')       AS bindings_active,
    count(*) FILTER (WHERE status = 'needs_review') AS bindings_needs_review,
    count(*) FILTER (WHERE status = 'broken')       AS bindings_broken,
    count(DISTINCT brain_key)                       AS flows_bound,
    count(DISTINCT dashboard_id)                    AS reports_with_an_assistant
FROM agent_flow_bindings;

\echo ''
\echo '-- Runs, all time. `is_test` separates an author trying it from a reader using it.'

SELECT
    count(*)                                              AS runs_total,
    count(*) FILTER (WHERE status = 'ok')                 AS runs_ok,
    count(*) FILTER (WHERE status = 'partial')            AS runs_partial,
    count(*) FILTER (WHERE status = 'failed')             AS runs_failed,
    count(*) FILTER (WHERE status = 'blocked')            AS runs_blocked,
    count(*) FILTER (WHERE is_test)                       AS runs_author_test,
    count(*) FILTER (WHERE NOT is_test)                   AS runs_reader,
    count(*) FILTER (WHERE NOT is_test AND link_token IS NOT NULL)
                                                          AS runs_public_link
FROM agent_flow_runs;

\echo ''
\echo '-- Runs, last 7 days'

SELECT
    count(*)                                   AS runs_7d,
    count(*) FILTER (WHERE status = 'ok')      AS ok_7d,
    count(*) FILTER (WHERE status = 'partial') AS partial_7d,
    count(*) FILTER (WHERE status = 'failed')  AS failed_7d,
    count(*) FILTER (WHERE status = 'blocked') AS blocked_7d,
    count(*) FILTER (WHERE NOT is_test)        AS reader_runs_7d
FROM agent_flow_runs
WHERE created_at >= now() - interval '7 days';

\echo ''
\echo '-- Feedback. `unrated` is the pilot number to move, not a defect.'

SELECT
    count(*)                                         AS runs_total,
    count(rating)                                    AS rated,
    count(*) FILTER (WHERE rating = 'up')            AS positive,
    count(*) FILTER (WHERE rating = 'down')          AS negative,
    count(*) FILTER (WHERE rating IS NULL)           AS unrated,
    count(rating) FILTER (WHERE NOT is_test)         AS rated_by_readers
FROM agent_flow_runs;

\echo ''
\echo '-- Reach: how many distinct reader sessions and authors the pilot has'

SELECT
    count(DISTINCT session_key) FILTER (WHERE NOT is_test AND session_key IS NOT NULL)
                                                     AS distinct_reader_sessions,
    count(DISTINCT link_token)  FILTER (WHERE link_token IS NOT NULL)
                                                     AS distinct_links_used
FROM agent_flow_runs;

SELECT count(DISTINCT created_by) AS distinct_authors FROM agent_brain_versions;

\echo ''
\echo '-- Top flows by run count (reader runs only)'

SELECT
    brain_key,
    count(*)                                   AS runs,
    count(*) FILTER (WHERE status = 'ok')      AS ok,
    count(rating)                              AS rated,
    count(*) FILTER (WHERE rating = 'down')    AS negative
FROM agent_flow_runs
WHERE NOT is_test
GROUP BY brain_key
ORDER BY runs DESC
LIMIT 10;

\echo ''
\echo '-- Where failures concentrate. Only flows with enough runs to mean anything.'

SELECT
    brain_key,
    count(*)                                                            AS runs,
    count(*) FILTER (WHERE status IN ('failed', 'blocked'))             AS bad,
    round(100.0 * count(*) FILTER (WHERE status IN ('failed', 'blocked'))
          / count(*), 1)                                                AS bad_pct
FROM agent_flow_runs
WHERE NOT is_test
GROUP BY brain_key
HAVING count(*) >= 5
ORDER BY bad_pct DESC, runs DESC
LIMIT 10;

\echo ''
\echo '-- Why runs were blocked. Structured reason, written by the runtime.'

SELECT
    coalesce(blocked_reason, '(none)') AS blocked_reason,
    count(*)                           AS runs
FROM agent_flow_runs
WHERE status = 'blocked'
GROUP BY blocked_reason
ORDER BY runs DESC
LIMIT 10;
