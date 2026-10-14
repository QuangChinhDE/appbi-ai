-- READ-ONLY semantic foundation census. Run with:
--   psql <conn> -v ON_ERROR_STOP=1 -c 'set default_transaction_read_only=on' -f census.sql

-- 1. definitions whose numbers the numeric contract can change, per engine
-- foundation numeric contract can change, per engine of the view's table.
with v as (
  select sv.id, sv.name, sv.measures::json as ms, sv.dimensions::json as ds,
         coalesce(d.type::text, 'none') as engine
  from semantic_views sv
  left join dataset_tables t on t.id = sv.dataset_table_id
  left join data_sources d on d.id = t.datasource_id
),
m as (
  select v.engine, v.name as view_name, e->>'name' as mname, lower(coalesce(e->>'type','')) as mtype,
         coalesce(e->>'expression','') as expr, coalesce(e->>'sql','') as msql, coalesce(e->>'where_sql','') as wsql,
         json_typeof(e->'depends_on') = 'array' and json_array_length(e->'depends_on') > 0 as is_formula
  from v, json_array_elements(case when json_typeof(v.ms) = 'array' then v.ms else '[]'::json end) e
),
dd as (
  select v.engine, e->>'name' as dname, coalesce(e->>'sql','') as dsql
  from v, json_array_elements(case when json_typeof(v.ds) = 'array' then v.ds else '[]'::json end) e
)
select 'views' as what, engine, count(*) from v group by engine
union all select 'measures', engine, count(*) from m group by engine
union all select 'formula measures', engine, count(*) from m where is_formula group by engine
union all select 'formula with /', engine, count(*) from m where is_formula and expr like '%/%' group by engine
union all select 'row-level measure with /', engine, count(*) from m
  where not is_formula and (expr like '%/%' or msql like '%/%') group by engine
union all select 'where_sql with /', engine, count(*) from m where wsql like '%/%' group by engine
union all select 'dimension with /', engine, count(*) from dd where dsql like '%/%' group by engine
union all select 'avg measures', engine, count(*) from m where mtype = 'avg' group by engine
union all select 'percent_of_total', engine, count(*) from m where mtype = 'percent_of_total' group by engine
order by 1, 2;

-- 2. formula measures that divide (inspect integer SUM / COUNT dependencies on Postgres / MySQL)
with v as (
  select sv.id, sv.name, sv.measures::json as ms, coalesce(d.type::text, 'none') as engine, sv.dataset_table_id
  from semantic_views sv
  left join dataset_tables t on t.id = sv.dataset_table_id
  left join data_sources d on d.id = t.datasource_id
)
select v.engine, v.id, v.name, e->>'name' as mname, e->>'expression' as expr, (e->'depends_on')::text as deps,
       (select string_agg((x->>'name') || ':' || coalesce(x->>'type','') || ':' || coalesce(x->>'sql',''), ' ; ')
          from json_array_elements(v.ms) x
         where (e->'depends_on')::text like '%"' || (x->>'name') || '"%') as dep_defs
from v, json_array_elements(case when json_typeof(v.ms) = 'array' then v.ms else '[]'::json end) e
where json_typeof(e->'depends_on') = 'array' and json_array_length(e->'depends_on') > 0
  and coalesce(e->>'expression','') like '%/%'
order by 1, 2;

-- 3. formula measures with a dependency on ANOTHER view (newly refused, UNSUPPORTED_CONTEXT)
-- its model that start at its view, and the charts that use it.
with f as (
  select sv.id as view_id, sv.name as view_name, e->>'name' as mname, e->>'expression' as expr,
         d.value as dep
  from semantic_views sv,
       json_array_elements(case when json_typeof(sv.measures::json) = 'array' then sv.measures::json else '[]'::json end) e,
       json_array_elements_text(case when json_typeof(e->'depends_on') = 'array' then e->'depends_on' else '[]'::json end) d
  where position('.' in d.value) > 0 and split_part(d.value, '.', 1) <> sv.name
)
select f.view_id, f.view_name, f.mname, f.dep, f.expr,
       (select string_agg(x.id::text || ':' || x.base_view_name || '->' ||
                          coalesce((select string_agg((j->>'view') || '(' || coalesce(j->>'relationship', j->>'cardinality', '?') || ')', ',')
                                      from json_array_elements(x.joins::json) j), ''), ' | ')
          from semantic_explores x where x.base_view_id = f.view_id) as explores,
       (select count(*) from charts c
         where c.config::text like '%' || f.view_name || '.' || f.mname || '%') as charts_using
from f order by 1;

-- 4. datasets whose enabled tables span >1 datasource (a same-dialect pair: live statements across connections refused)
select t.dataset_id,
       count(distinct t.datasource_id) as n_ds,
       string_agg(distinct d.type::text, ',') as types,
       string_agg(distinct d.id::text, ',') as ds_ids,
       count(*) as n_tables,
       (select count(*) from charts c join dataset_tables ct on ct.id = c.dataset_table_id
         where ct.dataset_id = t.dataset_id) as n_charts
from dataset_tables t
join data_sources d on d.id = t.datasource_id
where coalesce(t.enabled, true)
group by t.dataset_id
having count(distinct t.datasource_id) > 1
order by 1;
