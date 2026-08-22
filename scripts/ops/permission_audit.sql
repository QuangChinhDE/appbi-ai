-- WHO LOSES CONTROL OF THEIR OWN ROWS AFTER THIS DEPLOY.
--
-- The rule changed in exactly one case. Before: an owner got `full` on a row they
-- own, whatever their module level. After: an owner gets `min(module_level, full)`,
-- so `full` only when the module level is `edit` or above.
--
-- Every other combination is byte-for-byte identical:
--   owner + module edit/full   -> full   (unchanged)
--   shared edit + module view  -> view   (unchanged; the old code capped it too)
--   shared view                -> view   (unchanged)
--   no relation                -> none   (unchanged)
--
-- So the ONLY people affected are those holding `view` on a module while OWNING
-- rows in it. Creating any of those rows requires `edit`, so nobody reaches this
-- state by working normally — they reach it by being demoted afterwards, which is
-- the exact action the fix makes mean what it says.
--
-- RUN THIS ON PROD BEFORE DEPLOYING. Empty result = zero behaviour change for
-- every existing user, and the permission risk in the review is closed.

WITH owned AS (
    SELECT owner_id, 'dashboards'    AS module, count(*) AS rows_owned FROM dashboards     GROUP BY owner_id
    UNION ALL
    SELECT owner_id, 'explore_charts', count(*) FROM charts       GROUP BY owner_id
    UNION ALL
    SELECT owner_id, 'datasets',       count(*) FROM datasets     GROUP BY owner_id
    UNION ALL
    SELECT owner_id, 'data_sources',   count(*) FROM data_sources GROUP BY owner_id
    UNION ALL
    SELECT owner_id, 'workboards',     count(*) FROM workboards   GROUP BY owner_id
)
SELECT
    u.email,
    o.module,
    u.permissions ->> o.module            AS module_level_now,
    o.rows_owned,
    'full -> view (loses edit/delete/share on rows they own)' AS effect
FROM owned o
JOIN users u ON u.id = o.owner_id
-- `view` is the only level that changes. `none` already returned none; `edit` and
-- `full` still return full for an owner.
WHERE u.permissions ->> o.module = 'view'
  AND o.rows_owned > 0
ORDER BY o.rows_owned DESC, u.email;
