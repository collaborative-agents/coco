"""Live observer-input integration test script.

Run an isolated sensing session, then generate an HTML observer-input review.

```
set -a
source .env
set +a

UV_CACHE_DIR=/tmp/coco-uv-cache \
uv run --package sensing python \
  tests/run_sensing_observer_test.py
```
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "exp/observer_input/live-monitor-test"
DEFAULT_SYSTEM_PROMPT = REPO_ROOT / "lib/sensing/sensing/prompts_everyday/observer.txt"
SCREENSHOT_BLOCK_RE = re.compile(
    r"<screenshots(?:\s[^>]*)?>\s*(.*?)\s*</screenshots>", re.DOTALL
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--observer-model",
        default=os.environ.get("OBSERVER_MODEL", ""),
        help="observer model (default: $OBSERVER_MODEL)",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="parent directory for isolated sessions (default: exp/observer_input/live-monitor-test)",
    )
    parser.add_argument(
        "--system-prompt",
        type=Path,
        default=DEFAULT_SYSTEM_PROMPT,
        help="observer system-prompt file",
    )
    parser.add_argument("--port", type=int, default=18082)
    parser.add_argument("--check-interval", type=float, default=5.0)
    parser.add_argument("--min-actions-threshold", type=int, default=2)
    parser.add_argument("--observer-interval-seconds", type=float, default=15.0)
    parser.add_argument("--mse-threshold", type=float, default=8000.0)
    parser.add_argument(
        "--duration",
        type=float,
        help="stop automatically after this many seconds (default: wait for Ctrl+C)",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="do not open the generated HTML review",
    )
    parser.add_argument(
        "--no-copy-images",
        action="store_true",
        help="reference retained screenshots in place instead of copying review assets",
    )
    args = parser.parse_args(argv)
    if not args.observer_model.strip():
        parser.error("--observer-model is required (or set OBSERVER_MODEL)")
    if args.duration is not None and args.duration <= 0:
        parser.error("--duration must be positive")
    if args.check_interval <= 0 or args.observer_interval_seconds <= 0:
        parser.error("intervals must be positive")
    if args.min_actions_threshold <= 0:
        parser.error("--min-actions-threshold must be positive")
    if args.mse_threshold < 0:
        parser.error("--mse-threshold must be nonnegative")
    return args


def load_records(session_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    log_path = session_dir / "observations.jsonl"
    if not log_path.is_file():
        return records, [f"No observer log was created at {log_path}"]

    lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            warnings.append(f"Skipped malformed JSON at {log_path}:{line_number}")
            continue
        if not isinstance(record, dict):
            warnings.append(f"Skipped non-object JSON at {log_path}:{line_number}")
            continue
        record["_session_name"] = session_dir.name
        record["_source_log"] = str(log_path)
        records.append(record)

    records.sort(key=lambda item: float(item.get("ts") or 0))
    return records, warnings


def existing_image_paths(record: dict[str, Any]) -> list[Path]:
    retained = record.get("retained_screenshots")
    source = record.get("screenshot_paths")
    retained_paths = [Path(str(path)) for path in retained or []]
    source_paths = [Path(str(path)) for path in source or []]
    count = max(len(retained_paths), len(source_paths))
    result: list[Path] = []
    for index in range(count):
        candidates = []
        if index < len(retained_paths):
            candidates.append(retained_paths[index])
        if index < len(source_paths):
            candidates.append(source_paths[index])
        existing = next((path for path in candidates if path.is_file()), None)
        if existing is not None:
            result.append(existing)
    return result


def prepare_images(
    records: list[dict[str, Any]], output_path: Path, copy_images: bool
) -> tuple[int, list[str]]:
    warnings: list[str] = []
    image_count = 0
    assets_dir = output_path.with_name(f"{output_path.stem}-assets")
    if copy_images:
        assets_dir.mkdir(parents=True, exist_ok=True)

    for record in records:
        source_paths = existing_image_paths(record)
        expected = max(
            len(record.get("retained_screenshots") or []),
            len(record.get("screenshot_paths") or []),
        )
        if len(source_paths) != expected:
            warnings.append(
                f"{record.get('observation_id')}: found {len(source_paths)} of {expected} images"
            )
        rendered_paths: list[str] = []
        for index, source_path in enumerate(source_paths, 1):
            if copy_images:
                suffix = source_path.suffix.lower() or ".jpg"
                destination = assets_dir / (
                    f"{record.get('_session_name', 'session')}-"
                    f"{record.get('observation_id', 'observation')}-{index}{suffix}"
                )
                try:
                    if (
                        not destination.exists()
                        or destination.stat().st_size != source_path.stat().st_size
                    ):
                        shutil.copy2(source_path, destination)
                    rendered_paths.append(
                        destination.relative_to(output_path.parent).as_posix()
                    )
                except OSError as exc:
                    warnings.append(f"Could not copy {source_path}: {exc}")
                    rendered_paths.append(source_path.as_uri())
            else:
                rendered_paths.append(source_path.resolve().as_uri())
            image_count += 1
        record["_review_images"] = rendered_paths
    return image_count, warnings


def screenshot_captions(prompt: str) -> list[str]:
    captions: list[str] = []
    for block in SCREENSHOT_BLOCK_RE.findall(prompt):
        for raw_line in block.splitlines():
            line = raw_line.strip()
            is_timeline_or_reference = re.match(
                r"^\[[^]]+\]\s+(?:Screenshot|Current reference)\s+\d+\s+of\s+\d+",
                line,
            )
            is_hotkey = re.match(r"^\[hk\d+\]\s+", line)
            if is_timeline_or_reference or is_hotkey:
                captions.append(line)
    return captions


def parsed_output(raw_output: Any) -> dict[str, Any]:
    text = str(raw_output or "").strip()
    candidates = [text]
    fenced = re.search(
        r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL | re.IGNORECASE
    )
    if fenced:
        candidates.insert(0, fenced.group(1))
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    match = re.search(r'["\']need_support["\']\s*:\s*["\'](yes|no)["\']', text, re.I)
    return {"need_support": match.group(1).lower()} if match else {}


def local_timestamp(raw_timestamp: Any) -> str:
    try:
        return (
            datetime.fromtimestamp(float(raw_timestamp))
            .astimezone()
            .isoformat(sep=" ", timespec="seconds")
        )
    except (TypeError, ValueError, OSError, OverflowError):
        return "unknown time"


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def render_record(record: dict[str, Any], index: int) -> str:
    prompt = str(record.get("observer_input") or "")
    output = str(record.get("observer_output") or "")
    parsed = parsed_output(output)
    support = str(parsed.get("need_support") or "unknown").lower()
    if support not in {"yes", "no"}:
        support = "unknown"
    captions = screenshot_captions(prompt)
    images = record.get("_review_images") or []
    image_cards: list[str] = []
    for image_index, image_path in enumerate(images, 1):
        caption = (
            captions[image_index - 1]
            if image_index <= len(captions)
            else (f"Screenshot {image_index} of {len(images)} (caption unavailable)")
        )
        safe_path = escape(str(image_path), quote=True)
        safe_caption = escape(caption)
        image_cards.append(
            f"""
            <figure>
              <button class="image-button" type="button" data-image="{safe_path}" data-caption="{escape(caption, quote=True)}">
                <img src="{safe_path}" alt="{escape(caption, quote=True)}" loading="lazy">
                <span>Open full size</span>
              </button>
              <figcaption><strong>Image {image_index}</strong><small>{safe_caption}</small></figcaption>
            </figure>
            """
        )
    if not image_cards:
        image_cards.append(
            '<div class="empty-gallery">No retained image is available.</div>'
        )

    metrics = (
        record.get("llm_metrics") if isinstance(record.get("llm_metrics"), dict) else {}
    )
    duration = metrics.get("duration_ms")
    duration_label = (
        f"{float(duration) / 1000:.2f}s" if isinstance(duration, (int, float)) else "—"
    )
    observation = str(parsed.get("observation") or "")
    intent = str(parsed.get("user_intent") or "")
    rationale = str(parsed.get("rationale") or "")
    result_summary = "".join(
        f"<div><span>{escape(label)}</span><p>{escape(value)}</p></div>"
        for label, value in (
            ("Observation", observation),
            ("User intent", intent),
            ("Rationale", rationale),
        )
        if value
    )
    if not result_summary:
        result_summary = '<p class="muted">The output was not valid observer JSON; inspect the raw output below.</p>'

    session = str(record.get("_session_name") or "unknown")
    record_type = str(record.get("type") or "unknown")
    observation_id = str(record.get("observation_id") or "unknown")
    timestamp = local_timestamp(record.get("ts"))
    searchable = " ".join(
        [session, record_type, support, timestamp, prompt, output]
    ).lower()
    return f"""
      <article class="request-card" id="request-{index}" data-session="{
        escape(session, quote=True)
    }" data-support="{support}" data-search="{escape(searchable, quote=True)}">
        <header class="request-header">
          <div>
            <div class="eyebrow">Observer call {index}</div>
            <h2>{escape(timestamp)}</h2>
            <code>{escape(observation_id)}</code>
          </div>
          <div class="badges">
            <span class="badge type">{escape(record_type)}</span>
            <span class="badge support-{support}">support: {support}</span>
            <span class="badge">{len(images)} image{
        "" if len(images) == 1 else "s"
    }</span>
            <span class="badge">{duration_label}</span>
          </div>
        </header>
        <div class="gallery">{"".join(image_cards)}</div>
        <section class="result-summary">{result_summary}</section>
        <details class="payload" open>
          <summary>Exact observer user prompt <span>{
        len(prompt):,} characters</span></summary>
          <pre>{escape(prompt)}</pre>
        </details>
        <details class="payload">
          <summary>Observer output</summary>
          <pre>{escape(output)}</pre>
        </details>
        <details class="payload">
          <summary>Request metadata and metrics</summary>
          <pre>{
        escape(
            pretty_json(
                {
                    "session": session,
                    "source_log": record.get("_source_log"),
                    "type": record_type,
                    "model": record.get("model"),
                    "timestamp": timestamp,
                    "screenshot_paths": record.get("screenshot_paths"),
                    "retained_screenshots": record.get("retained_screenshots"),
                    "llm_metrics": metrics,
                }
            )
        )
    }</pre>
        </details>
      </article>
    """


def write_review(
    records: list[dict[str, Any]],
    output_path: Path,
    session_name: str,
    system_prompt: str,
    image_count: int,
    warnings: list[str],
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    support_counts = Counter(
        str(
            parsed_output(record.get("observer_output")).get("need_support")
            or "unknown"
        ).lower()
        for record in records
    )
    session_counts = Counter(
        str(record.get("_session_name") or "unknown") for record in records
    )
    session_options = "".join(
        f'<option value="{escape(session, quote=True)}">{escape(session)} ({count})</option>'
        for session, count in session_counts.items()
    )
    generated_at = datetime.now().astimezone().isoformat(sep=" ", timespec="seconds")
    first_at = local_timestamp(records[0].get("ts")) if records else "—"
    last_at = local_timestamp(records[-1].get("ts")) if records else "—"
    warning_html = ""
    if warnings:
        warning_html = f"""
        <details class="warnings">
          <summary>{len(warnings)} collection warning{"" if len(warnings) == 1 else "s"}</summary>
          <ul>{"".join(f"<li>{escape(item)}</li>" for item in warnings)}</ul>
        </details>
        """
    cards = "".join(
        render_record(record, index) for index, record in enumerate(records, 1)
    )
    if not cards:
        cards = '<div class="empty-state">No observer calls were recorded during this test.</div>'

    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Observer inputs · {escape(session_name)}</title>
  <style>
    :root {{ color-scheme: light; --ink:#1e2928; --muted:#667370; --line:#dce4df; --paper:#f4f2ea; --card:#fffefb; --teal:#126a61; --amber:#b86f13; --red:#a53d3d; --shadow:0 18px 55px rgba(43,55,48,.10); }}
    * {{ box-sizing:border-box; }}
    html {{ scroll-behavior:smooth; }}
    body {{ margin:0; font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:radial-gradient(circle at top left,#dcefe7 0,transparent 32rem),var(--paper); }}
    button,input,select {{ font:inherit; }}
    .shell {{ width:min(1540px,calc(100% - 36px)); margin:0 auto; padding:36px 0 80px; }}
    .hero {{ display:grid; grid-template-columns:minmax(0,1fr) auto; gap:32px; align-items:end; padding:30px; border:1px solid rgba(255,255,255,.75); border-radius:26px; background:rgba(255,254,251,.86); box-shadow:var(--shadow); backdrop-filter:blur(14px); }}
    .eyebrow {{ color:var(--teal); font-size:.74rem; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }}
    h1 {{ margin:.35rem 0 .7rem; font-family:Georgia,serif; font-size:clamp(2rem,4vw,4.2rem); font-weight:500; line-height:1; }}
    .hero p {{ max-width:780px; margin:0; color:var(--muted); line-height:1.6; }}
    .privacy {{ max-width:320px; padding:16px 18px; border-radius:16px; color:#68460d; background:#fff2d6; font-size:.84rem; line-height:1.5; }}
    .metrics {{ display:grid; grid-template-columns:repeat(6,minmax(110px,1fr)); gap:12px; margin:18px 0; }}
    .metric {{ padding:18px; border:1px solid var(--line); border-radius:17px; background:var(--card); }}
    .metric strong {{ display:block; font-size:1.55rem; }} .metric span {{ display:block; margin-top:5px; color:var(--muted); font-size:.78rem; }}
    .system-prompt,.warnings {{ margin:18px 0; border:1px solid var(--line); border-radius:17px; background:var(--card); overflow:hidden; }}
    summary {{ cursor:pointer; }}
    .system-prompt summary,.warnings summary {{ padding:18px 20px; font-weight:750; }}
    .system-prompt pre {{ max-height:70vh; margin:0; padding:22px; border-top:1px solid var(--line); overflow:auto; background:#182321; color:#eef7f2; }}
    .warnings {{ color:#773e22; background:#fff7ed; }} .warnings ul {{ margin:0; padding:0 40px 20px; }}
    .toolbar {{ position:sticky; top:0; z-index:20; display:grid; grid-template-columns:minmax(240px,1fr) auto auto auto; gap:10px; margin:18px 0 24px; padding:12px; border:1px solid rgba(220,228,223,.86); border-radius:18px; background:rgba(255,254,251,.92); box-shadow:0 8px 30px rgba(43,55,48,.10); backdrop-filter:blur(16px); }}
    .toolbar input,.toolbar select {{ min-width:0; padding:11px 13px; border:1px solid var(--line); border-radius:11px; color:var(--ink); background:white; }}
    .visible-count {{ align-self:center; padding:0 8px; color:var(--muted); font-size:.84rem; white-space:nowrap; }}
    .request-card {{ margin:0 0 24px; border:1px solid var(--line); border-radius:22px; background:var(--card); box-shadow:0 10px 34px rgba(43,55,48,.07); overflow:hidden; }}
    .request-header {{ display:flex; justify-content:space-between; gap:20px; padding:22px 24px; border-bottom:1px solid var(--line); }}
    .request-header h2 {{ margin:5px 0 7px; font-size:1.35rem; }} .request-header code {{ color:var(--muted); font-size:.72rem; }}
    .badges {{ display:flex; flex-wrap:wrap; justify-content:flex-end; align-content:flex-start; gap:7px; }}
    .badge {{ padding:6px 10px; border-radius:999px; background:#edf0ed; color:#53605d; font-size:.74rem; font-weight:750; }}
    .support-yes {{ color:#8b2d26; background:#ffe1dc; }} .support-no {{ color:#226059; background:#daf0e9; }} .support-unknown {{ color:#6a5c45; background:#eee7da; }}
    .gallery {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr)); gap:14px; padding:18px 18px 8px; }}
    figure {{ min-width:0; margin:0; border:1px solid var(--line); border-radius:15px; overflow:hidden; background:#f1f3f0; }}
    .image-button {{ position:relative; display:block; width:100%; padding:0; border:0; background:#202725; cursor:zoom-in; }}
    .image-button img {{ display:block; width:100%; aspect-ratio:16/10; object-fit:contain; }}
    .image-button > span {{ position:absolute; right:9px; bottom:9px; padding:5px 8px; border-radius:7px; color:white; background:rgba(0,0,0,.65); font-size:.7rem; opacity:0; transition:.15s; }}
    .image-button:hover > span {{ opacity:1; }}
    figcaption {{ display:flex; gap:10px; align-items:flex-start; padding:11px 12px; background:white; }} figcaption strong {{ white-space:nowrap; font-size:.78rem; }} figcaption small {{ color:var(--muted); line-height:1.4; overflow-wrap:anywhere; }}
    .empty-gallery,.empty-state {{ padding:42px; color:var(--muted); text-align:center; }}
    .result-summary {{ display:grid; gap:8px; padding:12px 18px 18px; }}
    .result-summary > div {{ display:grid; grid-template-columns:110px 1fr; gap:14px; padding:11px 13px; border-radius:11px; background:#f2f5f2; }}
    .result-summary span {{ color:var(--teal); font-size:.74rem; font-weight:800; text-transform:uppercase; }} .result-summary p {{ margin:0; line-height:1.5; }} .muted {{ color:var(--muted); }}
    .payload {{ border-top:1px solid var(--line); }} .payload summary {{ display:flex; justify-content:space-between; padding:15px 20px; font-weight:750; }} .payload summary span {{ color:var(--muted); font-size:.75rem; font-weight:500; }}
    pre {{ margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }}
    .payload pre {{ max-height:72vh; padding:20px; overflow:auto; border-top:1px solid var(--line); background:#f7f8f5; }}
    dialog {{ width:min(96vw,1800px); max-width:none; padding:0; border:0; border-radius:16px; background:#111817; box-shadow:0 30px 90px rgba(0,0,0,.5); }} dialog::backdrop {{ background:rgba(4,9,8,.8); }} dialog img {{ display:block; max-width:96vw; max-height:88vh; margin:auto; object-fit:contain; }} dialog footer {{ display:flex; justify-content:space-between; align-items:center; gap:15px; padding:12px 14px; color:white; }} dialog button {{ padding:7px 11px; border:0; border-radius:8px; cursor:pointer; }}
    .hidden {{ display:none !important; }}
    @media (max-width:900px) {{ .hero {{ grid-template-columns:1fr; }} .metrics {{ grid-template-columns:repeat(2,1fr); }} .toolbar {{ grid-template-columns:1fr 1fr; }} .toolbar input {{ grid-column:1/-1; }} .request-header {{ flex-direction:column; }} .badges {{ justify-content:flex-start; }} }}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div>
        <div class="eyebrow">Isolated sensing integration test</div>
        <h1>{escape(session_name)}</h1>
        <p>This page contains only the observer calls produced by the sensing process launched for this test. It does not read Coco's normal application records.</p>
      </div>
      <div class="privacy"><strong>Local and sensitive.</strong><br>This page includes screen captures, actions, personalized memory, and model output. Keep the HTML and its asset folder private.</div>
    </section>
    <section class="metrics">
      <div class="metric"><strong>{len(records)}</strong><span>observer calls</span></div>
      <div class="metric"><strong>{image_count}</strong><span>screenshots sent</span></div>
      <div class="metric"><strong>{support_counts.get("yes", 0)}</strong><span>support = yes</span></div>
      <div class="metric"><strong>{support_counts.get("no", 0)}</strong><span>support = no</span></div>
      <div class="metric"><strong>{len(session_counts)}</strong><span>test sessions</span></div>
      <div class="metric"><strong>{first_at[11:19]}–{last_at[11:19]}</strong><span>captured local time</span></div>
    </section>
    <details class="system-prompt">
      <summary>Observer system prompt · {len(system_prompt):,} characters</summary>
      <pre>{escape(system_prompt)}</pre>
    </details>
    {warning_html}
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search prompts, outputs, actions…">
      <select id="session"><option value="all">All sessions</option>{session_options}</select>
      <select id="support"><option value="all">Any decision</option><option value="yes">Support: yes</option><option value="no">Support: no</option><option value="unknown">Malformed / unknown</option></select>
      <span class="visible-count" id="visible-count"></span>
    </div>
    <section id="requests">{cards}</section>
    <p class="muted">Generated {escape(generated_at)} from this isolated test run.</p>
  </main>
  <dialog id="lightbox"><img alt="Expanded screenshot"><footer><span></span><button type="button">Close</button></footer></dialog>
  <script>
    const cards = [...document.querySelectorAll('.request-card')];
    const search = document.querySelector('#search');
    const session = document.querySelector('#session');
    const support = document.querySelector('#support');
    const visibleCount = document.querySelector('#visible-count');
    function filterCards() {{
      const needle = search.value.trim().toLowerCase();
      let visible = 0;
      for (const card of cards) {{
        const match = (!needle || card.dataset.search.includes(needle)) &&
          (session.value === 'all' || card.dataset.session === session.value) &&
          (support.value === 'all' || card.dataset.support === support.value);
        card.classList.toggle('hidden', !match);
        if (match) visible += 1;
      }}
      visibleCount.textContent = `${{visible}} / ${{cards.length}} calls`;
    }}
    [search, session, support].forEach(el => el.addEventListener('input', filterCards));
    filterCards();
    const dialog = document.querySelector('#lightbox');
    const dialogImage = dialog.querySelector('img');
    const dialogCaption = dialog.querySelector('span');
    document.addEventListener('click', event => {{
      const button = event.target.closest('.image-button');
      if (!button) return;
      dialogImage.src = button.dataset.image;
      dialogCaption.textContent = button.dataset.caption;
      dialog.showModal();
    }});
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {{ if (event.target === dialog) dialog.close(); }});
  </script>
</body>
</html>
"""
    output_path.write_text(html, encoding="utf-8")
    return output_path


