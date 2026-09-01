// The "optimal filter combination" widget — grid-searches pre-match volume
// range x win-probability range x stop-loss x take-profit threshold for
// whichever combination maximizes % return on cumulative stake. IIFE-wrapped
// so its helpers (simulateMatchProfit, bestDollarPoint, etc.) stay private
// to this file rather than leaking into the global scope shared with
// analysis-core.js and any other widget-*.js files — see analysis-core.js
// for the registerWidget contract this file plugs into.
(function () {

const OPTIMIZER_MIN_THRESHOLD = 100;
const OPTIMIZER_MAX_THRESHOLD = 1000;

// Price is a bid/ask midpoint capped at $1 (a contract settles at $0 or
// $1), so a threshold implying a target above $1 can never be hit no matter
// the match outcome. Counting those matches as "total loss" bets would
// score a bet no rational trader would place; exclude them from the
// eligible set instead of folding them into the miss column.
const PRICE_CEILING = 1;

function isThresholdReachable(startPrice, factor) {
  return factor * startPrice <= PRICE_CEILING;
}

// Binary-searches a record-high/record-low breakpoint array (see
// _running_extrema_breakpoints in price_spike.py — [price, secondsOffset]
// pairs, sorted by time, monotonic in price) for the earliest breakpoint
// whose price satisfies `reaches`. Once a breakpoint satisfies it, every
// later one does too (prices only move further from the start in one
// direction), so this is a standard "first true" binary search rather than
// a linear scan of the raw per-minute series.
function firstTouch(breakpoints, reaches) {
  let lo = 0;
  let hi = breakpoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reaches(breakpoints[mid][0])) hi = mid;
    else lo = mid + 1;
  }
  return lo < breakpoints.length ? { price: breakpoints[lo][0], t: breakpoints[lo][1] } : null;
}

// Per-leg trading fee, shaped after Kalshi's documented general formula:
// ceil(rate * contracts * price * (1-price)), rounded up to the cent — peaks
// at price=0.5, tapering toward the extremes. Kalshi's published taker fee
// peaks at 1.75% (rate 0.07); Polymarket's sports-market taker fee peaks at
// roughly 0.75% (rate 0.03) per public reporting as of 2026-08. Neither is
// confirmed against the CS2 series or this backfill's specific period —
// treat the fee-simulation numbers as an estimate, not a verified replay of
// what either venue actually charged.
const FEE_SIM_RATES = { kalshi: 0.07, polymarket: 0.03 };
const FEE_SIM_LABELS = { kalshi: "Kalshi", polymarket: "Polymarket" };

function simulatedFee(feeSim, contracts, price) {
  const rate = FEE_SIM_RATES[feeSim];
  if (!rate) return 0;
  return Math.ceil(rate * contracts * price * (1 - price) * 100) / 100;
}

