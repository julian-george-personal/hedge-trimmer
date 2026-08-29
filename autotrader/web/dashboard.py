import html

from autotrader.storage.config import TradingConfig

_PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Autotrader</title>
<style>
  body {{ font-family: -apple-system, sans-serif; background: #0f1115; color: #e6e6e6; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }}
  h1, h2 {{ font-weight: 600; }}
  .status {{ padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }}
  .status.running {{ background: #14351f; }}
  .status.stopped {{ background: #35291d; }}
  .status.armed {{ color: #ff8080; font-weight: 600; }}
  .status.dry {{ color: #9fd39f; }}
  form.controls {{ display: inline; }}
  button {{ background: #2a2f3a; color: #e6e6e6; border: 1px solid #444; border-radius: 6px; padding: 0.4rem 0.9rem; margin-right: 0.5rem; cursor: pointer; }}
  button.danger {{ background: #4a1f1f; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 0.5rem; }}
  th, td {{ text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #2a2f3a; font-size: 0.9rem; }}
  label {{ display: block; margin-top: 0.6rem; font-size: 0.85rem; color: #aaa; }}
  input, select {{ width: 100%; box-sizing: border-box; background: #1a1d24; color: #e6e6e6; border: 1px solid #444; border-radius: 6px; padding: 0.4rem; }}
  .row {{ display: flex; gap: 1rem; }}
  .row > div {{ flex: 1; }}
  .save {{ margin-top: 1rem; }}
</style>
</head>
<body>
<h1>Autotrader</h1>

<div class="status {running_class}">
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
  <div class="save"><button type="submit">Save filters</button></div>
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


def render_dashboard(config: TradingConfig, positions: list[dict]) -> str:
    sorted_positions = sorted(positions, key=lambda p: p.get("entry_time", ""), reverse=True)
    return _PAGE.format(
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
