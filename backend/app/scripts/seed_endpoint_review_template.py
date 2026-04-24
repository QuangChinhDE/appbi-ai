from __future__ import annotations

import argparse
import json
from typing import Any, Dict, Tuple

from app.scripts.seed_demo_templates import _data_source, _ensure_database_url, _find_owner, _find_table, _template_filter


_ensure_database_url()


def _build_endpoint_review_definition(dataset, table) -> Tuple[Dict[str, Any], list[Dict[str, Any]]]:
    definition = {
        "version": 3,
        "layout": "table",
        "dataSource": _data_source(dataset, table),
        "groupBy": "host",
        "showSubtotals": True,
        "theme": {
            "headerBg": "#1e3a8a",
            "headerText": "#ffffff",
            "groupBg": "#dbeafe",
            "groupText": "#1e3a8a",
            "subtotalBg": "#eff6ff",
            "subtotalText": "#1d4ed8",
            "accentColor": "#2563eb",
            "sectionBg": "#dbeafe",
            "sectionText": "#1e3a8a",
        },
        "header": {
            "title": "BAO CAO DOI CHIEU PHE DUYET VUA PHA LUOI WORLD CUP",
            "meta": f"Dataset: {dataset.name} | Table: {table.display_name}",
            "titleAlign": "center",
            "titleFontSize": "xl",
            "titleBold": True,
            "lines": [
                {
                    "text": "Mau user-flow de review contract endpoint Template truoc khi dua vao MCP.",
                    "align": "center",
                    "bold": True,
                    "fontSize": "base",
                },
                {
                    "text": "Co grouped header 2 tang, footer ky duyet, appendix va bind truc tiep vao bang du lieu that.",
                    "align": "center",
                    "fontSize": "sm",
                },
            ],
        },
        "footer": {
            "lines": [
                {
                    "text": "Template nay duoc tao de kiem tra muc do day du va tien dung cua endpoint /report-templates.",
                    "fontSize": "sm",
                },
                {
                    "text": "Neu payload nay on, MCP co the dung lai gan nhu nguyen van de build bao cao legacy table engine.",
                    "fontSize": "sm",
                },
            ],
            "signatureSlots": 3,
            "signatureLabels": ["Nguoi lap", "Nguoi kiem tra", "Nguoi phe duyet"],
        },
        "columns": [
            {
                "id": "endpoint-host",
                "key": "host",
                "label": "Chu nha",
                "type": "raw",
                "sourceColumn": "Host",
                "width": 120,
                "format": "text",
                "visible": False,
            },
            {
                "id": "endpoint-year",
                "key": "year",
                "label": "Nam",
                "type": "raw",
                "sourceColumn": "Year",
                "width": 84,
                "format": "text",
                "align": "right",
            },
            {
                "id": "endpoint-player",
                "key": "player",
                "label": "Cau thu",
                "type": "raw",
                "sourceColumn": "Player",
                "width": 190,
                "format": "text",
                "bold": True,
            },
            {
                "id": "endpoint-country",
                "key": "country",
                "label": "Doi tuyen",
                "type": "raw",
                "sourceColumn": "Country",
                "width": 140,
                "format": "text",
            },
            {
                "id": "endpoint-goals",
                "key": "goals",
                "label": "Ban thang",
                "type": "raw",
                "sourceColumn": "Goals",
                "width": 96,
                "format": "integer",
                "align": "right",
            },
            {
                "id": "endpoint-gpm",
                "key": "goals_per_match_est",
                "label": "Ban/tran uoc tinh",
                "type": "raw",
                "sourceColumn": "Goals_Per_Match_Est",
                "width": 132,
                "format": "decimal",
                "align": "right",
            },
            {
                "id": "endpoint-score-index",
                "key": "scoring_index",
                "label": "Chi so ghi ban",
                "type": "formula",
                "width": 118,
                "format": "decimal",
                "align": "right",
                "expression": "[Goals] * [Goals_Per_Match_Est]",
                "bold": True,
            },
            {
                "id": "endpoint-review-note",
                "key": "review_note",
                "label": "Nhan xet phe duyet",
                "type": "formula",
                "width": 190,
                "format": "text",
                "expression": "CASE WHEN [Goals] >= 10 THEN 'Can uu tien review' ELSE 'Dat nguong theo doi' END",
            },
        ],
        "columnGroups": [
            {
                "id": "endpoint-level-1-info",
                "label": "THONG TIN CHUNG",
                "level": 1,
                "columnIds": ["endpoint-year", "endpoint-player", "endpoint-country"],
            },
            {
                "id": "endpoint-level-1-performance",
                "label": "CHI SO HIEU SUAT",
                "level": 1,
                "columnIds": ["endpoint-goals", "endpoint-gpm", "endpoint-score-index"],
            },
            {
                "id": "endpoint-level-1-review",
                "label": "KET QUA DOI CHIEU",
                "level": 1,
                "columnIds": ["endpoint-review-note"],
            },
            {
                "id": "endpoint-level-2-base",
                "label": "SO LIEU GOC",
                "level": 2,
                "columnIds": ["endpoint-goals", "endpoint-gpm"],
            },
            {
                "id": "endpoint-level-2-result",
                "label": "CHI SO TONG HOP",
                "level": 2,
                "columnIds": ["endpoint-score-index"],
            },
        ],
        "appendixSections": [
            {
                "id": "endpoint-appendix-host",
                "title": "PHU LUC DOI CHIEU THEO CHU NHA",
                "description": "Bang phu nay giu nguyen lien ket datasource de test export va review cuoi trang.",
                "columnKeys": ["host", "year", "player", "country", "goals", "goals_per_match_est"],
                "groupBy": "host",
                "showSubtotals": False,
            }
        ],
    }
    filters = [
        _template_filter("endpoint-host-filter", "Chu nha", dataset, table, "Host"),
        _template_filter("endpoint-country-filter", "Doi tuyen", dataset, table, "Country"),
        _template_filter("endpoint-player-filter", "Cau thu", dataset, table, "Player", operator="contains"),
    ]
    return definition, filters