// Replays one match's actual price path (via its tp/sl breakpoints) to find
// whichever of the take-profit threshold or stop-loss level was crossed
// *first in time*. Falls back to the last observed price (a reasonable
// settlement proxy) if neither level was ever touched in the data. Returns
// dollar profit for `betAmount` worth of whole contracts bought at the
// start price, or null if the threshold is unreachable (mirrors
// isThresholdReachable) or, in realistic mode, if the match has no ask-side
// data to enter with.
//
// spread, when true, switches from the naive bid/ask-midpoint fill (buy and
// sell at the same mid price) to buying at the ask, selling at the bid on
// both the take-profit and stop-loss exits — see the `${side}_entry_ask` /
// `${side}_bid_*` fields built in price_spike.py. feeSim, independent of
// spread, picks which venue's per-leg fee formula (see simulatedFee) to
// subtract — "none" applies no fees.
function simulateMatchProfit(stat, side, thresholdPercent, stopLossPercent, betAmount, spread, feeSim) {
  const startPrice = spread ? stat[`${side}_entry_ask`] : stat[`${side}_start_price`];
  if (startPrice == null) return null;
  const hasTakeProfit = thresholdPercent != null;
  const thresholdFactor = thresholdPercent / 100;
  if (hasTakeProfit && !isThresholdReachable(startPrice, thresholdFactor)) return null;
  const thresholdPrice = thresholdFactor * startPrice;

  const tpBreakpoints = stat[spread ? `${side}_bid_tp_breakpoints` : `${side}_tp_breakpoints`];
  const slBreakpoints = stat[spread ? `${side}_bid_sl_breakpoints` : `${side}_sl_breakpoints`];
  const tpTouch = hasTakeProfit ? firstTouch(tpBreakpoints, (price) => price >= thresholdPrice) : null;
  const stopLossPrice = stopLossPercent > 0 ? (stopLossPercent / 100) * startPrice : null;
  const slTouch = stopLossPrice !== null ? firstTouch(slBreakpoints, (price) => price <= stopLossPrice) : null;

  let exitPrice;
  if (tpTouch && (!slTouch || tpTouch.t <= slTouch.t)) exitPrice = thresholdPrice;
  else if (slTouch) exitPrice = stopLossPrice;
  else exitPrice = stat[spread ? `${side}_last_bid` : `${side}_last_price`];
  if (exitPrice == null) return null;

  const contracts = Math.floor(betAmount / startPrice);
  let profit = contracts * (exitPrice - startPrice);
  if (feeSim !== "none") profit -= simulatedFee(feeSim, contracts, startPrice) + simulatedFee(feeSim, contracts, exitPrice);
  return profit;
}

const OPTIMIZER_VOLUME_BUCKETS = 6;
const OPTIMIZER_WINPROB_BUCKETS = 6;
const OPTIMIZER_STOPLOSS_STEP = 10;
const OPTIMIZER_THRESHOLD_STEP = 5;
const OPTIMIZER_YIELD_MS = 15;

// Returns `buckets + 1` sorted, deduplicated cut points spanning `values`'
// own distribution (0th, 1/buckets, ..., 100th percentile) — used as the
// candidate min/max endpoints for both the volume and win-probability
// grids, so no bucket is ever empty-by-construction the way a linear split
// of a skewed distribution (e.g. volume) would be.
function quantileBreakpoints(values, buckets) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [0];
  const points = [];
  for (let i = 0; i <= buckets; i++) {
    const idx = Math.min(sorted.length - 1, Math.round((i / buckets) * (sorted.length - 1)));
    points.push(sorted[idx]);
  }
  return [...new Set(points)];
}

// All (min, max) pairs from a sorted breakpoint array with min < max. The
// top breakpoint is itself the observed max of the underlying values (see
// quantileBreakpoints), so pairing it in literally — rather than swapping
// in Infinity — still includes every match at or above it under a `<=`
// filter, while keeping the reported range an actual, meaningful number
// (matters for win probability, which is already bounded to 0-100%).
//
// A single breakpoint means every underlying value was identical (e.g.
// Polymarket's volume_before_start, always 0 with no per-minute volume
// ingested — see analysis/polymarket_data.py) — pair it with itself rather
// than returning no ranges at all, since [v, v] still correctly matches
// every value under that same `>= min && <= max` filter. Without this, that
// one degenerate dimension zeroes out the entire grid search regardless of
// how much real data every other dimension has.
function rangePairsFromBreakpoints(breakpoints) {
  if (breakpoints.length === 1) return [[breakpoints[0], breakpoints[0]]];
  const pairs = [];
  for (let i = 0; i < breakpoints.length; i++) {
    for (let j = i + 1; j < breakpoints.length; j++) {
      pairs.push([breakpoints[i], breakpoints[j]]);
    }
  }
  return pairs;
}

// 95%, two-sided — the conventional bar for "probably not noise". Fixed
// rather than a widget input: nobody wants to hand-tune a confidence level
// per run, and 95% is the standard default anyone reading "statistically
// significant" without qualification would assume.
const BAND_SIGNIFICANCE_Z = 1.96;

