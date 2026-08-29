import html
from datetime import datetime, timezone

from autotrader.storage.config import TradingConfig
from autotrader.trading.loop import POLL_INTERVAL_SECONDS

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>autotrader</title>
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
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; background: var(--bg); color: var(--text); max-width: 900px; margin: 0 auto; padding: 24px 16px 48px; }}
  h1, h2 {{ font-weight: 600; }}
  h1 {{ font-size: 18px; }}
  h2 {{ font-size: 15px; margin-top: 2rem; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  .nav {{ margin-bottom: 1.5rem; padding-bottom: 12px; border-bottom: 1px solid var(--border); }}
  .status {{ background: var(--panel); border: 1px solid var(--border); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }}
  .status.armed {{ color: var(--no); font-weight: 600; }}
  .status.dry {{ color: var(--yes); font-weight: 600; }}
  .banner.saved {{ padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; background: rgba(63, 191, 127, 0.12); border: 1px solid var(--yes); color: var(--yes); }}
  .save-meta {{ margin-top: 0.6rem; font-size: 12px; color: var(--text-dim); }}
  form.controls {{ display: inline; }}
  button {{ font: inherit; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.9rem; margin-right: 0.5rem; cursor: pointer; }}
  button:hover {{ border-color: var(--accent); }}
  button.danger {{ background: rgba(224, 85, 90, 0.12); border-color: var(--no); color: var(--no); }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 0.5rem; }}
  th, td {{ text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 13px; }}
  th {{ color: var(--text-dim); font-weight: 500; }}
  label {{ display: block; margin-top: 0.6rem; font-size: 12px; color: var(--text-dim); }}
  input, select {{ font: inherit; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem; }}
  input:focus, select:focus {{ outline: none; border-color: var(--accent); }}
  .row {{ display: flex; gap: 1rem; }}
  .row > div {{ flex: 1; }}
  .save {{ margin-top: 1rem; }}
</style>
</head>
<body>
<h1>autotrader</h1>
<div class="nav"><a href="/debug">Decision log &rarr;</a></div>

{saved_banner}

<div class="status">
  <strong>{running_label}</strong> &middot; <span class="status {armed_class}">{armed_label}</span>
  <form class="controls" method="post" action="/control">
    <input type="hidden" name="action" value="{toggle_run_action}">
    <button type="submit">{toggle_run_label}</button>
  </form>
  <form class="controls" method="post" action="/control" {armed_confirm}>
    <input type="hidden" name="action" value="{toggle_armed_action}">
    <button type="submit" class="{armed_button_class}">{toggle_armed_label}</button>
  </form>
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
  <div class="save-meta">{last_saved_text}</div>
</form>

<h2>Positions</h2>
<table>
  <tr><th>Match</th><th>Status</th><th>Ticker</th><th>Contracts</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Mode</th></tr>
  {position_rows}
</table>

</body>
</html>
"""

_ROW = (
    "<tr><td>{event}</td><td>{status}</td><td>{ticker}</td><td>{contracts}</td>"
    "<td>${entry:.2f}</td><td>{exit}</td><td>{reason}</td><td>{mode}</td></tr>"
)


def _position_row(position: dict) -> str:
    exit_price = position.get("exit_price_dollars")
    return _ROW.format(
        event=html.escape(position["PK"].removeprefix("POSITION#")),
        status=html.escape(position.get("status", "")),
        ticker=html.escape(position.get("ticker", "")),
        contracts=position.get("contracts", ""),
        entry=float(position.get("entry_price_dollars", 0)),
        exit=f"${float(exit_price):.2f}" if exit_price is not None else "-",
        reason=html.escape(str(position.get("exit_reason", "-"))),
        mode="dry-run" if position.get("dry_run", True) else "live",
    )


def _relative_time_ago(iso_timestamp: str, now: datetime) -> str:
    seconds = (now - datetime.fromisoformat(iso_timestamp)).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)}m ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h ago"
    return f"{int(seconds // 86400)}d ago"


def _last_applied_text(config: TradingConfig) -> str:
    if not config.filters_updated_at:
        return "Not applied yet &mdash; showing defaults."
    ago = _relative_time_ago(config.filters_updated_at, datetime.now(timezone.utc))
    scope = (
        "New-entry filters are active now since the trader is Running."
        if config.enabled
        else "New-entry filters won't be used until you click Start; stop-loss/take-profit still apply to any open position."
    )
    return f"Filters last applied {ago}. {scope}"


def render_dashboard(config: TradingConfig, positions: list[dict], saved: bool = False) -> str:
    sorted_positions = sorted(positions, key=lambda p: p.get("entry_time", ""), reverse=True)
    return _PAGE.format(
        saved_banner=(
            '<div class="banner saved">&#10003; Filters applied. The running loop will use these values on its '
            f"next tick (within {POLL_INTERVAL_SECONDS}s).</div>"
            if saved
            else ""
        ),
        last_saved_text=_last_applied_text(config),
        running_class="running" if config.enabled else "stopped",
        running_label="Running" if config.enabled else "Stopped",
        armed_class="armed" if config.armed else "dry",
        armed_label="ARMED (live orders)" if config.armed else "Dry run (no real orders)",
        toggle_run_action="stop" if config.enabled else "start",
        toggle_run_label="Stop" if config.enabled else "Start",
        toggle_armed_action="disarm" if config.armed else "arm",
        toggle_armed_label="Disarm" if config.armed else "Arm (place real orders)",
        armed_button_class="" if config.armed else "danger",
        armed_confirm="" if config.armed else 'onsubmit="return confirm(\'Arm live trading? This will place real orders with real money.\');"',
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
        position_rows="".join(_position_row(p) for p in sorted_positions) or "<tr><td colspan=8>none yet</td></tr>",
    )