def sensing_command(args: argparse.Namespace) -> list[str]:
    return [
        sys.executable,
        "-m",
        "sensing.sensing_server",
        f"--port={args.port}",
        f"--observer_model={args.observer_model}",
        f"--check_interval={args.check_interval}",
        f"--min_actions_threshold={args.min_actions_threshold}",
        f"--observer_interval_seconds={args.observer_interval_seconds}",
        f"--mse_threshold={args.mse_threshold}",
    ]


def stop_sensing(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGINT)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def run_sensing(args: argparse.Namespace, session_dir: Path) -> int:
    environment = os.environ.copy()
    environment["COCO_RECORDS_DIR"] = str(session_dir)
    environment["COLLECT_TRAINING_SCREENSHOTS"] = "1"
    command = sensing_command(args)
    print(f"\nIsolated records: {session_dir}")
    print("Perform the monitor test now. Press Ctrl+C when finished.\n")
    process = subprocess.Popen(
        command,
        cwd=REPO_ROOT,
        env=environment,
        start_new_session=True,
    )
    try:
        if args.duration is None:
            process.wait()
        else:
            process.wait(timeout=args.duration)
    except subprocess.TimeoutExpired:
        print(f"\nReached {args.duration:g}-second duration; stopping sensing...")
        stop_sensing(process)
    except KeyboardInterrupt:
        print("\nStopping sensing and building the review...")
        stop_sensing(process)
    return process.returncode or 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.system_prompt.is_file():
        print(
            f"error: system prompt does not exist: {args.system_prompt}",
            file=sys.stderr,
        )
        return 2

    session_name = datetime.now().astimezone().strftime("session_%Y%m%d_%H%M%S_%f")
    session_dir = args.output_root.resolve() / session_name
    session_dir.mkdir(parents=True)
    sensing_exit_code = run_sensing(args, session_dir)

    output_path = session_dir / "review.html"
    records, warnings = load_records(session_dir)
    image_count, image_warnings = prepare_images(
        records, output_path, copy_images=not args.no_copy_images
    )
    warnings.extend(image_warnings)
    system_prompt = args.system_prompt.read_text(encoding="utf-8")
    write_review(
        records,
        output_path,
        session_name,
        system_prompt,
        image_count,
        warnings,
    )
    print(
        json.dumps(
            {
                "session": session_name,
                "sensing_exit_code": sensing_exit_code,
                "records": len(records),
                "images": image_count,
                "warnings": len(warnings),
                "output": str(output_path.resolve()),
            },
            indent=2,
        )
    )
    if not args.no_open and sys.platform == "darwin":
        subprocess.Popen(["open", str(output_path)], start_new_session=True)
    if records:
        return 0
    return sensing_exit_code or 1


if __name__ == "__main__":
    raise SystemExit(main())