// Margin of error (in dollars, at BAND_SIGNIFICANCE_Z confidence) on a
// threshold's TOTAL profit, from the running sum and sum-of-squares of its
// per-match profits (avoids keeping every profit value around just to
// compute variance once at the end). Infinity for n<2: with one match
// there's no variance to estimate, so nothing can be significant.
function marginOfError(total, sumSq, n) {
  if (n < 2) return Infinity;
  const variance = Math.max(0, (sumSq - (total * total) / n) / (n - 1));
  // SE of the total (not the mean) — Var(sum of n iid) = n * variance.
  return BAND_SIGNIFICANCE_Z * Math.sqrt(variance * n);
}

// Sweeps take-profit thresholds (at OPTIMIZER_THRESHOLD_STEP resolution) for
// one fixed stats subset + stop-loss, returning the best point that still
// meets minSampleSize. Stops as soon as a threshold's eligible count drops
// below minSampleSize rather than scanning to OPTIMIZER_MAX_THRESHOLD —
// isThresholdReachable's eligible set only shrinks as the threshold rises,
// so every higher threshold would fail the floor too. Every point carries
// both its total dollar profit and its % return on cumulative stake (total
// / (betAmount * n)), plus a margin of error on the dollar total (see
// marginOfError), so callers can gate on statistical significance without a
// second pass over the data.
function bestDollarPoint(stats, side, stopLossPercent, betAmount, spread, feeSim, minSampleSize) {
  let best = null;
  for (let threshold = OPTIMIZER_MIN_THRESHOLD; threshold <= OPTIMIZER_MAX_THRESHOLD; threshold += OPTIMIZER_THRESHOLD_STEP) {
    let total = 0;
    let sumSq = 0;
    let n = 0;
    for (const stat of stats) {
      const profit = simulateMatchProfit(stat, side, threshold, stopLossPercent, betAmount, spread, feeSim);
      if (profit === null) continue;
      total += profit;
      sumSq += profit * profit;
      n++;
    }
    if (n < minSampleSize) break;
    const returnPct = betAmount > 0 && n > 0 ? total / (betAmount * n) : 0;
    const point = { threshold, value: total, returnPct, n, marginOfError: marginOfError(total, sumSq, n) };
    if (!best || returnPct > best.returnPct) best = point;
  }
  return best;
}

// Runs the full grid search, yielding to the event loop every
// OPTIMIZER_YIELD_MS so the tab stays responsive, and reporting progress
// via onProgress(0..1). runToken/isCurrent lets a re-run abandon a
// still-running previous search instead of racing it for the result.
async function runOptimizer(pairs, side, betAmount, minSampleSize, spread, feeSim, onProgress, isCurrent) {
  const volumeBreakpoints = quantileBreakpoints(pairs.map((p) => p.stat.volume_before_start), OPTIMIZER_VOLUME_BUCKETS);
  const winProbBreakpoints = quantileBreakpoints(pairs.map((p) => p.stat[`${side}_start_price`] * 100), OPTIMIZER_WINPROB_BUCKETS);
  const volumeRanges = rangePairsFromBreakpoints(volumeBreakpoints);
  const winProbRanges = rangePairsFromBreakpoints(winProbBreakpoints);
  // A single breakpoint (see rangePairsFromBreakpoints) means every match had
  // the exact same value — for pre-match volume that's Polymarket's uniform
  // 0 (no per-minute volume ingested), not a genuinely optimal "$0 – $0"
  // range the search discovered. Recorded so the result card can say "no
  // data" instead of presenting a fake range as a real finding.
  const hasVolumeData = volumeBreakpoints.length > 1;
  const stopLossValues = [];
  for (let s = 0; s <= 100; s += OPTIMIZER_STOPLOSS_STEP) stopLossValues.push(s);

  let best = null;
  let done = 0;
  const totalCombos = volumeRanges.length * winProbRanges.length;
  let chunkStart = performance.now();

  for (const [minVolume, maxVolume] of volumeRanges) {
    const byVolume = pairs.filter((p) => p.stat.volume_before_start >= minVolume && p.stat.volume_before_start <= maxVolume);
    if (byVolume.length < minSampleSize) {
      done += winProbRanges.length;
      continue;
    }

    for (const [minWinProb, maxWinProb] of winProbRanges) {
      const stats = byVolume
        .filter((p) => {
          const winProb = p.stat[`${side}_start_price`] * 100;
          return winProb >= minWinProb && winProb <= maxWinProb;
        })
        .map((p) => p.stat);
      done++;

      if (stats.length >= minSampleSize) {
        for (const stopLoss of stopLossValues) {
          const point = bestDollarPoint(stats, side, stopLoss, betAmount, spread, feeSim, minSampleSize);
          if (point && (!best || point.returnPct > best.returnPct)) {
            best = { minVolume, maxVolume, minWinProb, maxWinProb, stopLoss, threshold: point.threshold, value: point.value, returnPct: point.returnPct, n: point.n, hasVolumeData };
          }
        }
      }

      if (performance.now() - chunkStart > OPTIMIZER_YIELD_MS) {
        onProgress(done / totalCombos);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return null;
        chunkStart = performance.now();
      }
    }
  }
  onProgress(1);
  return best;
}

