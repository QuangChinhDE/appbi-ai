# AppBI Knowledge Domain Model

This file is the ownership and naming contract for Dataset, Semantic Model, and
Knowledge Hub. Backend models, API payloads, UI labels, graph edges, and AI
context must use the same meanings.

| Concept | Owner | Purpose | Dataset relationship |
| --- | --- | --- | --- |
| Dataset | Data product | Tables, transformations, dictionary, and publish lifecycle | Root executable asset |
| Semantic Model / View | Dataset | Joins, dimensions, and executable measures | One model per dataset; one view per table |
| Semantic Measure | Semantic View | Queryable aggregation or expression | Defined and executed inside a dataset |
| Governed KPI (`GovernMetric`) | Governance Registry | Shared business contract: meaning, target, owner, and lifecycle | Realized by zero or more semantic measures |
| Glossary Term | Governance Registry / Glossary | Shared company vocabulary | May classify fields, measures, KPIs, and documents |
| Data Caveat | Governance Registry | Mandatory warning for trustworthy interpretation | Scoped globally or to one dataset; never owned by it |
| Knowledge Document | Knowledge Hub | Narrative, policy, process, evidence, and RAG source | May explain and link datasets and governed entities |

## Invariants

1. Dataset pages author executable data and semantic definitions only.
2. Governance records are authored centrally. A `dataset_id` on a governance
   record means `applies to` or `is realized in`, never `belongs to`.
3. A governed KPI can be Approved only through certification and only when every
   declared realization resolves to an existing Semantic Measure. A dimension
   or a free-form string is not a valid realization.
4. Graph `realized_by` edges are emitted only for resolved bindings. Invalid
   legacy bindings remain visible as unresolved metadata and never become
   lineage.
5. Approved caveats bypass similarity ranking and are injected by scope.
   Knowledge Documents continue through the document-specific hybrid RAG
   pipeline.

## UI Placement

- `Dataset > Tables / Model`: tables, dictionary, relationships, dimensions,
  and Semantic Measures.
- `Knowledge Hub > Governance Registry`: Governed KPIs, Glossary Terms,
  classifications/tags, and Data Caveats.
- `Knowledge Graph`: relationships across reports, datasets, Semantic Measures,
  Governed KPIs, terms, caveats, and documents.
