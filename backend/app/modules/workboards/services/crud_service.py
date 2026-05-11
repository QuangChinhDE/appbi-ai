"""CRUD service for Workboard mini-apps."""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.logging import get_logger
from app.models import DataSource
from app.models.dataset import DatasetTable
from app.modules.workboards.models import Workboard, WorkboardAppUser, WorkboardSubmission
from app.modules.workboards.roles import (
    APP_USER_ROLE_OWNER,
    DEFAULT_APP_USER_PIN,
    build_default_owner_username,
)
from app.modules.workboards.schemas import (
    LayoutJson,
    WorkboardCreate,
    WorkboardUpdate,
)
from app.modules.workboards.services.app_user_service import hash_pin
from app.services.dataset_model_service import get_dataset_model
from app.services.datasource_service import DataSourceConnectionService

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Layout normalisation
# ---------------------------------------------------------------------------

def _normalize_layout(payload, *, primary_table_id: Optional[int] = None) -> dict:
    """Coerce the layout payload into a canonical dict for storage.

    Unknown keys are stripped by ``LayoutJson`` so the mini-app shape is
    the only thing that survives in ``layout_json``.
    """
    if payload is None:
        return LayoutJson().model_dump(mode="json")
    if isinstance(payload, LayoutJson):
        return payload.model_dump(mode="json")
    if isinstance(payload, dict):
        return LayoutJson.model_validate(payload).model_dump(mode="json")
    return LayoutJson.model_validate(payload).model_dump(mode="json")


def _columns_cache_list(table: DatasetTable) -> List[Dict[str, Any]]:
    cache = table.columns_cache
    if isinstance(cache, dict):
        raw = cache.get("columns")
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
    if isinstance(cache, list):
        return [item for item in cache if isinstance(item, dict)]
    return []


def _parse_source_table_name(source_table_name: Optional[str], datasource: Optional[DataSource]) -> Tuple[str, str]:
    raw = str(source_table_name or "").strip().strip('"').strip("`")
    if "." in raw:
        schema_name, table_name = raw.split(".", 1)
        return schema_name.strip('"').strip("`"), table_name.strip('"').strip("`")
    config = datasource.config or {} if datasource else {}
    default_schema = (
        config.get("schema_name")
        or config.get("schema")
        or config.get("database")
        or "public"
    )
    return str(default_schema), raw


def _introspect_columns(db: Session, table: DatasetTable) -> List[Dict[str, Any]]:
    cached = _columns_cache_list(table)
    datasource = (
        db.query(DataSource)
        .filter(DataSource.id == table.datasource_id)
        .first()
    ) if table.datasource_id else None
    if table.source_kind != "physical_table" or datasource is None:
        return cached
    try:
        schema_name, table_name = _parse_source_table_name(table.source_table_name, datasource)
        ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
        detail = DataSourceConnectionService.get_table_detail(
            ds_type,
            datasource.config or {},
            schema_name,
            table_name,
            preview_rows=1,
        )
        raw = detail.get("columns")
        if isinstance(raw, list) and raw:
            return [item for item in raw if isinstance(item, dict)]
    except Exception:
        logger.warning("Workboard schema introspection fallback to cache for table %s", table.id, exc_info=True)
    return cached


def _humanize(name: str) -> str:
    text = re.sub(r"[_\s]+", " ", str(name or "")).strip()
    return text[:1].upper() + text[1:] if text else ""


def _infer_primary_key_columns(
    columns: List[Dict[str, Any]],
    requested: Optional[List[str]] = None,
) -> List[str]:
    names = [str(item.get("name") or "").strip() for item in columns if item.get("name")]
    name_set = {name for name in names if name}
    requested = [str(item).strip() for item in (requested or []) if str(item).strip()]
    if requested:
        valid = [item for item in requested if item in name_set]
        if valid:
            return valid
    flagged = [
        str(item.get("name"))
        for item in columns
        if item.get("name") and bool(item.get("is_primary_key"))
    ]
    if flagged:
        return flagged
    if "id" in name_set:
        return ["id"]
    singulars = set()
    for name in names:
        base = name.split(".")[-1]
        singulars.add(base)
        if base.endswith("s") and not base.endswith("ss"):
            singulars.add(base[:-1])
    for candidate in names:
        if candidate.endswith("_id"):
            stem = candidate[:-3]
            if stem in singulars:
                return [candidate]
    for candidate in names:
        if candidate.endswith("_id"):
            return [candidate]
    return [names[0]] if names else []


