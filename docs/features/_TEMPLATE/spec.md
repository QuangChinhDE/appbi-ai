# <Feature> — spec

What the system does once this is built. Behaviour, not implementation.

## Behaviour

The main flow, step by step, from the user's first action to the result. Where the
behaviour differs by role, state, or data, say so here rather than leaving it implied.

## Data

New or changed tables, columns, and their types. Whether a migration is additive, what
backfill is needed, and what existing rows look like afterwards. If nothing changes, say
"no schema change" explicitly.

## API

| Method | Path | Auth / permission | Request | Response |
|---|---|---|---|---|
| | | | | |

Include the error responses, not only the happy path — and the permission gate on every
endpoint, including the ones that only read.

## UI

Surfaces touched, and for each: the loading, empty, error and success states. Match the
existing pattern on the sibling page rather than introducing a new one. Note anything
that must also work on the public or embed surface, which may only use `publicClient`.

## Permissions

Who can see it, who can change it, and what a user without access gets — an empty list
and a 403 are different answers and only one of them is honest. Name the module and the
levels involved.

## Edge cases

The cases that are easy to skip: empty data, one row, very many rows, a null, a deleted
parent, a filter that matches nothing, a viewer with partial access, a stale cache, both
SQL dialects where the change generates SQL.

## Non-goals

Behaviour someone might reasonably expect from this spec that is not included.
