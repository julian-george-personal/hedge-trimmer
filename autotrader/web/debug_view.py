import html
from decimal import Decimal

MAX_ROWS_DISPLAYED = 200

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>hedge trimmer - dashboard</title>
<style>
  :root {{
    --bg: #0f1115;
    --panel: #161922;
    --border: #262b38;
    --text: #e6e9f0;
    --text-dim: #8b93a7;
    --accent: #4f8cff;
    --yes: #3fbf7f;
    --no: #e0555a;
  }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; background: var(--bg); color: var(--text); max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }}
  h1 {{ font-size: 18px; font-weight: 600; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  .nav {{ margin-bottom: 1.5rem; padding-bottom: 12px; border-bottom: 1px solid var(--border); }}
  .hint {{ color: var(--text-dim); font-size: 12px; margin-bottom: 1rem; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 0.5rem; }}
  th, td {{ text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }}
  th {{ color: var(--text-dim); font-weight: 500; }}
  .badge {{ display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 11px; font-weight: 600; }}
  .badge.passed {{ background: rgba(63, 191, 127, 0.12); color: var(--yes); }}
  .badge.filtered {{ background: rgba(224, 85, 90, 0.12); color: var(--no); }}
  .badge.already_positioned {{ background: rgba(79, 140, 255, 0.15); color: var(--accent); }}
  .reason {{ color: var(--text-dim); }}
</style>
</head>
<body>
<div class="nav"><a href="/">&larr; Back to dashboard</a></div>
<h1>Market decision log</h1>
<p class="hint">Every match the trader has evaluated once it entered the lead-time window &mdash; i.e. the point it
actually decided whether to bet &mdash; with the filter outcome and, if skipped, why. Persisted every tick, so this
is history, not a live snapshot.</p>
{truncated_note}
<table>
  <tr><th>Scanned at</th><th>Match</th><th>Status</th><th>Reason / detail</th></tr>
  {rows}
</table>
</body>
</html>
"""

_STATUS_LABELS = {
    "passed": "Passed",
    "filtered": "Filtered out",
    "already_positioned": "Already positioned",
}

_ROW = (
    "<tr><td>{scanned_at}</td>"
    "<td>{teams}<br><span class=\"reason\">{event_ticker}</span></td>"
    "<td><span class=\"badge {status}\">{status_label}</span></td>"
    "<td class=\"reason\">{detail}</td></tr>"
)


def _as_float(value) -> float | None:
    return float(value) if isinstance(value, Decimal) else value


def _passed_detail(item: dict) -> str:
    return (
        f"side: {html.escape(item.get('side_team_name') or '')} &middot; "
        f"entry: ${_as_float(item.get('entry_price_dollars')):.2f} &middot; "
        f"win prob: {_as_float(item.get('win_prob_percent')):.1f}% &middot; "
        f"volume: {_as_float(item.get('volume')):.0f}"
    )


def _row(item: dict) -> str:
    status = item.get("status", "")
    detail = _passed_detail(item) if status == "passed" else html.escape(item.get("reason") or "")
    return _ROW.format(
        scanned_at=html.escape(item.get("scanned_at", "")),
        teams=html.escape(" vs ".join(item.get("team_names", []))),
        event_ticker=html.escape(item.get("event_ticker", "")),
        status=status,
        status_label=_STATUS_LABELS.get(status, status),
        detail=detail,
    )


def render_debug_view(scan_records: list[dict]) -> str:
    sorted_records = sorted(scan_records, key=lambda r: r.get("scanned_at", ""), reverse=True)
    shown = sorted_records[:MAX_ROWS_DISPLAYED]
    truncated_note = (
        f'<p class="hint">Showing the {MAX_ROWS_DISPLAYED} most recent of {len(sorted_records)} recorded decisions.</p>'
        if len(sorted_records) > MAX_ROWS_DISPLAYED
        else ""
    )
    return _PAGE.format(
        truncated_note=truncated_note,
        rows="".join(_row(r) for r in shown) or "<tr><td colspan=4>no decisions recorded yet</td></tr>",
    )
