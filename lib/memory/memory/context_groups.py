"""Deterministic navigation groups inferred from saved proposition text.

These labels organize browsing; they do not change or enrich stored memory.
"""

import re
from collections import Counter
from datetime import UTC, datetime

TOPICS = {
    "Development": r"\b(code|coding|debug\w*|git|commit\w*|python|typescript|javascript|repository|repositories|terminal|api|software|tests?|implementation)\b",
    "Writing & editing": r"\b(writ\w*|edit\w*|latex|overleaf|document\w*|draft\w*|manuscript|paragraph\w*|grammar|revis\w*|proofread\w*)\b",
    "Research & learning": r"\b(research\w*|paper\w*|stud\w*|learn\w*|experiment\w*|methodolog\w*|literature|scientific|arxiv|benchmark\w*)\b",
    "Design & media": r"\b(design\w*|figma|video\w*|image\w*|animation\w*|illustrat\w*|photoshop|premiere|diagram\w*|visual\w*|slides?)\b",
    "Planning & coordination": r"\b(plan\w*|calendar|schedul\w*|meeting\w*|email\w*|slack|teams|collaborat\w*|deadline\w*|task\w*|organizing)\b",
    "Data & analysis": r"\b(data|dataset\w*|analys\w*|spreadsheet\w*|excel|statistics|metrics|plot\w*|chart\w*|csv|sql|table\w*)\b",
    "Tools & workflows": r"\b(tool\w*|workflow\w*|settings|configur\w*|install\w*|application\w*|browser|chatgpt|claude|assistant\w*|automation)\b",
}
APPS = {
    "VS Code": r"\b(vs\s*code|visual studio code)\b",
    "Cursor": r"\bcursor\b",
    "iTerm": r"\biterm2?\b",
    "Terminal": r"\bterminal\b",
    "ChatGPT": r"\bchatgpt\b",
    "Claude": r"\bclaude\b",
    "Codex": r"\bcodex\b",
    "Overleaf": r"\boverleaf\b",
    "Chrome": r"\b(chrome|chromium)\b",
    "Safari": r"\bsafari\b",
    "Firefox": r"\bfirefox\b",
    "Slack": r"\bslack\b",
    "Teams": r"\bmicrosoft teams\b",
    "Notion": r"\bnotion\b",
    "Figma": r"\bfigma\b",
    "Excel": r"\bexcel\b",
    "Google Sheets": r"\bgoogle sheets\b",
    "Google Docs": r"\bgoogle docs\b",
    "Word": r"\b(microsoft word|ms word)\b",
    "PowerPoint": r"\bpowerpoint\b",
    "Keynote": r"\bkeynote\b",
    "Preview": r"\bpreview app\b",
    "Premiere": r"\bpremiere\b",
    "Photoshop": r"\bphotoshop\b",
    "Zoom": r"\bzoom (meeting|call|app)\b",
    "Finder": r"\bfinder\b",
    "Coco": r"\bcoco\b",
}
_TOPIC_PATTERNS = {k: re.compile(v, re.I) for k, v in TOPICS.items()}
_APP_PATTERNS = {k: re.compile(v, re.I) for k, v in APPS.items()}


def group_keys(text: str, updated_at: float, group_by: str) -> list[str]:
    if group_by == "date":
        return [datetime.fromtimestamp(updated_at, UTC).strftime("%Y-%m")]
    if group_by == "app":
        return [
            name for name, pattern in _APP_PATTERNS.items() if pattern.search(text)
        ] or ["No app identified"]
    scores = {
        name: len(pattern.findall(text)) for name, pattern in _TOPIC_PATTERNS.items()
    }
    best = max(scores, key=scores.get)
    return [best if scores[best] else "Other context"]


def build_groups(rows, group_by: str):
    membership = {
        row["id"]: group_keys(row["text"], row["updated_at"], group_by) for row in rows
    }
    counts = Counter(key for keys in membership.values() for key in keys)
    ordered = (
        sorted(counts, reverse=True)
        if group_by == "date"
        else sorted(counts, key=lambda key: (-counts[key], key))
    )
    return [
        {
            "id": key,
            "label": datetime.strptime(key, "%Y-%m").strftime("%B %Y")
            if group_by == "date"
            else key,
            "count": counts[key],
        }
        for key in ordered
    ], membership


LEAF_SIZE = 8


def _split(rows, dimension):
    if dimension != "day":
        groups, membership = build_groups(rows, dimension)
        return groups, membership
    membership = {
        row["id"]: [datetime.fromtimestamp(row["updated_at"], UTC).strftime("%Y-%m-%d")]
        for row in rows
    }
    counts = Counter(keys[0] for keys in membership.values())
    return [
        {
            "id": key,
            "label": datetime.strptime(key, "%Y-%m-%d").strftime("%b %d, %Y"),
            "count": counts[key],
        }
        for key in sorted(counts, reverse=True)
    ], membership


def _period_groups(rows):
    # Even identical timestamps must make progress. Keep chronological ordering
    # and use bounded ranges rather than inventing semantic relationships.
    size = (len(rows) + 7) // 8
    groups, membership = [], {}
    for start in range(0, len(rows), size):
        chunk = rows[start : start + size]
        first = datetime.fromtimestamp(chunk[0]["updated_at"], UTC).strftime(
            "%b %d, %Y"
        )
        last = datetime.fromtimestamp(chunk[-1]["updated_at"], UTC).strftime(
            "%b %d, %Y"
        )
        key = f"range:{chunk[0]['id']}:{chunk[-1]['id']}"
        label = (
            f"{last} – {first}"
            if first != last
            else f"{first} · {start + 1}–{start + len(chunk)}"
        )
        groups.append({"id": key, "label": label, "count": len(chunk)})
        for row in chunk:
            membership[row["id"]] = [key]
    return groups, membership


def context_branch(rows, root_group_by: str, trail: list[str]):
    """Resolve a path and subdivide only its members; every deep split shrinks."""
    selected = rows
    breadcrumbs = []
    used = set()
    for depth in range(len(trail) + 1):
        leaf = len(selected) <= LEAF_SIZE
        groups, membership = [], {}
        dimension = root_group_by
        if not leaf:
            if depth == 0:
                groups, membership = _split(selected, root_group_by)
            else:
                for dimension in ("app", "date", "topic", "day"):
                    if dimension in used:
                        continue
                    groups, membership = _split(selected, dimension)
                    if len(groups) > 1 and max(
                        group["count"] for group in groups
                    ) < len(selected):
                        break
                else:
                    dimension = "period"
                    groups, membership = _period_groups(selected)
        if depth == len(trail):
            return selected, groups, breadcrumbs, leaf, dimension
        chosen = next((group for group in groups if group["id"] == trail[depth]), None)
        if chosen is None:
            raise ValueError(
                "This context group has changed. Return to the overview and choose it again."
            )
        selected = [row for row in selected if chosen["id"] in membership[row["id"]]]
        breadcrumbs.append({"label": chosen["label"], "count": len(selected)})
        used.add(dimension)
    raise AssertionError("Unreachable context path")