def _build_request_payload(dataset, table) -> Dict[str, Any]:
    definition, filters = _build_endpoint_review_definition(dataset, table)
    return {
        "name": "Endpoint Review - Bao cao phe duyet scorers",
        "description": "Mau user-init de review contract endpoint Template voi grouped headers, footer ky duyet va appendix.",
        "page_size": "A4",
        "orientation": "landscape",
        "blocks": definition,
        "filters": filters,
    }


def seed_endpoint_review_template(*, print_only: bool = False) -> int:
    from app.core.database import SessionLocal
    from app.models.report_template import ReportTemplate
    from app.schemas.report_template import ReportTemplateCreate, ReportTemplateUpdate
    from app.services.report_template_service import ReportTemplateService
    from app.services.template_excel_export_service import export_template_to_excel

    db = SessionLocal()
    try:
        owner = _find_owner(db)
        if owner is None:
            raise RuntimeError("Could not find any user to own the endpoint review template")

        dataset, table = _find_table(db, "Fifa World Cup Top Scorers")
        request_payload = _build_request_payload(dataset, table)

        if print_only:
            print(json.dumps(request_payload, ensure_ascii=False, indent=2))
            return 0

        existing = db.query(ReportTemplate).filter(
            ReportTemplate.name == request_payload["name"]
        ).first()

        if existing is None:
            template = ReportTemplateService.create(
                db,
                ReportTemplateCreate(**request_payload),
                owner_id=owner.id,
            )
            action = "created"
        else:
            template = ReportTemplateService.update(
                db,
                existing.id,
                ReportTemplateUpdate(**request_payload),
            )
            assert template is not None
            template.owner_id = owner.id
            db.commit()
            db.refresh(template)
            action = "updated"

        export_bytes = export_template_to_excel(db, template, active_filters=[])
        summary = {
            "action": action,
            "template_id": template.id,
            "template_name": template.name,
            "owner_email": owner.email,
            "dataset_id": request_payload["blocks"]["dataSource"]["datasetId"],
            "table_id": request_payload["blocks"]["dataSource"]["tableId"],
            "table_name": request_payload["blocks"]["dataSource"]["tableName"],
            "export_bytes": len(export_bytes),
            "endpoint": "POST /api/v1/report-templates/",
            "request_payload": request_payload,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create one realistic review template payload and optionally seed it into the database.",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="Only print the request body with resolved dataset/table IDs.",
    )
    args = parser.parse_args()
    return seed_endpoint_review_template(print_only=args.print_only)


if __name__ == "__main__":
    raise SystemExit(main())