// Plain dollar-amount input for the per-match bet size.
function buildBetAmountControl(onChange) {
  const container = document.createElement("div");
  container.className = "percent-control bet-amount-control";
  container.innerHTML = `
    <label for="bet-amount-input">Bet per match ($)</label>
    <input id="bet-amount-input" type="number" min="1" step="1" value="100" />
  `;
  const input = container.querySelector("input");
  input.addEventListener("input", onChange);
  return { container, input };
}

// Sample-size-floor control: either a straight minimum match count or a
// minimum percentage of the current match pool (so the floor scales
// automatically as the sidebar filters narrow the pool, instead of needing
// to be re-typed by hand every time). Switching mode resets the input to
// that mode's own default rather than reinterpreting the typed number —
// "20 matches" and "20%" aren't the same quantity, so carrying the raw
// number across would silently change intent.
function buildSampleSizeControl(onChange) {
  const container = document.createElement("div");
  container.className = "percent-control bet-amount-control sample-size-control";
  container.innerHTML = `
    <label for="min-sample-size-input"><span class="sample-size-label-text"></span></label>
    <div class="sample-size-mode-toggle" role="group" aria-label="Sample size mode">
      <button type="button" data-mode="absolute" class="active">Matches</button>
      <button type="button" data-mode="relative">% of pool</button>
    </div>
    <input id="min-sample-size-input" type="number" min="1" step="1" value="20" />
  `;

  const input = container.querySelector("input");
  const labelText = container.querySelector(".sample-size-label-text");
  const buttons = [...container.querySelectorAll(".sample-size-mode-toggle button")];
  const local = { mode: "absolute" };

  const MODE_DEFAULTS = {
    absolute: { label: "Minimum sample size (matches)", max: "", value: 20 },
    relative: { label: "Minimum sample size (top % of match pool)", max: "100", value: 10 },
  };

  const applyMode = () => {
    const defaults = MODE_DEFAULTS[local.mode];
    labelText.textContent = defaults.label;
    input.max = defaults.max;
    input.value = defaults.value;
  };
  applyMode();

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mode === local.mode) return;
      local.mode = button.dataset.mode;
      buttons.forEach((b) => b.classList.toggle("active", b === button));
      applyMode();
      onChange();
    });
  });

  input.addEventListener("input", onChange);
  return { container, input, mode: () => local.mode };
}

// Resolves the sample-size control's raw (mode, value) into an actual match
// count to gate the grid search on — relative mode is a percentage of
// totalMatches, rounded up so a nonzero "top X%" never floors to a 0 floor.
function resolveMinSampleSize(mode, value, totalMatches) {
  if (mode === "relative") return Math.max(1, Math.ceil(totalMatches * (value / 100)));
  return Math.max(1, Math.round(value));
}