def _pick_label_column(columns: List[Dict[str, Any]], pk_columns: List[str]) -> Optional[str]:
    preferred_types = {"string", "text", "character varying", "varchar"}
    for item in columns:
        name = str(item.get("name") or "")
        if not name or name in pk_columns:
            continue
        low_type = str(item.get("type") or "").lower()
        if any(token in low_type for token in preferred_types):
            return name
    for item in columns:
        name = str(item.get("name") or "")
        if name and name not in pk_columns:
            return name
    return pk_columns[0] if pk_columns else None


def _field_widget(column: Dict[str, Any], *, is_lookup: bool) -> str:
    if is_lookup:
        return "lookup"
    low_type = str(column.get("type") or "").lower()
    name = str(column.get("name") or "").lower()
    if "bool" in low_type:
        return "checkbox"
    if "timestamp" in low_type or "datetime" in low_type:
        return "datetime"
    if low_type == "date":
        return "date"
    if any(token in low_type for token in ("int", "numeric", "decimal", "float", "double", "real", "number")):
        return "number"
    if "text" in low_type and len(name) > 0:
        return "textarea"
    return "text"


def _pick_view_label_column(view: Dict[str, Any], to_column: str) -> str:
    dimensions = [item for item in (view.get("dimensions") or []) if isinstance(item, dict)]
    for item in dimensions:
        field_name = str(item.get("name") or "")
        field_type = str(item.get("type") or "").lower()
        if field_name and field_name != to_column and field_type in {"string", "date", "datetime"}:
            return field_name
    return to_column


