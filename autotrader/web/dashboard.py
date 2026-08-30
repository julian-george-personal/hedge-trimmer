import html
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from autotrader.storage.config import TradingConfig
from autotrader.trading.loop import SCAN_INTERVAL_SECONDS

MAX_DECISION_ROWS_DISPLAYED = 200
MAX_TRADE_ROWS_DISPLAYED = 200

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>hedge trimmer - dashboard</title>
<style>
  :root {{
    --bg: #ffffff;
    --panel: #ffffff;
    --border: #dde1e8;
    --text: #1b1f27;
    --text-dim: #667085;
    --accent: #2563eb;
    --yes: #15803d;
    --no: #dc2626;
    --warn: #b45309;
  }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; background: var(--bg); color: var(--text); max-width: 1400px; margin: 0 auto; padding: 24px 16px 48px; }}
  .narrow {{ max-width: 760px; margin: 0 auto; }}
  h1, h2 {{ font-weight: 600; }}
  h1 {{ font-size: 18px; }}
  h2 {{ font-size: 15px; margin-top: 2rem; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  .status {{ display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; background: var(--panel); border: 1px solid var(--border); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }}
  .status.running {{ border-color: var(--yes); background: rgba(63, 191, 127, 0.08); }}
  .status.stopped {{ border-color: var(--no); background: rgba(224, 85, 90, 0.08); }}
  .status-left, .status-right {{ display: flex; align-items: center; gap: 0.6rem; }}
  .mode-label.armed {{ color: var(--no); font-weight: 600; }}
  .mode-label.dry {{ color: var(--yes); font-weight: 600; }}
  .switch {{ position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }}
  .switch input {{ opacity: 0; width: 0; height: 0; }}
  .switch .slider {{ position: absolute; inset: 0; cursor: pointer; background-color: var(--yes); transition: background-color 0.15s ease; border-radius: 999px; }}
  .switch .slider::before {{ content: ""; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: #fff; transition: transform 0.15s ease; border-radius: 50%; }}
  .switch input:checked + .slider {{ background-color: var(--no); }}
  .switch input:checked + .slider::before {{ transform: translateX(18px); }}
  .switch input:focus-visible + .slider {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
  .banner.saved {{ padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; background: rgba(63, 191, 127, 0.12); border: 1px solid var(--yes); color: var(--yes); transition: opacity 0.4s ease; }}
  form.controls {{ display: inline; }}
  button {{ font: inherit; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.9rem; margin-right: 0.5rem; cursor: pointer; }}
  button:hover {{ border-color: var(--accent); }}
  button.danger {{ background: rgba(224, 85, 90, 0.12); border-color: var(--no); color: var(--no); }}
  button.icon-btn {{ padding: 0.4rem 0.6rem; line-height: 0; }}
  button.icon-btn svg {{ display: block; width: 16px; height: 16px; }}
  button.icon-btn.stop {{ background: rgba(224, 85, 90, 0.12); border-color: var(--no); color: var(--no); }}
  button.icon-btn.play {{ background: rgba(63, 191, 127, 0.12); border-color: var(--yes); color: var(--yes); }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 0.5rem; }}
  th, td {{ text-align: center; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 13px; }}
  th.col-text, td.col-text {{ text-align: left; }}
  th {{ color: var(--text-dim); font-weight: 500; }}
  label {{ display: block; margin-top: 0.6rem; font-size: 12px; color: var(--text-dim); }}
  input, select {{ font: inherit; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem; }}
  input:focus, select:focus {{ outline: none; border-color: var(--accent); }}
  .row {{ display: flex; gap: 1rem; }}
  .row > div {{ flex: 1; }}
  .save {{ margin-top: 1rem; }}
  .hint {{ color: var(--text-dim); font-size: 12px; margin-bottom: 1rem; max-width: 760px; }}
  .badge {{ display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 11px; font-weight: 600; }}
  .badge.passed {{ background: rgba(63, 191, 127, 0.12); color: var(--yes); }}
  .badge.filtered {{ background: rgba(224, 85, 90, 0.12); color: var(--no); }}
  .badge.already_positioned {{ background: rgba(79, 140, 255, 0.15); color: var(--accent); }}
  .badge.buy {{ background: rgba(224, 177, 63, 0.15); color: var(--warn); }}
  .badge.sell-profit {{ background: rgba(63, 191, 127, 0.12); color: var(--yes); }}
  .badge.sell-loss {{ background: rgba(224, 85, 90, 0.12); color: var(--no); }}
  .badge.sell {{ background: rgba(79, 140, 255, 0.15); color: var(--accent); }}
  .reason {{ color: var(--text-dim); }}
  .dry-run-marker {{ color: var(--warn); cursor: help; }}
  .return-pos {{ color: var(--yes); }}
  .return-neg {{ color: var(--no); }}
  details.log-section {{ margin-top: 2rem; }}
  details.log-section summary {{ cursor: pointer; font-weight: 600; font-size: 15px; padding: 0.5rem 0; list-style: none; }}
  details.log-section summary::-webkit-details-marker {{ display: none; }}
  details.log-section summary::before {{ content: "\\25b8"; display: inline-block; margin-right: 0.4rem; color: var(--text-dim); transition: transform 0.15s ease; }}
  details.log-section[open] summary::before {{ transform: rotate(90deg); }}
  details.log-section summary .count {{ color: var(--text-dim); font-weight: 400; }}
</style>
</head>
<body>
<h1>hedge trimmer</h1>

<div class="narrow">
<div id="saved-banner">{saved_banner}</div>

<div class="status {running_class}">
  <div class="status-left">
    <strong>{running_label}</strong>
    <form class="controls" method="post" action="/control">
      <input type="hidden" name="action" value="{toggle_run_action}">
      <button type="submit" class="icon-btn {toggle_run_class}" title="{toggle_run_label}" aria-label="{toggle_run_label}">{toggle_run_icon}</button>
    </form>
  </div>
  <div class="status-right">
    <span class="mode-label {armed_class}">{armed_label}</span>
    <form class="controls" method="post" action="/control" id="armed-form">
      <input type="hidden" name="action" id="armed-action-input" value="{toggle_armed_action}">
      <label class="switch" title="Toggle live vs dummy betting">
        <input type="checkbox" id="armed-toggle" {armed_checked} onchange="autotraderOnArmedToggle(this)">
        <span class="slider"></span>
      </label>
    </form>
  </div>
</div>

<h2>Filters</h2>
<form method="post" action="/config">
  <div class="row">
    <div>
      <label>Side</label>
      <select name="side">
        <option value="underdog" {underdog_selected}>Underdog</option>
        <option value="overdog" {overdog_selected}>Overdog</option>
      </select>
    </div>
    <div>
      <label>Bet per match ($)</label>
      <input type="number" step="0.01" name="bet_per_match_dollars" value="{bet_per_match_dollars}">
    </div>
    <div>
      <label>Order style</label>
      <select name="order_style">
        <option value="limit" {limit_selected}>Limit</option>
        <option value="market" {market_selected}>Market</option>
      </select>
    </div>
  </div>
  <div class="row">
    <div>
      <label>Pre-match volume min</label>
      <input type="number" step="1" name="pre_match_volume_min" value="{pre_match_volume_min}">
    </div>
    <div>
      <label>Pre-match volume max</label>
      <input type="number" step="1" name="pre_match_volume_max" value="{pre_match_volume_max}">
    </div>
  </div>
  <div class="row">
    <div>
      <label>Win probability min (%)</label>
      <input type="number" step="0.1" name="win_prob_min" value="{win_prob_min}">
    </div>
    <div>
      <label>Win probability max (%)</label>
      <input type="number" step="0.1" name="win_prob_max" value="{win_prob_max}">
    </div>
  </div>
  <div class="row">
    <div>
      <label>Stop-loss (% of entry price, 0 = disabled)</label>
      <input type="number" step="0.1" name="stop_loss_percent" value="{stop_loss_percent}">
    </div>
    <div>
      <label>Take-profit (% gain over entry price)</label>
      <input type="number" step="0.1" name="take_profit_percent" value="{take_profit_percent}">
    </div>
    <div>
      <label>Lead time (minutes before match start)</label>
      <input type="number" step="1" name="lead_time_minutes" value="{lead_time_minutes}">
    </div>
  </div>
  <div class="save"><button type="submit">Apply filters</button></div>
</form>
</div>

<h2>Open Positions</h2>
<table>
  <tr><th class="col-text">Match</th><th>Bought</th><th>Contracts</th><th>Entry</th></tr>
  {position_rows}
</table>

<details class="log-section">
  <summary>Closed positions <span class="count">({closed_position_count})</span></summary>
  <table>
    <tr><th class="col-text">Match</th><th>Bought / Sold</th><th>Contracts</th><th>Entry</th><th>Exit</th><th>Return</th><th>Reason</th></tr>
    {closed_position_rows}
  </table>
</details>

<details class="log-section">
  <summary>Trading log <span class="count">({trade_count} fills)</span></summary>
  <p class="hint">Every buy and sell the trader has placed (or would have, in dry run), most recent first.</p>
  {trade_truncated_note}
  <table>
    <tr><th>Time</th><th>Action</th><th class="col-text">Match</th><th>Ticker</th><th>Contracts</th><th>Price</th><th class="col-text">Detail</th><th>Mode</th></tr>
    {trade_rows}
  </table>
</details>

<details class="log-section">
  <summary>Decision log <span class="count">({decision_count} evaluated)</span></summary>
  <p class="hint">Every match the trader has evaluated once it entered the lead-time window &mdash; i.e. the point it
  actually decided whether to bet &mdash; with the filter outcome and, if skipped, why. Persisted every tick, so this
  is history, not a live snapshot.</p>
  {decision_truncated_note}
  <table>
    <tr><th>Scanned at</th><th class="col-text">Match</th><th>Status</th><th class="col-text">Reason / detail</th></tr>
    {decision_rows}
  </table>
</details>

<script>
function autotraderOnArmedToggle(checkbox) {{
  if (checkbox.checked && !confirm('Arm live trading? This will place real orders with real money.')) {{
    checkbox.checked = false;
    return;
  }}
  document.getElementById('armed-action-input').value = checkbox.checked ? 'arm' : 'disarm';
  document.getElementById('armed-form').submit();
}}

(function autotraderFadeSavedBanner() {{
  var banner = document.querySelector('#saved-banner .banner.saved');
  if (!banner) return;
  setTimeout(function() {{
    banner.style.opacity = '0';
    setTimeout(function() {{ banner.remove(); }}, 400);
  }}, 3000);
  var url = new URL(window.location.href);
  if (url.searchParams.has('saved')) {{
    url.searchParams.delete('saved');
    window.history.replaceState({{}}, '', url);
  }}
}})();
</script>

</body>
</html>
"""

_DRY_RUN_MARKER = '<span class="dry-run-marker" title="Dry run — no real order was placed">*</span>'

_OPEN_ROW = (
    "<tr><td class=\"col-text\">{match_label}{dry_run_marker}<br><span class=\"reason\">{ticker}</span></td>"
    "<td>{buy_time}</td>"
    "<td>{contracts}</td>"
    "<td>${entry:.2f}</td></tr>"
)

_CLOSED_ROW = (
    "<tr><td class=\"col-text\">{match_label}{dry_run_marker}<br><span class=\"reason\">{ticker}</span></td>"
    "<td>{buy_time}<br><span class=\"reason\">{sell_time}</span></td>"
    "<td>{contracts}</td>"
    "<td>${entry:.2f}</td><td>{exit}</td>"
    "<td>{return_cell}</td><td>{reason}</td></tr>"
)

_STOP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>'
_PLAY_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>'

_DECISION_STATUS_LABELS = {
    "passed": "Passed",
    "filtered": "Filtered out",
    "already_positioned": "Already positioned",
}

_DECISION_ROW = (
    "<tr><td>{scanned_at}</td>"
    "<td class=\"col-text\">{teams}<br><span class=\"reason\">{event_ticker}</span></td>"
    "<td><span class=\"badge {status}\">{status_label}</span></td>"
    "<td class=\"reason col-text\">{detail}</td></tr>"
)


def _return_cell(entry_price: float, exit_price: float | None, contracts: int) -> str:
    if exit_price is None or not entry_price:
        return "-"
    dollars = (exit_price - entry_price) * contracts
    percent = (exit_price - entry_price) / entry_price * 100
    css_class = "return-pos" if dollars >= 0 else "return-neg"
    sign = "+" if dollars >= 0 else "-"
    return (
        f'<span class="{css_class}">{sign}${abs(dollars):.2f}</span>'
        f'<br><span class="reason">{percent:+.0f}%</span>'
    )


def _match_label(position: dict) -> str:
    bet_team = position.get("team_name") or "-"
    team_names = position.get("team_names")
    if team_names and len(team_names) == 2:
        return f"{html.escape(team_names[0])} vs {html.escape(team_names[1])} ({html.escape(bet_team)})"
    return html.escape(bet_team)


def _open_position_row(position: dict) -> str:
    return _OPEN_ROW.format(
        match_label=_match_label(position),
        dry_run_marker=_DRY_RUN_MARKER if position.get("dry_run", True) else "",
        ticker=html.escape(position.get("ticker", "")),
        contracts=position.get("contracts", 0),
        entry=float(position.get("entry_price_dollars", 0)),
        buy_time=html.escape(_to_second_precision(position.get("entry_time", ""))),
    )


def _closed_position_row(position: dict) -> str:
    entry_price = float(position.get("entry_price_dollars", 0))
    exit_price = position.get("exit_price_dollars")
    exit_price_float = float(exit_price) if exit_price is not None else None
    contracts = int(position.get("contracts", 0))
    return _CLOSED_ROW.format(
        match_label=_match_label(position),
        dry_run_marker=_DRY_RUN_MARKER if position.get("dry_run", True) else "",
        ticker=html.escape(position.get("ticker", "")),
        contracts=contracts,
        entry=entry_price,
        buy_time=html.escape(_to_second_precision(position.get("entry_time", ""))),
        exit=f"${exit_price_float:.2f}" if exit_price_float is not None else "-",
        sell_time=html.escape(_to_second_precision(position.get("exit_time", ""))) if position.get("exit_time") else "-",
        return_cell=_return_cell(entry_price, exit_price_float, contracts),
        reason=html.escape(str(position.get("exit_reason", "-"))),
    )


def _as_float(value) -> float | None:
    return float(value) if isinstance(value, Decimal) else value


_ACTION_NOTES = {
    "skipped_too_small": "bet size too small to buy 1 contract — no position taken",
    "order_failed": "order placement failed — no position taken (see server logs)",
}


def _decision_outcome_note(item: dict) -> str | None:
    """Explains why a "passed" decision has no corresponding row in the
    Positions table, for the cases where that's not itself a bug."""
    if item.get("trader_enabled") is False:
        return "trader was stopped — no position taken"
    action = item.get("action")
    if action == "order_failed" and item.get("action_error"):
        return f"order placement failed ({item['action_error']}) — no position taken (see server logs)"
    return _ACTION_NOTES.get(action)


def _decision_passed_detail(item: dict) -> str:
    detail = (
        f"side: {html.escape(item.get('side_team_name') or '')} &middot; "
        f"entry: ${_as_float(item.get('entry_price_dollars')):.2f} &middot; "
        f"win prob: {_as_float(item.get('win_prob_percent')):.1f}% &middot; "
        f"volume: {_as_float(item.get('volume')):.0f}"
    )
    note = _decision_outcome_note(item)
    return f"{detail} &middot; {html.escape(note)}" if note else detail


def _to_second_precision(iso_timestamp: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_timestamp).astimezone(ZoneInfo("America/New_York"))
        return dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    except ValueError:
        return iso_timestamp


def _decision_row(item: dict) -> str:
    status = item.get("status", "")
    detail = _decision_passed_detail(item) if status == "passed" else html.escape(item.get("reason") or "")
    return _DECISION_ROW.format(
        scanned_at=html.escape(_to_second_precision(item.get("scanned_at", ""))),
        teams=html.escape(" vs ".join(item.get("team_names", []))),
        event_ticker=html.escape(item.get("event_ticker", "")),
        status=status,
        status_label=_DECISION_STATUS_LABELS.get(status, status),
        detail=detail,
    )


_TRADE_ROW = (
    "<tr><td>{time}</td>"
    "<td><span class=\"badge {badge_class}\">{action_label}</span></td>"
    "<td class=\"col-text\">{team_name}<br><span class=\"reason\">{event_ticker}</span></td>"
    "<td>{ticker}</td><td>{contracts}</td><td>${price:.2f}</td>"
    "<td class=\"reason col-text\">{detail}</td><td>{mode}</td></tr>"
)

_SELL_BADGE_CLASSES = {"take_profit": "sell-profit", "stop_loss": "sell-loss"}


def _position_trade_events(position: dict) -> list[dict]:
    event_ticker = position["PK"].removeprefix("POSITION#")
    mode = "dry-run" if position.get("dry_run", True) else "live"
    events = [
        {
            "time": position.get("entry_time", ""),
            "badge_class": "buy",
            "action_label": "Buy",
            "team_name": position.get("team_name", ""),
            "event_ticker": event_ticker,
            "ticker": position.get("ticker", ""),
            "contracts": position.get("contracts", ""),
            "price": _as_float(position.get("entry_price_dollars")) or 0.0,
            "detail": f"order {html.escape(str(position['order_id']))}" if position.get("order_id") else "-",
            "mode": mode,
        }
    ]
    if position.get("status") == "closed":
        reason = html.escape(position.get("exit_reason") or "-")
        order_id = html.escape(str(position["exit_order_id"])) if position.get("exit_order_id") else None
        events.append(
            {
                "time": position.get("exit_time", ""),
                "badge_class": _SELL_BADGE_CLASSES.get(position.get("exit_reason"), "sell"),
                "action_label": "Sell",
                "team_name": position.get("team_name", ""),
                "event_ticker": event_ticker,
                "ticker": position.get("ticker", ""),
                "contracts": position.get("contracts", ""),
                "price": _as_float(position.get("exit_price_dollars")) or 0.0,
                "detail": f"{reason} &middot; order {order_id}" if order_id else reason,
                "mode": mode,
            }
        )
    return events


def _trade_row(event: dict) -> str:
    return _TRADE_ROW.format(
        time=html.escape(_to_second_precision(event["time"])),
        badge_class=event["badge_class"],
        action_label=event["action_label"],
        team_name=html.escape(event["team_name"]),
        event_ticker=html.escape(event["event_ticker"]),
        ticker=html.escape(event["ticker"]),
        contracts=event["contracts"],
        price=event["price"],
        detail=event["detail"],
        mode=event["mode"],
    )


def render_dashboard(
    config: TradingConfig,
    positions: list[dict],
    market_scans: list[dict],
    saved: bool = False,
) -> str:
    sorted_positions = sorted(positions, key=lambda p: p.get("entry_time", ""), reverse=True)
    active_positions = [p for p in sorted_positions if p.get("status") != "closed"]
    closed_positions = [p for p in sorted_positions if p.get("status") == "closed"]
    sorted_scans = sorted(market_scans, key=lambda r: r.get("scanned_at", ""), reverse=True)
    shown_scans = sorted_scans[:MAX_DECISION_ROWS_DISPLAYED]
    decision_truncated_note = (
        f'<p class="hint">Showing the {MAX_DECISION_ROWS_DISPLAYED} most recent of {len(sorted_scans)} recorded decisions.</p>'
        if len(sorted_scans) > MAX_DECISION_ROWS_DISPLAYED
        else ""
    )
    trade_events = sorted(
        (event for position in positions for event in _position_trade_events(position)),
        key=lambda e: e["time"],
        reverse=True,
    )
    shown_trades = trade_events[:MAX_TRADE_ROWS_DISPLAYED]
    trade_truncated_note = (
        f'<p class="hint">Showing the {MAX_TRADE_ROWS_DISPLAYED} most recent of {len(trade_events)} fills.</p>'
        if len(trade_events) > MAX_TRADE_ROWS_DISPLAYED
        else ""
    )
    return _PAGE.format(
        saved_banner=(
            '<div class="banner saved">&#10003; Filters applied. The running loop will use these values on its '
            f"next tick (within {SCAN_INTERVAL_SECONDS}s).</div>"
            if saved
            else ""
        ),
        running_class="running" if config.enabled else "stopped",
        running_label="Running" if config.enabled else "Stopped",
        armed_class="armed" if config.armed else "dry",
        armed_label="ARMED (live orders)" if config.armed else "Dry run (no real orders)",
        toggle_run_action="stop" if config.enabled else "start",
        toggle_run_label="Stop" if config.enabled else "Start",
        toggle_run_class="stop" if config.enabled else "play",
        toggle_run_icon=_STOP_ICON if config.enabled else _PLAY_ICON,
        toggle_armed_action="disarm" if config.armed else "arm",
        armed_checked="checked" if config.armed else "",
        underdog_selected="selected" if config.side == "underdog" else "",
        overdog_selected="selected" if config.side == "overdog" else "",
        limit_selected="selected" if config.order_style == "limit" else "",
        market_selected="selected" if config.order_style == "market" else "",
        bet_per_match_dollars=config.bet_per_match_dollars,
        pre_match_volume_min=config.pre_match_volume_min,
        pre_match_volume_max=config.pre_match_volume_max,
        win_prob_min=config.win_prob_min,
        win_prob_max=config.win_prob_max,
        stop_loss_percent=config.stop_loss_percent,
        take_profit_percent=config.take_profit_percent,
        lead_time_minutes=config.lead_time_minutes,
        position_rows="".join(_open_position_row(p) for p in active_positions) or "<tr><td colspan=4>none open</td></tr>",
        closed_position_count=len(closed_positions),
        closed_position_rows="".join(_closed_position_row(p) for p in closed_positions) or "<tr><td colspan=7>none yet</td></tr>",
        trade_count=len(trade_events),
        trade_truncated_note=trade_truncated_note,
        trade_rows="".join(_trade_row(e) for e in shown_trades) or "<tr><td colspan=8>no trades yet</td></tr>",
        decision_count=len(sorted_scans),
        decision_truncated_note=decision_truncated_note,
        decision_rows="".join(_decision_row(r) for r in shown_scans) or "<tr><td colspan=4>no decisions recorded yet</td></tr>",
    )