// Switches simulateMatchProfit from the naive bid/ask-midpoint fill (buy and
// sell at the same mid price) to buying at the ask and selling at the bid.
// Independent of fee simulation (see buildFeeSimControl) — spread and fees
// model two separate costs, so either can be toggled on its own.
function buildSpreadControl(onChange) {
  const container = document.createElement("div");
  container.className = "percent-control realistic-fill-control";
  container.innerHTML = `
    <label><input type="checkbox" id="spread-checkbox" /> Model realistic spread (buy ask / sell bid)</label>
  `;
  const checkbox = container.querySelector("input");
  checkbox.addEventListener("change", onChange);
  return { container, checkbox };
}

// Fee-simulation dropdown — picks which venue's per-leg fee formula (see
// simulatedFee) simulateMatchProfit subtracts, independent of the spread
// toggle above.
function buildFeeSimControl(onChange) {
  const container = document.createElement("div");
  container.className = "percent-control fee-sim-control";
  container.innerHTML = `
    <label for="fee-sim-select">Fee simulation</label>
    <select id="fee-sim-select">
      <option value="none">None</option>
      <option value="kalshi">Kalshi</option>
      <option value="polymarket">Polymarket</option>
    </select>
  `;
  const select = container.querySelector("select");
  select.addEventListener("change", onChange);
  return { container, select };
}

const OPTIMIZER_CONFIG = {
  id: "widget-optimizer",
  title: "Optimal filter combination (max % return, by pre-match volume)",
  note: "Grid search over pre-match volume, win probability, stop-loss, and take-profit thresholds for the combination with the highest % return on cumulative stake (total profit / total amount wagered) — a coarse approximation snapped to quantiles of the actual data, not a guaranteed global optimum. Uses realistic spread/fee simulation when enabled below.",
};