def _resolve_related_tables(
    db: Session,
    *,
    dataset_id: int,
    primary_table_id: int,
    primary_columns: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    model = get_dataset_model(db, dataset_id)
    if not isinstance(model, dict):
        return [], [], {}

    view_by_name = {
        str(view.get("name")): view
        for view in (model.get("views") or [])
        if isinstance(view, dict) and view.get("name")
    }
    primary_view_names = {
        str(view.get("name"))
        for view in (model.get("views") or [])
        if isinstance(view, dict) and view.get("dataset_table_id") == primary_table_id
    }
    if not primary_view_names:
        return [], [], {}

    refs: List[Dict[str, Any]] = []
    lookup_tables: List[Dict[str, Any]] = []
    related_tables: Dict[str, Dict[str, Any]] = {}
    seen_ref_ids: set[str] = set()
    primary_col_names = {str(item.get("name")) for item in primary_columns if item.get("name")}

    for explore in (model.get("explores") or []):
        if not isinstance(explore, dict):
            continue
        if str(explore.get("base_view_name") or "") not in primary_view_names:
            continue
        for join in (explore.get("joins") or []):
            if not isinstance(join, dict):
                continue
            from_column = str(join.get("from_column") or "").strip()
            if not from_column or from_column not in primary_col_names:
                continue
            target_view = view_by_name.get(str(join.get("view") or ""))
            target_table_id = target_view.get("dataset_table_id") if isinstance(target_view, dict) else None
            to_column = str(join.get("to_column") or "").strip()
            if not target_table_id or not to_column:
                continue
            table_key = f"lookup_{target_table_id}"
            if table_key not in related_tables:
                related_tables[table_key] = {
                    "id": table_key,
                    "table_id": int(target_table_id),
                    "label": target_view.get("table_display_name") or target_view.get("name") or f"Table {target_table_id}",
                    "icon": "Table",
                    "pk": [to_column],
                    "label_column": _pick_view_label_column(target_view, to_column),
                    "column_config": {},
                }
            ref_id = f"ref_{from_column}_{target_table_id}_{to_column}"
            if ref_id in seen_ref_ids:
                continue
            seen_ref_ids.add(ref_id)
            refs.append(
                {
                    "id": ref_id,
                    "from_table": "primary",
                    "from_column": from_column,
                    "to_table": table_key,
                    "to_column": to_column,
                    "cardinality": "many_to_one",
                }
            )
            lookup_tables.append(
                {
                    "column": from_column,
                    "table_id": int(target_table_id),
                    "value_column": to_column,
                    "label_column": related_tables[table_key]["label_column"],
                    "label": related_tables[table_key]["label"],
                }
            )
    return refs, lookup_tables, related_tables


def _apply_default_layout(
    raw_layout: Dict[str, Any],
    *,
    primary_table_id: int,
    columns: List[Dict[str, Any]],
    primary_key_columns: List[str],
    refs: List[Dict[str, Any]],
    lookup_tables: List[Dict[str, Any]],
    related_tables: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Return a mini-app layout for storage.

    The mini-app contract puts everything (form/list/doc + RLS) on screens
    so this function no longer fabricates any default screens — empty
    workboards start with an empty ``screens`` list and the builder/UI
    creates them on demand. We just preserve whatever the caller provided
    and let ``LayoutJson`` strip unknown keys.
    """
    return _normalize_layout(raw_layout, primary_table_id=primary_table_id)


def _prepare_schema_defaults(
    db: Session,
    *,
    dataset_id: int,
    primary_table_id: int,
    requested_pk_columns: Optional[List[str]],
    raw_layout: Any,
) -> Tuple[List[str], List[Dict[str, Any]], Dict[str, Any]]:
    table = (
        db.query(DatasetTable)
        .filter(DatasetTable.id == primary_table_id)
        .first()
    )
    if not table:
        raise ValueError("Primary table not found")
    if table.dataset_id != dataset_id:
        raise ValueError("Primary table does not belong to the selected dataset")
    columns = _introspect_columns(db, table)
    primary_key_columns = _infer_primary_key_columns(columns, requested=requested_pk_columns)
    refs, lookup_tables, related_tables = _resolve_related_tables(
        db,
        dataset_id=dataset_id,
        primary_table_id=primary_table_id,
        primary_columns=columns,
    )
    layout_json = _apply_default_layout(
        raw_layout,
        primary_table_id=primary_table_id,
        columns=columns,
        primary_key_columns=primary_key_columns,
        refs=refs,
        lookup_tables=lookup_tables,
        related_tables=related_tables,
    )
    return primary_key_columns, lookup_tables, layout_json


def _pick_first_physical_table(db: Session, dataset_id: int) -> int:
    first_physical = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.source_kind == "physical_table",
        )
        .order_by(DatasetTable.id.asc())
        .first()
    )
    if not first_physical:
        raise ValueError(
            "Dataset has no physical tables - workboards need at least one "
            "physical table to anchor the layout. Add a table to the dataset first."
        )
    return int(first_physical.id)


def _dataset_table_ids(db: Session, dataset_id: int) -> set[int]:
    rows = db.query(DatasetTable.id).filter(DatasetTable.dataset_id == dataset_id).all()
    return {int(row[0]) for row in rows}


def _clear_layout_table_refs_not_in_dataset(
    raw_layout: Any,
    valid_table_ids: set[int],
) -> Dict[str, Any]:
    """Clear stale table ids after rebinding a workboard to another dataset."""
    if raw_layout is None:
        layout: Dict[str, Any] = {}
    elif isinstance(raw_layout, LayoutJson):
        layout = raw_layout.model_dump(mode="json")
    elif isinstance(raw_layout, dict):
        layout = copy.deepcopy(raw_layout)
    else:
        layout = LayoutJson.model_validate(raw_layout).model_dump(mode="json")

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key in list(node.keys()):
                value = node[key]
                if key == "table_id" and isinstance(value, int):
                    if value not in valid_table_ids:
                        node[key] = None
                elif key == "source" and isinstance(value, str) and value.startswith("lookup:"):
                    try:
                        ref_table_id = int(value.split(":", 1)[1])
                    except ValueError:
                        continue
                    if ref_table_id not in valid_table_ids:
                        node[key] = "primary"
                else:
                    _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(layout)
    return layout


class WorkboardService:
    """Service layer for Workboard CRUD. All methods are static."""

    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Workboard]:
        return (
            db.query(Workboard)
            .order_by(Workboard.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    @staticmethod
    def get_by_id(db: Session, workboard_id: int) -> Optional[Workboard]:
        return (
            db.query(Workboard)
            .filter(Workboard.id == workboard_id)
            .first()
        )

    @staticmethod
    def get_by_slug(db: Session, slug: str) -> Optional[Workboard]:
        if not slug:
            return None
        return db.query(Workboard).filter(Workboard.slug == slug).first()

    @staticmethod
    def slug_exists(
        db: Session, slug: str, *, exclude_id: Optional[int] = None
    ) -> bool:
        if not slug:
            return False
        query = db.query(Workboard.id).filter(Workboard.slug == slug)
        if exclude_id is not None:
            query = query.filter(Workboard.id != exclude_id)
        return db.query(query.exists()).scalar() is True

    @staticmethod
    def create(
        db: Session,
        payload: WorkboardCreate,
        owner_id=None,
    ) -> Workboard:
        if payload.slug and WorkboardService.slug_exists(db, payload.slug):
            raise ValueError(f"Workboard slug '{payload.slug}' already exists")

        # Auto-resolve primary_table_id when the caller didn't specify one.
        # The mini-app contract assigns table_id per screen, so the workboard
        # itself only needs *any* physical table from the chosen dataset to
        # satisfy the FK + legacy v1 form code paths.
        primary_table_id = payload.primary_table_id
        if primary_table_id is None:
            primary_table_id = _pick_first_physical_table(db, payload.dataset_id)

        (
            primary_key_columns,
            lookup_tables,
            layout_json,
        ) = _prepare_schema_defaults(
            db,
            dataset_id=payload.dataset_id,
            primary_table_id=primary_table_id,
            requested_pk_columns=payload.primary_key_columns,
            raw_layout=payload.layout_json,
        )

        db_obj = Workboard(
            name=payload.name,
            slug=payload.slug,
            description=payload.description,
            icon=payload.icon,
            dataset_id=payload.dataset_id,
            primary_table_id=primary_table_id,
            primary_key_columns=primary_key_columns,
            lookup_tables=lookup_tables,
            layout_json=layout_json,
            optimistic_lock_column=payload.optimistic_lock_column,
            is_published=False,
            version=1,
            owner_id=owner_id,
        )
        db.add(db_obj)
        try:
            db.flush()

            default_owner_username = build_default_owner_username(db_obj.id)
            db.add(
                WorkboardAppUser(
                    workboard_id=db_obj.id,
                    username=default_owner_username,
                    pin_hash=hash_pin(DEFAULT_APP_USER_PIN),
                    role=APP_USER_ROLE_OWNER,
                    active=True,
                    context={},
                )
            )
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"Workboard could not be created: {exc.orig}") from exc
        db.refresh(db_obj)
        setattr(
            db_obj,
            "_default_app_user",
            {
                "username": default_owner_username,
                "pin": DEFAULT_APP_USER_PIN,
            },
        )
        logger.info(
            "Created workboard id=%s name=%s dataset=%s table=%s",
            db_obj.id,
            db_obj.name,
            db_obj.dataset_id,
            db_obj.primary_table_id,
        )
        return db_obj

    @staticmethod
    def update(
        db: Session,
        workboard_id: int,
        payload: WorkboardUpdate,
    ) -> Optional[Workboard]:
        db_obj = WorkboardService.get_by_id(db, workboard_id)
        if not db_obj:
            return None

        update_data = payload.model_dump(exclude_unset=True)

        if "slug" in update_data:
            new_slug = update_data["slug"]
            if new_slug and WorkboardService.slug_exists(
                db, new_slug, exclude_id=workboard_id
            ):
                raise ValueError(f"Workboard slug '{new_slug}' already exists")

        schema_binding_changed = (
            "dataset_id" in update_data or "primary_table_id" in update_data
        )
        target_dataset_id = int(update_data.get("dataset_id") or db_obj.dataset_id)
        target_primary_table_id = update_data.get("primary_table_id")
        if schema_binding_changed and target_primary_table_id is None:
            target_primary_table_id = _pick_first_physical_table(db, target_dataset_id)
        if target_primary_table_id is None:
            target_primary_table_id = db_obj.primary_table_id
        target_primary_table_id = int(target_primary_table_id)

        should_refresh_schema = (
            ("layout_json" in update_data and update_data["layout_json"] is not None)
            or schema_binding_changed
        )
        if should_refresh_schema:
            raw_layout = update_data.get("layout_json")
            if raw_layout is None:
                raw_layout = db_obj.layout_json or {}
            if schema_binding_changed:
                raw_layout = _clear_layout_table_refs_not_in_dataset(
                    raw_layout,
                    _dataset_table_ids(db, target_dataset_id),
                )
            (
                refreshed_pk,
                refreshed_lookups,
                refreshed_layout,
            ) = _prepare_schema_defaults(
                db,
                dataset_id=target_dataset_id,
                primary_table_id=target_primary_table_id,
                requested_pk_columns=list(db_obj.primary_key_columns or []),
                raw_layout=raw_layout,
            )
            update_data["dataset_id"] = target_dataset_id
            update_data["primary_table_id"] = target_primary_table_id
            update_data["layout_json"] = refreshed_layout
            update_data["primary_key_columns"] = refreshed_pk
            update_data["lookup_tables"] = refreshed_lookups

        for key, value in update_data.items():
            setattr(db_obj, key, value)

        # Bump structural version when the layout actually changes.
        if "layout_json" in update_data:
            db_obj.version = (db_obj.version or 1) + 1

        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"Workboard could not be updated: {exc.orig}") from exc
        db.refresh(db_obj)
        logger.info("Updated workboard id=%s", workboard_id)
        return db_obj

    @staticmethod
    def refresh_schema_defaults(db: Session, workboard: Workboard) -> Workboard:
        primary_key_columns, lookup_tables, layout_json = _prepare_schema_defaults(
            db,
            dataset_id=workboard.dataset_id,
            primary_table_id=workboard.primary_table_id,
            requested_pk_columns=list(workboard.primary_key_columns or []),
            raw_layout=workboard.layout_json or {},
        )
        workboard.primary_key_columns = list(primary_key_columns)
        workboard.lookup_tables = list(lookup_tables)
        workboard.layout_json = layout_json
        db.commit()
        db.refresh(workboard)
        return workboard

    @staticmethod
    def delete(db: Session, workboard_id: int) -> bool:
        db_obj = WorkboardService.get_by_id(db, workboard_id)
        if not db_obj:
            return False
        db.delete(db_obj)
        db.commit()
        logger.info("Deleted workboard id=%s", workboard_id)
        return True

    @staticmethod
    def update_introspection_cache(
        db: Session,
        workboard: Workboard,
        *,
        primary_key_columns: Optional[List[str]] = None,
        lookup_tables: Optional[List[dict]] = None,
    ) -> Workboard:
        """Refresh the cached schema metadata after introspection."""
        if primary_key_columns is not None:
            workboard.primary_key_columns = list(primary_key_columns)
        if lookup_tables is not None:
            workboard.lookup_tables = list(lookup_tables)
        db.commit()
        db.refresh(workboard)
        return workboard

    @staticmethod
    def record_submission(
        db: Session,
        *,
        workboard: Workboard,
        action: str,
        table_name: str,
        row_pk: Optional[dict],
        payload: Optional[dict],
        validation_warnings: Optional[List[dict]] = None,
        user_id=None,
    ) -> WorkboardSubmission:
        submission = WorkboardSubmission(
            workboard_id=workboard.id,
            action=action,
            table_name=table_name,
            row_pk=row_pk,
            payload=payload,
            validation_warnings=validation_warnings or [],
            user_id=user_id,
        )
        db.add(submission)
        db.commit()
        db.refresh(submission)
        return submission

    @staticmethod
    def list_submissions(
        db: Session,
        workboard_id: int,
        *,
        skip: int = 0,
        limit: int = 100,
    ) -> List[WorkboardSubmission]:
        return (
            db.query(WorkboardSubmission)
            .filter(WorkboardSubmission.workboard_id == workboard_id)
            .order_by(WorkboardSubmission.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
