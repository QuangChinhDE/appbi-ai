from __future__ import annotations

import json
import os
from typing import Any, Dict, Iterable, Tuple


def _ensure_database_url() -> None:
    if os.environ.get("DATABASE_URL"):
        return

    required_keys = ("DB_USER", "DB_PASSWORD", "DB_HOST", "DB_PORT", "DB_NAME")
    if not all(os.environ.get(key) for key in required_keys):
        missing = ", ".join(key for key in required_keys if not os.environ.get(key))
        raise RuntimeError(f"Missing database settings: {missing}")

    os.environ["DATABASE_URL"] = "postgresql://{user}:{password}@{host}:{port}/{name}".format(
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ["DB_HOST"],
        port=os.environ["DB_PORT"],
        name=os.environ["DB_NAME"],
    )


_ensure_database_url()


def _find_owner(db):
    from sqlalchemy import func

    from app.models.user import User

    admin_email = str(os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    if admin_email:
        owner = db.query(User).filter(func.lower(User.email) == admin_email).first()
        if owner is not None:
            return owner

    return db.query(User).order_by(User.created_at.asc()).first()


def _find_table(db, display_name: str):
    from app.models.dataset import Dataset, DatasetTable

    matches = (
        db.query(Dataset, DatasetTable)
        .join(DatasetTable, DatasetTable.dataset_id == Dataset.id)
        .filter(
            DatasetTable.display_name == display_name,
            Dataset.is_draft.is_(False),
            DatasetTable.enabled.isnot(False),
        )
        .order_by(Dataset.id.asc(), DatasetTable.id.asc())
        .all()
    )
    if not matches:
        raise ValueError(f"Could not find a non-draft dataset table named '{display_name}'")

    dataset, table = matches[0]
    return dataset, table


def _data_source(dataset, table) -> Dict[str, Any]:
    return {
        "datasetId": dataset.id,
        "tableId": table.id,
        "datasetName": dataset.name,
        "tableName": table.display_name,
    }


def _template_filter(filter_id: str, label: str, dataset, table, column: str, operator: str = "eq") -> Dict[str, Any]:
    return {
        "id": filter_id,
        "label": label,
        "datasetId": dataset.id,
        "tableId": table.id,
        "column": column,
        "operator": operator,
        "defaultValue": "",
    }


def _rankings_template(dataset, table) -> Tuple[Dict[str, Any], list[Dict[str, Any]]]:
    definition = {
        "version": 3,
        "layout": "table",
        "dataSource": _data_source(dataset, table),
        "groupBy": "confederation",
        "showSubtotals": True,
        "theme": {
            "headerBg": "#0f4c81",
            "headerText": "#ffffff",
            "groupBg": "#dbeafe",
            "groupText": "#0f4c81",
            "subtotalBg": "#eff6ff",
            "subtotalText": "#1d4ed8",
            "accentColor": "#2563eb",
            "sectionBg": "#dbeafe",
            "sectionText": "#0f4c81",
        },
        "header": {
            "title": "BANG XEP HANG FIFA THEO LIEN DOAN",
            "meta": f"Dataset: {dataset.name}",
            "titleAlign": "center",
            "titleFontSize": "xl",
            "titleBold": True,
            "lines": [
                {"text": "Demo seed - san sang test voi dataset that", "align": "center", "bold": True, "fontSize": "base"},
                {"text": f"Bang du lieu: {table.display_name}", "align": "center", "fontSize": "sm"},
            ],
        },
        "footer": {
            "lines": [
                {"text": "Template nay duoc seed tu dong va da bind vao dataset hien co.", "fontSize": "sm"},
            ],
            "signatureSlots": 2,
            "signatureLabels": ["Nguoi lap", "Nguoi duyet"],
        },
        "columns": [
            {"id": "rankings-confederation", "key": "confederation", "label": "Lien doan", "type": "raw", "sourceColumn": "Confederation", "width": 120, "format": "text", "visible": False},
            {"id": "rankings-rank", "key": "rank", "label": "Hang", "type": "raw", "sourceColumn": "Rank", "width": 80, "format": "text", "align": "right"},
            {"id": "rankings-country", "key": "country", "label": "Quoc gia", "type": "raw", "sourceColumn": "Country", "width": 180, "format": "text", "bold": True},
            {"id": "rankings-points", "key": "points", "label": "Diem FIFA", "type": "raw", "sourceColumn": "Points", "width": 120, "format": "decimal", "align": "right"},
            {"id": "rankings-best-finish", "key": "best_wc_finish", "label": "Thanh tich WC", "type": "raw", "sourceColumn": "Best_WC_Finish", "width": 130, "format": "text"},
            {"id": "rankings-world-title", "key": "world_cup_titles", "label": "Vo dich WC", "type": "raw", "sourceColumn": "World_Cup_Titles", "width": 110, "format": "integer", "align": "right"},
            {"id": "rankings-continental-title", "key": "continental_titles", "label": "Vo dich chau luc", "type": "raw", "sourceColumn": "Continental_Titles", "width": 130, "format": "integer", "align": "right"},
            {"id": "rankings-total-title", "key": "total_titles", "label": "Tong danh hieu", "type": "formula", "width": 120, "format": "integer", "align": "right", "expression": "[World_Cup_Titles] + [Continental_Titles]", "bold": True},
        ],
        "columnGroups": [
            {"id": "rankings-level-1-base", "label": "Thong tin xep hang", "level": 1, "columnIds": ["rankings-rank", "rankings-country", "rankings-points", "rankings-best-finish"]},
            {"id": "rankings-level-1-title", "label": "Thanh tich", "level": 1, "columnIds": ["rankings-world-title", "rankings-continental-title", "rankings-total-title"]},
            {"id": "rankings-level-2-title-breakdown", "label": "Cup va chau luc", "level": 2, "columnIds": ["rankings-world-title", "rankings-continental-title"]},
            {"id": "rankings-level-2-title-total", "label": "Tong hop", "level": 2, "columnIds": ["rankings-total-title"]},
        ],
    }
    filters = [
        _template_filter("rankings-confed-filter", "Lien doan", dataset, table, "Confederation"),
        _template_filter("rankings-country-filter", "Quoc gia", dataset, table, "Country", operator="contains"),
    ]
    return definition, filters


def _scorers_template(dataset, table) -> Tuple[Dict[str, Any], list[Dict[str, Any]]]:
    definition = {
        "version": 3,
        "layout": "table",
        "dataSource": _data_source(dataset, table),
        "groupBy": "host",
        "showSubtotals": True,
        "theme": {
            "headerBg": "#7c2d12",
            "headerText": "#ffffff",
            "groupBg": "#ffedd5",
            "groupText": "#7c2d12",
            "subtotalBg": "#fff7ed",
            "subtotalText": "#c2410c",
            "accentColor": "#ea580c",
            "sectionBg": "#ffedd5",
            "sectionText": "#7c2d12",
        },
        "header": {
            "title": "VUA PHA LUOI WORLD CUP + PHU LUC",
            "meta": f"Dataset: {dataset.name}",
            "titleAlign": "center",
            "titleFontSize": "xl",
            "titleBold": True,
            "lines": [
                {"text": "Demo seed - bang chinh va bang phu cuoi trang", "align": "center", "bold": True, "fontSize": "base"},
                {"text": f"Bang du lieu: {table.display_name}", "align": "center", "fontSize": "sm"},
            ],
        },
        "footer": {
            "lines": [
                {"text": "Bang phu duoi cung su dung cung dataset de test appendix section.", "fontSize": "sm"},
            ],
            "signatureSlots": 2,
            "signatureLabels": ["Nguoi tong hop", "Quan ly giai dau"],
        },
        "columns": [
            {"id": "scorers-host", "key": "host", "label": "Chu nha", "type": "raw", "sourceColumn": "Host", "width": 120, "format": "text", "visible": False},
            {"id": "scorers-year", "key": "year", "label": "Nam", "type": "raw", "sourceColumn": "Year", "width": 80, "format": "text", "align": "right"},
            {"id": "scorers-player", "key": "player", "label": "Cau thu", "type": "raw", "sourceColumn": "Player", "width": 180, "format": "text", "bold": True},
            {"id": "scorers-country", "key": "country", "label": "Doi tuyen", "type": "raw", "sourceColumn": "Country", "width": 140, "format": "text"},
            {"id": "scorers-goals", "key": "goals", "label": "Ban thang", "type": "raw", "sourceColumn": "Goals", "width": 100, "format": "integer", "align": "right"},
            {"id": "scorers-gpm", "key": "goals_per_match_est", "label": "Ban/tran uoc tinh", "type": "raw", "sourceColumn": "Goals_Per_Match_Est", "width": 132, "format": "decimal", "align": "right"},
            {"id": "scorers-index", "key": "scoring_index", "label": "Chi so ghi ban", "type": "formula", "width": 120, "format": "decimal", "align": "right", "expression": "[Goals] * [Goals_Per_Match_Est]", "bold": True},
        ],
        "columnGroups": [
            {"id": "scorers-level-1-info", "label": "Thong tin vua pha luoi", "level": 1, "columnIds": ["scorers-year", "scorers-player", "scorers-country"]},
            {"id": "scorers-level-1-metric", "label": "Hieu suat", "level": 1, "columnIds": ["scorers-goals", "scorers-gpm", "scorers-index"]},
            {"id": "scorers-level-2-metric-base", "label": "Chi so co so", "level": 2, "columnIds": ["scorers-goals", "scorers-gpm"]},
            {"id": "scorers-level-2-metric-result", "label": "Tong hop", "level": 2, "columnIds": ["scorers-index"]},
        ],
        "appendixSections": [
            {
                "id": "scorers-appendix",
                "title": "PHU LUC DOI CHIEU THEO CHU NHA",
                "description": "Appendix nay duoc seed san de ban test kieu bao cao co bang thu hai o cuoi trang.",
                "columnKeys": ["host", "year", "player", "country", "goals"],
                "groupBy": "host",
                "showSubtotals": False,
            }
        ],
    }
    filters = [
        _template_filter("scorers-host-filter", "Chu nha", dataset, table, "Host"),
        _template_filter("scorers-country-filter", "Doi tuyen", dataset, table, "Country"),
    ]
    return definition, filters


def _students_template(dataset, table) -> Tuple[Dict[str, Any], list[Dict[str, Any]]]:
    definition = {
        "version": 3,
        "layout": "table",
        "dataSource": _data_source(dataset, table),
        "groupBy": "parental_level",
        "showSubtotals": False,
        "theme": {
            "headerBg": "#14532d",
            "headerText": "#ffffff",
            "groupBg": "#dcfce7",
            "groupText": "#14532d",
            "subtotalBg": "#ecfdf5",
            "subtotalText": "#047857",
            "accentColor": "#16a34a",
            "sectionBg": "#dcfce7",
            "sectionText": "#14532d",
        },
        "header": {
            "title": "BANG DIEM HOC SINH THEO NHOM GIA DINH",
            "meta": f"Dataset: {dataset.name}",
            "titleAlign": "center",
            "titleFontSize": "xl",
            "titleBold": True,
            "lines": [
                {"text": "Demo seed - test grouped header va cong thuc tren dataset hoc sinh", "align": "center", "bold": True, "fontSize": "base"},
                {"text": f"Bang du lieu: {table.display_name}", "align": "center", "fontSize": "sm"},
            ],
        },
        "footer": {
            "lines": [
                {"text": "Co the doi bo loc gioi tinh, bua an va khoa on tap de test runtime filters.", "fontSize": "sm"},
            ],
            "signatureSlots": 3,
            "signatureLabels": ["Giao vien", "To truong", "Ban giam hieu"],
        },
        "columns": [
            {"id": "students-parental", "key": "parental_level", "label": "Hoc van phu huynh", "type": "raw", "sourceColumn": "parental level of education", "width": 190, "format": "text", "visible": False},
            {"id": "students-gender", "key": "gender", "label": "Gioi tinh", "type": "raw", "sourceColumn": "gender", "width": 100, "format": "text"},
            {"id": "students-race", "key": "race_ethnicity", "label": "Nhom", "type": "raw", "sourceColumn": "race/ethnicity", "width": 120, "format": "text"},
            {"id": "students-lunch", "key": "lunch", "label": "Bua an", "type": "raw", "sourceColumn": "lunch", "width": 130, "format": "text"},
            {"id": "students-prep", "key": "test_prep", "label": "On tap", "type": "raw", "sourceColumn": "test preparation course", "width": 120, "format": "text"},
            {"id": "students-math", "key": "math_score", "label": "Math", "type": "raw", "sourceColumn": "math score", "width": 88, "format": "integer", "align": "right"},
            {"id": "students-reading", "key": "reading_score", "label": "Reading", "type": "raw", "sourceColumn": "reading score", "width": 92, "format": "integer", "align": "right"},
            {"id": "students-writing", "key": "writing_score", "label": "Writing", "type": "raw", "sourceColumn": "writing score", "width": 92, "format": "integer", "align": "right"},
            {"id": "students-avg", "key": "average_score", "label": "Diem TB", "type": "formula", "width": 92, "format": "decimal", "align": "right", "expression": "ROUND(([math score] + [reading score] + [writing score]) / 3, 1)", "bold": True},
            {"id": "students-gap", "key": "reading_vs_math_gap", "label": "Reading-Math", "type": "formula", "width": 110, "format": "decimal", "align": "right", "expression": "[reading score] - [math score]"},
        ],
        "columnGroups": [
            {"id": "students-level-1-profile", "label": "Thong tin hoc sinh", "level": 1, "columnIds": ["students-gender", "students-race", "students-lunch", "students-prep"]},
            {"id": "students-level-1-score", "label": "Ket qua hoc tap", "level": 1, "columnIds": ["students-math", "students-reading", "students-writing", "students-avg", "students-gap"]},
            {"id": "students-level-2-subjects", "label": "Mon hoc", "level": 2, "columnIds": ["students-math", "students-reading", "students-writing"]},
            {"id": "students-level-2-summary", "label": "Tong hop", "level": 2, "columnIds": ["students-avg", "students-gap"]},
        ],
    }
    filters = [
        _template_filter("students-gender-filter", "Gioi tinh", dataset, table, "gender"),
        _template_filter("students-lunch-filter", "Bua an", dataset, table, "lunch"),
        _template_filter("students-prep-filter", "On tap", dataset, table, "test preparation course"),
    ]
    return definition, filters


def _template_specs(db) -> Iterable[Tuple[str, str, str, Dict[str, Any], list[Dict[str, Any]]]]:
    rankings_dataset, rankings_table = _find_table(db, "Fifa World Rankings Jan 2026")
    scorers_dataset, scorers_table = _find_table(db, "Fifa World Cup Top Scorers")
    students_dataset, students_table = _find_table(db, "StudentsPerformance")

    rankings_definition, rankings_filters = _rankings_template(rankings_dataset, rankings_table)
    scorers_definition, scorers_filters = _scorers_template(scorers_dataset, scorers_table)
    students_definition, students_filters = _students_template(students_dataset, students_table)

    return [
        (
            "Demo Seed - Bang xep hang FIFA",
            "Demo template da bind vao Fifa World Rankings Jan 2026.",
            rankings_table.display_name,
            rankings_definition,
            rankings_filters,
        ),
        (
            "Demo Seed - Vua pha luoi World Cup",
            "Demo template co appendix section va da bind vao Fifa World Cup Top Scorers.",
            scorers_table.display_name,
            scorers_definition,
            scorers_filters,
        ),
        (
            "Demo Seed - Bang diem hoc sinh",
            "Demo template da bind vao StudentsPerformance.",
            students_table.display_name,
            students_definition,
            students_filters,
        ),
    ]


def seed_templates() -> int:
    from app.core.database import SessionLocal
    from app.models.report_template import ReportTemplate
    from app.schemas.report_template import ReportTemplateCreate, ReportTemplateUpdate
    from app.services.report_template_service import ReportTemplateService
    from app.services.template_excel_export_service import export_template_to_excel

    db = SessionLocal()
    try:
        owner = _find_owner(db)
        if owner is None:
            raise RuntimeError("Could not find any user to own the seeded demo templates")

        summary = []
        for name, description, table_name, definition, filters in _template_specs(db):
            existing = db.query(ReportTemplate).filter(ReportTemplate.name == name).first()
            if existing is None:
                template = ReportTemplateService.create(
                    db,
                    ReportTemplateCreate(
                        name=name,
                        description=description,
                        orientation="landscape",
                        blocks=definition,
                        filters=filters,
                    ),
                    owner_id=owner.id,
                )
                action = "created"
            else:
                template = ReportTemplateService.update(
                    db,
                    existing.id,
                    ReportTemplateUpdate(
                        description=description,
                        orientation="landscape",
                        blocks=definition,
                        filters=filters,
                    ),
                )
                template.owner_id = owner.id
                db.commit()
                db.refresh(template)
                action = "updated"

            export_bytes = export_template_to_excel(db, template, active_filters=[])
            data_source = definition.get("dataSource") or {}
            summary.append(
                {
                    "id": template.id,
                    "name": template.name,
                    "action": action,
                    "owner_email": owner.email,
                    "table": table_name,
                    "dataset_id": data_source.get("datasetId"),
                    "table_id": data_source.get("tableId"),
                    "export_bytes": len(export_bytes),
                }
            )

        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(seed_templates())