// This widget doesn't recompute on every filter tweak (unlike a live-chart
// widget would) — a run costs a bounded but still noticeable grid search, so
// it only runs when the button is clicked. Each run prepends a new result
// card (newest first) rather than replacing the last one, so re-running with
// different filters builds up a comparable history instead of discarding
// prior runs.
function buildOptimizerWidget() {
  const widget = document.createElement("div");
  widget.className = "widget widget-wide";
  widget.id = OPTIMIZER_CONFIG.id;
  widget.innerHTML = `
    <div class="widget-header">
      <span class="widget-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <h2>${OPTIMIZER_CONFIG.title}</h2>
    </div>
    <div class="side-toggle" role="group" aria-label="Side">
      <button type="button" data-side="underdog" class="active">Underdog</button>
      <button type="button" data-side="overdog">Overdog</button>
    </div>
    <div class="range-controls"></div>
    <div class="optimizer-actions">
      <button type="button" class="optimizer-run-button">Run optimization</button>
      <div class="optimizer-progress" hidden>
        <div class="optimizer-progress-track"><div class="optimizer-progress-fill"></div></div>
        <span class="optimizer-progress-label"></span>
      </div>
    </div>
    <div class="optimizer-status" hidden></div>
    <div class="optimizer-results"></div>
    <p class="optimizer-note">${OPTIMIZER_CONFIG.note}</p>
  `;

  const rangeControls = widget.querySelector(".range-controls");

  // Polymarket has no historical bid/ask (see analysis/polymarket_data.py),
  // so its price-spike stats set bid=ask=mid — the backtest still runs (mid-
  // price fills, using the real price path), but the realistic-spread toggle
  // below can't do anything with that source: ask-entry/bid-exit collapses
  // to the same numbers as the plain mid fill. Say so up front rather than
  // let the toggle silently appear to have no effect.
  if (getDataSource() !== "kalshi") {
    const sourceNote = document.createElement("p");
    sourceNote.className = "optimizer-note";
    sourceNote.textContent =
      "Polymarket has no historical bid/ask data, so this runs on mid-price fills only (real price path, naive execution at the last traded price) — the \"realistic spread\" option below has no effect for this source.";
    widget.querySelector(".widget-header").after(sourceNote);
  }

  const local = { side: "underdog", runToken: 0 };
  const runButton = widget.querySelector(".optimizer-run-button");
  const statusEl = widget.querySelector(".optimizer-status");
  const resultsEl = widget.querySelector(".optimizer-results");
  const progressEl = widget.querySelector(".optimizer-progress");
  const progressFill = widget.querySelector(".optimizer-progress-fill");
  const progressLabel = widget.querySelector(".optimizer-progress-label");

  // Each run gets prepended as its own frozen card (see buildOptimizerResultCard),
  // labeled with the filters that produced it, so these controls no longer need
  // to mark anything stale when tweaked between runs.
  const els = {
    betAmount: buildBetAmountControl(() => {}),
    sampleSize: buildSampleSizeControl(() => {}),
    spread: buildSpreadControl(() => {}),
    feeSim: buildFeeSimControl(() => {}),
  };
  rangeControls.append(els.betAmount.container, els.sampleSize.container, els.spread.container, els.feeSim.container);
  if (getDataSource() !== "kalshi") els.spread.checkbox.disabled = true;

  widget.querySelectorAll(".side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      local.side = button.dataset.side;
      widget.querySelectorAll(".side-toggle button").forEach((b) => b.classList.toggle("active", b === button));
    });
  });

  const currentParams = () => ({
    side: local.side,
    betAmount: Number(els.betAmount.input.value) || 0,
    sampleSizeMode: els.sampleSize.mode(),
    sampleSizeValue: Math.max(1, Number(els.sampleSize.input.value) || 1),
    spread: els.spread.checkbox.checked,
    feeSim: els.feeSim.select.value,
  });

  const runSearch = async (params) => {
    const token = ++local.runToken;
    const sidebarFilters = currentSidebarFilters();
    const pairs = eventStatPairs(sidebarFilteredEvents());
    const minSampleSize = resolveMinSampleSize(params.sampleSizeMode, params.sampleSizeValue, pairs.length);

    runButton.disabled = true;
    progressEl.hidden = false;
    progressFill.style.width = "0%";
    progressLabel.textContent = "0%";

    const best = await runOptimizer(
      pairs,
      params.side,
      params.betAmount,
      minSampleSize,
      params.spread,
      params.feeSim,
      (fraction) => {
        progressFill.style.width = `${Math.round(fraction * 100)}%`;
        progressLabel.textContent = `${Math.round(fraction * 100)}%`;
      },
      () => token === local.runToken
    );

    if (token !== local.runToken) return; // superseded by a newer run

    progressEl.hidden = true;
    runButton.disabled = false;
    resultsEl.prepend(buildOptimizerResultCard(sidebarFilters, params, best, minSampleSize, pairs.length));
  };

  runButton.addEventListener("click", () => {
    if (!state.statsLoaded) {
      statusEl.hidden = false;
      statusEl.textContent = "Loading match price data (first load can take a minute or two)…";
      return;
    }

    statusEl.hidden = true;
    runSearch(currentParams());
  });

  return widget;
}

// " (realistic spread, Kalshi fees)"-style suffix for the optimizer
// headlines, naming whichever simulation options were on for the run.
function simulationNotesSuffix(spread, feeSim) {
  const notes = [];
  if (spread) notes.push("realistic spread");
  if (feeSim !== "none") notes.push(`${FEE_SIM_LABELS[feeSim]} fees`);
  return notes.length ? ` (${notes.join(", ")})` : "";
}

// One human-readable line for the sidebar filters in effect when a run was
// kicked off, so its card stays self-describing after later runs (or later
// sidebar edits) push it down the list.
function formatSidebarFiltersSummary(filters) {
  const parts = [];
  parts.push(filters.query ? `search "${filters.query}"` : "no search filter");
  const { from, to } = filters.dateRange;
  parts.push(from || to ? `${from || "…"} – ${to || "…"}` : "all dates");
  if (filters.onlyPandascoreStart) parts.push("PandaScore start only");
  return parts.join(" · ");
}

