#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Summarize persisted intentlane-codex incidents to find recurring failure patterns."
    )
    parser.add_argument(
        "--incidents-dir",
        help="Path to the incidents directory. Defaults to $INTENTLANE_CODEX_DATA_DIR/incidents or ./incidents.",
    )
    parser.add_argument("--project-id", help="Limit summary to a single project id.")
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Output format.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Maximum number of top buckets and recent incidents to show.",
    )
    return parser.parse_args()


def resolve_incidents_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()

    data_dir = os.environ.get("INTENTLANE_CODEX_DATA_DIR", "").strip()
    if data_dir:
        return (Path.cwd() / data_dir / "incidents").resolve()

    return (Path.cwd() / "incidents").resolve()


def shorten(value: str | None, limit: int = 120) -> str:
    text = " ".join((value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def load_incident_records(incidents_dir: Path, project_id: str | None) -> list[dict[str, Any]]:
    if not incidents_dir.exists():
        raise FileNotFoundError(f"Incidents directory not found: {incidents_dir}")

    project_dirs: list[Path]
    if project_id:
        project_dirs = [incidents_dir / project_id]
    else:
        project_dirs = sorted(path for path in incidents_dir.iterdir() if path.is_dir())

    records: list[dict[str, Any]] = []

    for project_dir in project_dirs:
        if not project_dir.exists() or not project_dir.is_dir():
            continue

        for path in sorted(project_dir.glob("*.json")):
            with path.open("r", encoding="utf-8") as file:
                raw = json.load(file)

            analysis = raw.get("analysis") or {}
            resolution = raw.get("resolution") or {}
            trigger = raw.get("trigger") or {}

            records.append(
                {
                    "id": raw.get("id") or path.stem,
                    "path": str(path),
                    "projectId": raw.get("projectId") or project_dir.name,
                    "title": raw.get("title") or "",
                    "status": raw.get("status") or "captured",
                    "triggerKind": trigger.get("kind") or "unknown",
                    "triggerPhase": trigger.get("phase"),
                    "resolutionStatus": resolution.get("status"),
                    "resolutionType": resolution.get("actionType"),
                    "confidence": analysis.get("confidence"),
                    "likelyRootCause": analysis.get("likelyRootCause") or "",
                    "impactedAreas": as_string_list(analysis.get("impactedAreas")),
                    "nextActions": as_string_list(analysis.get("nextActions")),
                    "createdAt": raw.get("createdAt") or "",
                    "updatedAt": raw.get("updatedAt") or raw.get("createdAt") or "",
                }
            )

    records.sort(key=lambda record: record["updatedAt"], reverse=True)
    return records


def top_items(counter: Counter[str], limit: int) -> list[dict[str, Any]]:
    return [{"value": value, "count": count} for value, count in counter.most_common(limit)]


def build_summary(records: list[dict[str, Any]], incidents_dir: Path, limit: int) -> dict[str, Any]:
    project_counts = Counter(record["projectId"] for record in records)
    trigger_counts = Counter(record["triggerKind"] for record in records)
    status_counts = Counter(record["status"] for record in records)
    resolution_counts = Counter(
        f'{record["resolutionStatus"] or "unknown"}:{record["resolutionType"] or "untyped"}' for record in records
    )
    root_cause_counts = Counter(
        shorten(record["likelyRootCause"], 160) for record in records if record["likelyRootCause"]
    )
    impacted_area_counts = Counter(area for record in records for area in record["impactedAreas"])

    unanalyzed = [record for record in records if record["status"] != "analyzed"]
    unresolved = [
        record
        for record in records
        if record["resolutionStatus"] not in {"completed", "skipped"}
    ]

    return {
        "incidentsDir": str(incidents_dir),
        "totalIncidents": len(records),
        "projects": top_items(project_counts, limit),
        "triggerKinds": top_items(trigger_counts, limit),
        "statuses": top_items(status_counts, limit),
        "resolutionBuckets": top_items(resolution_counts, limit),
        "topRootCauses": top_items(root_cause_counts, limit),
        "topImpactedAreas": top_items(impacted_area_counts, limit),
        "unanalyzedIncidentIds": [record["id"] for record in unanalyzed[:limit]],
        "unresolvedIncidentIds": [record["id"] for record in unresolved[:limit]],
        "recentIncidents": records[:limit],
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Incident Summary",
        "",
        f'- incidents dir: `{summary["incidentsDir"]}`',
        f'- total incidents: {summary["totalIncidents"]}',
        "",
        "## Projects",
    ]

    if summary["projects"]:
        for item in summary["projects"]:
            lines.append(f'- {item["value"]}: {item["count"]}')
    else:
        lines.append("- none")

    lines.extend(
        [
            "",
            "## Trigger Kinds",
        ]
    )
    if summary["triggerKinds"]:
        for item in summary["triggerKinds"]:
            lines.append(f'- {item["value"]}: {item["count"]}')
    else:
        lines.append("- none")

    lines.extend(
        [
            "",
            "## Statuses",
        ]
    )
    if summary["statuses"]:
        for item in summary["statuses"]:
            lines.append(f'- {item["value"]}: {item["count"]}')
    else:
        lines.append("- none")

    lines.extend(
        [
            "",
            "## Resolution Buckets",
        ]
    )
    if summary["resolutionBuckets"]:
        for item in summary["resolutionBuckets"]:
            lines.append(f'- {item["value"]}: {item["count"]}')
    else:
        lines.append("- none")

    lines.extend(
        [
            "",
            "## Top Root Causes",
        ]
    )
    if summary["topRootCauses"]:
        for item in summary["topRootCauses"]:
            lines.append(f'- {item["count"]}x {item["value"]}')
    else:
        lines.append("- no analyzed root causes yet")

    lines.extend(
        [
            "",
            "## Top Impacted Areas",
        ]
    )
    if summary["topImpactedAreas"]:
        for item in summary["topImpactedAreas"]:
            lines.append(f'- {item["count"]}x {shorten(item["value"], 180)}')
    else:
        lines.append("- no impacted areas recorded yet")

    lines.extend(
        [
            "",
            "## Needs Attention",
            f'- unanalyzed incidents: {", ".join(summary["unanalyzedIncidentIds"]) if summary["unanalyzedIncidentIds"] else "none"}',
            f'- unresolved incidents: {", ".join(summary["unresolvedIncidentIds"]) if summary["unresolvedIncidentIds"] else "none"}',
            "",
            "## Recent Incidents",
        ]
    )

    if summary["recentIncidents"]:
        for incident in summary["recentIncidents"]:
            lines.append(
                "- "
                + " | ".join(
                    [
                        incident["updatedAt"] or "unknown-time",
                        incident["id"],
                        incident["projectId"],
                        incident["triggerKind"],
                        incident["status"],
                    ]
                )
            )
            lines.append(f'  title: {shorten(incident["title"], 120)}')
            if incident["likelyRootCause"]:
                lines.append(f'  cause: {shorten(incident["likelyRootCause"], 140)}')
            if incident["impactedAreas"]:
                impacted = shorten("; ".join(incident["impactedAreas"][:3]), 180)
                lines.append(f"  impacted: {impacted}")
            if incident["nextActions"]:
                lines.append(f'  next: {shorten("; ".join(incident["nextActions"]), 140)}')

    else:
        lines.append("- none")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    incidents_dir = resolve_incidents_dir(args.incidents_dir)

    try:
        records = load_incident_records(incidents_dir, args.project_id)
    except FileNotFoundError as error:
        print(str(error), file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"Failed to parse incident JSON: {error}", file=sys.stderr)
        return 1

    summary = build_summary(records, incidents_dir, args.limit)

    if args.format == "json":
        json.dump(summary, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0

    print(render_markdown(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