// Same idea for this widget's own controls (side, bet size, sample floor,
// spread/fee simulation) at the time the run was kicked off.
function formatWidgetFiltersSummary(params, minSampleSize) {
  const sampleDetail =
    params.sampleSizeMode === "relative"
      ? `top ${params.sampleSizeValue}% of pool (${minSampleSize} match${minSampleSize === 1 ? "" : "es"})`
      : `${minSampleSize} match${minSampleSize === 1 ? "" : "es"}`;
  return [
    params.side,
    `$${params.betAmount}/match`,
    `min sample ${sampleDetail}`,
    params.spread ? "realistic spread" : "midpoint fill",
    params.feeSim === "none" ? "no fees" : `${FEE_SIM_LABELS[params.feeSim]} fees`,
  ].join(" · ");
}

// Renders runOptimizer's winning combination (or an explanatory empty state)
// into one result card's body.
function renderOptimizerResultBody(bodyEl, best, params, minSampleSize, totalMatches) {
  if (!best) {
    bodyEl.innerHTML = `<div class="optimizer-result-empty">No combination of filters reached a sample size of ${minSampleSize} match${minSampleSize === 1 ? "" : "es"} (of ${totalMatches} matches in the current sidebar filters).</div>`;
    return;
  }

  const suffix = simulationNotesSuffix(params.spread, params.feeSim);

  const item = (label, value) => `
    <div class="optimizer-result-item">
      <div class="result-label">${label}</div>
      <div class="result-value">${value}</div>
    </div>`;

  bodyEl.innerHTML = `
    <div class="optimizer-result-headline">
      <div class="result-label">Best % return betting $${params.betAmount}/match, ${params.side}${suffix}</div>
      <div class="result-value ${best.returnPct >= 0 ? "positive" : "negative"}">${best.returnPct >= 0 ? "+" : ""}${(best.returnPct * 100).toFixed(1)}%</div>
      <div class="result-detail">${best.value >= 0 ? "+" : ""}${formatDollars(best.value)} total profit, n=${best.n} of ${totalMatches} matches in the current sidebar filters</div>
    </div>
    <div class="optimizer-result-grid">
      ${item("Pre-match volume", best.hasVolumeData ? `${formatVolume(best.minVolume)} – ${formatVolume(best.maxVolume)}` : "N/A — no per-minute volume data for this source")}
      ${item("Win probability at start", `${best.minWinProb.toFixed(0)}% – ${best.maxWinProb.toFixed(0)}%`)}
      ${item("Stop-loss", best.stopLoss === 0 ? "Off" : `≤ ${best.stopLoss}% of start price`)}
      ${item("Take-profit (max price)", `+${best.threshold - OPTIMIZER_MIN_THRESHOLD}%`)}
    </div>
  `;
}

// Builds one prepended result card, frozen at run time with the sidebar and
// widget filters that produced it plus a delete button — each run gets its
// own card instead of overwriting a single shared result element, so old
// runs stay visible (and labeled) alongside new ones.
function buildOptimizerResultCard(sidebarFilters, params, best, minSampleSize, totalMatches) {
  const card = document.createElement("div");
  card.className = "optimizer-result-card";
  card.innerHTML = `
    <button type="button" class="optimizer-result-delete" title="Remove this result" aria-label="Remove this result">×</button>
    <div class="optimizer-result-filters">
      <div><span class="result-label">Sidebar filters</span> ${formatSidebarFiltersSummary(sidebarFilters)}</div>
      <div><span class="result-label">Widget filters</span> ${formatWidgetFiltersSummary(params, minSampleSize)}</div>
    </div>
    <div class="optimizer-result-body"></div>
  `;
  card.querySelector(".optimizer-result-delete").addEventListener("click", () => card.remove());
  renderOptimizerResultBody(card.querySelector(".optimizer-result-body"), best, params, minSampleSize, totalMatches);
  return card;
}

registerWidget(buildOptimizerWidget);
})();
