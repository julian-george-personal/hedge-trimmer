(function () {
const VOLUME_SLIDER_STEPS = 1000;
const VOLUME_SLIDER_MIDPOINT = 100_000;

const DEFAULT_THRESHOLD_PERCENT = 300;

const EV_CURVE_MIN_THRESHOLD = 100;
const EV_CURVE_MAX_THRESHOLD = 1000;
const EV_CURVE_STEP = 1;

// Matches explorer.js's favorite/underdog convention (OVERDOG_COLOR/UNDERDOG_COLOR)
// so a side reads the same color on both pages.
const SIDE_COLORS = { underdog: "#e0a63f", overdog: "#4f8cff" };

const CHART_VIEW_WIDTH = 640;
const CHART_VIEW_HEIGHT = 260;
const CHART_PADDING = { top: 16, right: 16, bottom: 32, left: 56 };

const state = {
  events: [],
  statsByTicker: new Map(),
  statsLoaded: false,
  maxVolume: 0,
  maxVolumeBeforeStart: 0,
  side: "underdog",
  thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
};

const WIDGET_ORDER_COOKIE = "widget-order";

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; samesite=lax`;
}

function saveWidgetOrder(container) {
  const order = [...container.querySelectorAll(".widget")].map((widget) => widget.id);
  setCookie(WIDGET_ORDER_COOKIE, JSON.stringify(order), 365);
}

function loadWidgetOrder() {
  const raw = getCookie(WIDGET_ORDER_COOKIE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Reorders the already-appended widgets to match a saved order; ids that no
// longer exist (or new widgets not yet in the saved order) are left where
// appendChild put them.
function applyWidgetOrder(container, order) {
  if (!order) return;
  for (const id of order) {
    const widget = document.getElementById(id);
    if (widget && widget.parentElement === container) container.appendChild(widget);
  }
}

// Finds the widget whose vertical center the cursor is currently above, so
// the dragged widget can be inserted just before it (or at the end, if the
// cursor is below every widget).
function getDragAfterElement(container, cursorY) {
  const others = [...container.querySelectorAll(".widget:not(.dragging)")];
  return others.reduce(
    (closest, widget) => {
      const box = widget.getBoundingClientRect();
      const offset = cursorY - box.top - box.height / 2;
      return offset < 0 && offset > closest.offset ? { offset, element: widget } : closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

// Wires up drag handles so widgets can be reordered by mouse, and persists
// the resulting order to a cookie once a drag completes.
function setupWidgetDragAndDrop(container) {
  container.querySelectorAll(".widget-drag-handle").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      const widget = handle.closest(".widget");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", widget.id);
      event.dataTransfer.setDragImage(widget, 20, 20);
      setTimeout(() => widget.classList.add("dragging"), 0);
    });
    handle.addEventListener("dragend", () => {
      handle.closest(".widget").classList.remove("dragging");
      saveWidgetOrder(container);
    });
  });

  container.addEventListener("dragover", (event) => {
    event.preventDefault();
    const dragging = container.querySelector(".widget.dragging");
    if (!dragging) return;
    const afterElement = getDragAfterElement(container, event.clientY);
    if (afterElement == null) container.appendChild(dragging);
    else container.insertBefore(dragging, afterElement);
  });

  container.addEventListener("drop", (event) => event.preventDefault());
}

function formatVolume(volume) {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return String(Math.round(volume));
}

// Same two-segment exponential mapping as the explorer's volume slider, so
// the two pages feel consistent — see explorer.js for the rationale.
function sliderPositionToVolume(position, maxVolume) {
  if (position <= 0 || maxVolume <= 0) return 0;
  if (position >= VOLUME_SLIDER_STEPS) return maxVolume;

  const half = VOLUME_SLIDER_STEPS / 2;
  const midVolume = Math.min(VOLUME_SLIDER_MIDPOINT, maxVolume);

  if (position <= half) {
    const floor = 1;
    return floor * Math.pow(midVolume / floor, position / half);
  }
  return midVolume * Math.pow(maxVolume / midVolume, (position - half) / half);
}

function currentMinVolume() {
  const position = Number(document.getElementById("min-volume").value);
  return sliderPositionToVolume(position, state.maxVolume);
}

// Win-probability sliders use the same 0-1000 step range as the volume
// sliders but map linearly onto 0-100%, since price is already bounded.
function sliderPositionToPercent(position) {
  return (position / VOLUME_SLIDER_STEPS) * 100;
}

function updateMinVolumeLabel() {
  document.getElementById("min-volume-label").textContent = formatVolume(currentMinVolume());
}

function toDateInputValue(date) {
  return date.toLocaleDateString("en-CA"); // yyyy-mm-dd, respects local timezone
}

function currentDateRange() {
  const from = document.getElementById("analysis-date-from").value;
  const to = document.getElementById("analysis-date-to").value;
  return { from, to };
}

function eventInDateRange(event, { from, to }) {
  const closeTime = new Date(event.close_time).getTime();
  if (from && closeTime < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && closeTime > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function eventMatchesQuery(event, query) {
  const haystack = `${event.title} ${event.event_ticker}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function applyDatePreset(preset) {
  const today = new Date();
  const fromInput = document.getElementById("analysis-date-from");
  const toInput = document.getElementById("analysis-date-to");

  if (preset === "all") {
    fromInput.value = "";
    toInput.value = "";
  } else if (preset === "today") {
    fromInput.value = toDateInputValue(today);
    toInput.value = toDateInputValue(today);
  } else if (preset === "week") {
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    fromInput.value = toDateInputValue(start);
    toInput.value = toDateInputValue(end);
  } else if (preset === "month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    fromInput.value = toDateInputValue(start);
    toInput.value = toDateInputValue(end);
  }

  renderAll();
}

// True only once stats have loaded and this match's price-spike stat was
// computed from a real PandaScore begin_at, not the 2h-before-close fallback
// (see has_pandascore_start in price_spike.py).
function eventHasPandascoreStart(event) {
  return state.statsByTicker.get(event.event_ticker)?.has_pandascore_start === true;
}

function sidebarFilteredEvents() {
  const query = document.getElementById("analysis-search").value.trim();
  const dateRange = currentDateRange();
  const onlyPandascoreStart = document.getElementById("only-pandascore-start").checked;

  return state.events.filter(
    (event) =>
      (!query || eventMatchesQuery(event, query)) &&
      eventInDateRange(event, dateRange) &&
      (!onlyPandascoreStart || eventHasPandascoreStart(event))
  );
}

// Sidebar filters (search, date) plus the widget's own min-volume threshold.
function widgetFilteredEvents() {
  const minVolume = currentMinVolume();
  return sidebarFilteredEvents().filter((event) => event.volume >= minVolume);
}

function updateFilterSummary(matched) {
  document.getElementById("filter-summary").textContent = `${matched} of ${state.events.length} matches match filters`;
}

// A match's price-spike stat only exists when it has candles, exactly two
// markets, and a resolvable start price for both sides — see price_spike.py.
function statsForEvents(events) {
  return events.map((event) => state.statsByTicker.get(event.event_ticker)).filter(Boolean);
}

// Pairs each event with its price-spike stat (dropped when there is none),
// so an EV-curve widget can filter by either an event-level field (e.g.
// total volume) or a stat-level field (e.g. volume before match start)
// without losing the correspondence between the two.
function eventStatPairs(events) {
  return events
    .map((event) => ({ event, stat: state.statsByTicker.get(event.event_ticker) }))
    .filter((pair) => pair.stat);
}

// Price is a bid/ask midpoint capped at $1 (a contract settles at $0 or
// $1), so a threshold implying a target above $1 can never be hit no matter
// the match outcome. Counting those matches as "total loss" bets would
// score a bet no rational trader would place; exclude them from the
// eligible set instead of folding them into the miss column.
const PRICE_CEILING = 1;

function isThresholdReachable(startPrice, factor) {
  return factor * startPrice <= PRICE_CEILING;
}

// stopLossPercent, when > 0, marks a match as "stopped out" (rather than a
// full loss) if its price ever fell to or below that fraction of the start
// price without first reaching the take-profit threshold — see
// expectedValuePerBet.
function spikeResult(stats, side, thresholdPercent, stopLossPercent = 0) {
  const factor = thresholdPercent / 100;
  const stopLossFactor = stopLossPercent / 100;
  const startKey = `${side}_start_price`;
  const eligible = stats.filter((stat) => isThresholdReachable(stat[startKey], factor));
  if (eligible.length === 0) return { count: 0, total: 0, stopped: 0 };

  let count = 0;
  let stopped = 0;
  for (const stat of eligible) {
    if (stat[`${side}_max_price`] >= factor * stat[startKey]) {
      count++;
    } else if (stopLossFactor > 0 && stat[`${side}_min_price`] <= stopLossFactor * stat[startKey]) {
      stopped++;
    }
  }
  return { count, total: eligible.length, stopped };
}

// Samples the EV formula across the whole threshold range so the curve
// widget can plot expected profit as a function of the exit threshold. The
// true curve is a step function (hit rate only changes at each match's own
// max/start ratio) that's linear between steps; sampling every integer
// percentage point renders that closely enough at chart resolution. The
// eligible set shrinks as the threshold rises (see isThresholdReachable),
// so it can reach zero before EV_CURVE_MAX_THRESHOLD — stop there rather
// than discarding the points already computed.
function computeEvCurve(stats, side, stopLossPercent = 0) {
  const points = [];
  for (let threshold = EV_CURVE_MIN_THRESHOLD; threshold <= EV_CURVE_MAX_THRESHOLD; threshold += EV_CURVE_STEP) {
    const { count, total, stopped } = spikeResult(stats, side, threshold, stopLossPercent);
    if (total === 0) break;
    const ev = expectedValuePerBet(count / total, threshold, stopped / total, stopLossPercent);
    points.push({ increase: threshold - EV_CURVE_MIN_THRESHOLD, value: ev });
  }
  return points;
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
// *first in time* — unlike spikeResult, which only has each match's overall
// max/min and so can't tell a late spike above threshold apart from an early
// stop-loss that would have closed the position first. Falls back to the
// last observed price (a reasonable settlement proxy — see the dollar-profit
// widget's plan notes) if neither level was ever touched in the data.
// Returns dollar profit for `betAmount` worth of whole contracts bought at
// the start price, or null if the threshold is unreachable (mirrors
// isThresholdReachable) or, in realistic mode, if the match has no ask-side
// data to enter with.
//
// spread, when true, switches from the naive bid/ask-midpoint fill (buy and
// sell at the same mid price) to buying at the ask, selling at the bid on
// both the take-profit and stop-loss exits — see the `${side}_entry_ask` /
// `${side}_bid_*` fields built in price_spike.py. feeSim, independent of
// spread, picks which venue's per-leg fee formula (see simulatedFee) to
// subtract — "none" applies no fees.
//
// thresholdPercent may be null, meaning no take-profit at all: the position
// only exits via the stop-loss or settlement, and no match is excluded for
// unreachability (there is no target to reach).
function simulateMatchProfit(stat, side, thresholdPercent, stopLossPercent, betAmount, spread = false, feeSim = "none") {
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

// Sums simulateMatchProfit's realized dollar outcome across every eligible
// match at each threshold — total money made if betAmount had been bet on
// every filtered match, not an average, so the curve reflects both changing
// win rate and the shrinking eligible set as the threshold rises. Takes the
// widget's control values as one options object (see updateEvCurveWidget)
// so each computePoints implementation can pick the knobs it sweeps vs.
// holds fixed.
function computeDollarCurve(stats, side, { stopLossPercent, betAmount, spread, feeSim }) {
  const points = [];
  for (let threshold = EV_CURVE_MIN_THRESHOLD; threshold <= EV_CURVE_MAX_THRESHOLD; threshold += EV_CURVE_STEP) {
    let total = 0;
    let n = 0;
    for (const stat of stats) {
      const profit = simulateMatchProfit(stat, side, threshold, stopLossPercent, betAmount, spread, feeSim);
      if (profit === null) continue;
      total += profit;
      n++;
    }
    if (n === 0) break;
    points.push({ increase: threshold - EV_CURVE_MIN_THRESHOLD, value: total, n });
  }
  return points;
}

// The stop-loss counterpart of computeDollarCurve: sweeps the stop-loss
// level from "off" (0) to a hair-trigger 100% of entry, with an optional
// fixed take-profit, summing each level's realized dollar outcome. No
// early-out on n — unlike a rising take-profit, a deeper stop-loss never
// shrinks the eligible set, and with no take-profit set nothing is excluded
// for unreachability at all (so n runs larger than in the take-profit
// widgets).
function computeStopLossDollarCurve(stats, side, { takeProfitPercent, betAmount, spread, feeSim }) {
  const points = [];
  for (let stopLoss = 0; stopLoss <= 100; stopLoss += 1) {
    let total = 0;
    let n = 0;
    for (const stat of stats) {
      const profit = simulateMatchProfit(stat, side, takeProfitPercent, stopLoss, betAmount, spread, feeSim);
      if (profit === null) continue;
      total += profit;
      n++;
    }
    if (n === 0) break;
    points.push({ increase: stopLoss, value: total, n });
  }
  return points;
}

function formatDollars(amount) {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(amount)).toLocaleString()}`;
}

function formatDollarsTooltipValue(point, local) {
  const prefix = point.value >= 0 ? "+" : "";
  const notes = [];
  if (local.spread) notes.push("realistic spread");
  if (local.feeSim && local.feeSim !== "none") notes.push(`${FEE_SIM_LABELS[local.feeSim]} fees`);
  const suffix = notes.length ? `, ${notes.join(", ")}` : "";
  return `${prefix}${formatDollars(point.value)} total profit betting $${local.betAmount}/match (n=${point.n} match${point.n === 1 ? "" : "es"}${suffix})`;
}

// --- Optimal filter combination widget --------------------------------
//
// Grid-searches pre-match volume range x win-probability range x stop-loss
// x take-profit threshold for whichever combination maximizes total dollar
// profit (via simulateMatchProfit/computeDollarCurve's same realistic-fill
// machinery), subject to a minimum sample size. A true joint optimum over
// five real-valued knobs isn't tractable client-side against ~2k matches,
// so this is a bounded grid: range endpoints are snapped to quantiles of
// the actual data (so every bucket has matches in it, unlike an evenly
// spaced grid) rather than searched continuously.
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
function rangePairsFromBreakpoints(breakpoints) {
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
// compute variance once at the end). A band's profit only counts as real
// once it exceeds this — i.e. the confidence interval [value - margin,
// value + margin] excludes zero — rather than any positive total, however
// thin relative to its own noise (a $30 total over 104 matches is 29
// cents/match, well within the swing you'd expect from chance alone).
// Infinity for n<2: with one match there's no variance to estimate, so
// nothing can be significant.
function marginOfError(total, sumSq, n) {
  if (n < 2) return Infinity;
  const variance = Math.max(0, (sumSq - (total * total) / n) / (n - 1));
  // SE of the total (not the mean) — Var(sum of n iid) = n * variance.
  return BAND_SIGNIFICANCE_Z * Math.sqrt(variance * n);
}

// Sweeps take-profit thresholds (at OPTIMIZER_THRESHOLD_STEP resolution,
// coarser than the EV-curve widgets' 1% since this runs inside a much
// larger outer grid) for one fixed stats subset + stop-loss, returning the
// most profitable point that still meets minSampleSize. Stops as soon as a
// threshold's eligible count drops below minSampleSize rather than
// scanning to EV_CURVE_MAX_THRESHOLD — isThresholdReachable's eligible set
// only shrinks as the threshold rises (see spikeResult), so every higher
// threshold would fail the floor too. Every point carries its margin of
// error (see marginOfError) so callers can gate on statistical
// significance, not just sign, without a second pass over the data.
function bestDollarPoint(stats, side, stopLossPercent, betAmount, spread, feeSim, minSampleSize) {
  let best = null;
  for (let threshold = EV_CURVE_MIN_THRESHOLD; threshold <= EV_CURVE_MAX_THRESHOLD; threshold += OPTIMIZER_THRESHOLD_STEP) {
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
    if (!best || total > best.value) best = { threshold, value: total, n, marginOfError: marginOfError(total, sumSq, n) };
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
          if (point && (!best || point.value > best.value)) {
            best = { minVolume, maxVolume, minWinProb, maxWinProb, stopLoss, threshold: point.threshold, value: point.value, n: point.n };
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

// --- Band optimizer (per-win-probability exit policy) -----------------
//
// The plain optimizer above finds one global take-profit threshold, but the
// optimal exit depends on where the side started: a contract can't trade
// above $1, so a side entered at 45% has at most ~+120% of headroom while a
// 20% side has ~+400%. Sweeping one static threshold across all matches
// silently turns high thresholds into "hold to expiry" for every
// high-probability side. This variant partitions matches into
// win-probability bands and finds each band's own optimal exit instead.
// Default/fallback band width — overridden per run by the widget's band-
// width control (see buildBandWidthControl), this only applies if
// runBandOptimizer is ever called without one.
const BAND_OPTIMIZER_BAND_WIDTH = 2.5;

// Contiguous fixed-width win-probability bands partitioning `pairs` for
// the band optimizer — bandWidth points each, aligned to multiples of the
// width and spanning the observed range. Fixed widths keep bands
// comparable across sides and filters (quantile edges would move with the
// data); sparse edge bands just fall under the per-band sample floor and
// render as skipped. Bands are [lo, hi), except the last, which includes
// its upper edge so the max-probability match still lands in a band.
function winProbBands(pairs, side, bandWidth) {
  const winProbs = pairs.map((p) => p.stat[`${side}_start_price`] * 100);
  if (winProbs.length === 0) return [];
  const first = Math.floor(Math.min(...winProbs) / bandWidth) * bandWidth;
  const max = Math.max(...winProbs);
  const bands = [];
  for (let lo = first; lo < max; lo += bandWidth) {
    bands.push({ lo, hi: lo + bandWidth, last: lo + bandWidth >= max });
  }
  return bands;
}

function bandContains(band, winProb) {
  return winProb >= band.lo && (winProb < band.hi || (band.last && winProb <= band.hi));
}

// Best (stop-loss, take-profit) exit for one band's matches — the inner
// search runBandOptimizer repeats for every band x volume range. Returns
// { stopLoss, threshold, value, n } or null if no combination meets the
// sample floor.
function bestBandExit(stats, side, betAmount, minSampleSize, spread, feeSim) {
  let best = null;
  for (let stopLoss = 0; stopLoss <= 100; stopLoss += OPTIMIZER_STOPLOSS_STEP) {
    const point = bestDollarPoint(stats, side, stopLoss, betAmount, spread, feeSim, minSampleSize);
    if (point && (!best || point.value > best.value)) best = { stopLoss, ...point };
  }
  return best;
}

// Like runOptimizer, but instead of one global win-probability range and
// take-profit threshold, it fixes bandWidth-wide win-probability bands and
// finds each band's own optimal (stop-loss, take-profit) — the resulting
// policy reads "if the side's start probability falls in band B, use B's
// exits; if B's best exit doesn't clear its own margin of error (see
// marginOfError) at BAND_SIGNIFICANCE_Z confidence, don't bet that band at
// all" — this is a single per-band test with no correction for the many
// threshold/stop-loss/volume-range combinations the grid search tries, so
// treat it as a noise filter, not a rigorous guarantee. minSampleSize is a
// per-band floor, not a floor on the total match count — each band
// independently needs at least that many matches to be searched at all
// (see the widget's "per band" label). The pre-match volume range stays a
// single shared knob searched as before. A volume range's total is the
// sum over its profitable bands, and the winning result keeps every band
// (no-bet and under-sampled ones included) so the display can show the
// complete policy.
async function runBandOptimizer(pairs, side, betAmount, minSampleSize, spread, feeSim, onProgress, isCurrent, bandWidth = BAND_OPTIMIZER_BAND_WIDTH) {
  const bands = winProbBands(pairs, side, bandWidth);
  if (bands.length === 0) return null;
  const volumeBreakpoints = quantileBreakpoints(pairs.map((p) => p.stat.volume_before_start), OPTIMIZER_VOLUME_BUCKETS);
  const volumeRanges = rangePairsFromBreakpoints(volumeBreakpoints);

  let best = null;
  let done = 0;
  const totalCombos = volumeRanges.length * bands.length;
  let chunkStart = performance.now();

  for (const [minVolume, maxVolume] of volumeRanges) {
    const byVolume = pairs.filter((p) => p.stat.volume_before_start >= minVolume && p.stat.volume_before_start <= maxVolume);
    const bandResults = [];
    let total = 0;
    let n = 0;

    for (const band of bands) {
      const stats = byVolume
        .filter((p) => bandContains(band, p.stat[`${side}_start_price`] * 100))
        .map((p) => p.stat);
      const exit = stats.length >= minSampleSize ? bestBandExit(stats, side, betAmount, minSampleSize, spread, feeSim) : null;
      // value > marginOfError already implies value > 0 (marginOfError is
      // never negative), so this alone covers both "unprofitable" and "too
      // noisy to trust" rejections.
      const bet = exit !== null && exit.value > exit.marginOfError;
      bandResults.push({ lo: band.lo, hi: band.hi, matches: stats.length, exit, bet });
      if (bet) {
        total += exit.value;
        n += exit.n;
      }
      done++;

      if (performance.now() - chunkStart > OPTIMIZER_YIELD_MS) {
        onProgress(done / totalCombos);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return null;
        chunkStart = performance.now();
      }
    }

    if (bandResults.some((band) => band.bet) && (!best || total > best.value)) {
      best = { minVolume, maxVolume, bands: bandResults, value: total, n };
    }
  }
  onProgress(1);
  return best;
}

function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = (value) => r0 + ((value - d0) / span) * (r1 - r0);
  scale.invert = (value) => d0 + ((value - r0) / (r1 - r0 || 1)) * span;
  return scale;
}

// linearScale in log10 space — the exit-policy chart's y axis spans
// stop-losses near 10% of entry and take-profits near 1000%, which a linear
// axis would squash into an unreadable sliver at the bottom.
function logScale(domain, range) {
  const inner = linearScale(domain.map(Math.log10), range);
  const scale = (value) => inner(Math.log10(value));
  scale.invert = (value) => Math.pow(10, inner.invert(value));
  return scale;
}

function niceStep(rawStep) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  if (residual >= 5) return 10 * magnitude;
  if (residual >= 2) return 5 * magnitude;
  if (residual >= 1) return 2 * magnitude;
  return magnitude;
}

function niceTicks(min, max, targetCount) {
  const step = niceStep((max - min) / targetCount || 1);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 2; t += step) {
    ticks.push(Math.round(t / step) * step);
  }
  if (min <= 0 && max >= 0 && !ticks.includes(0)) ticks.push(0);
  return [...new Set(ticks)].sort((a, b) => a - b);
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function chartPlotArea() {
  return {
    left: CHART_PADDING.left,
    right: CHART_VIEW_WIDTH - CHART_PADDING.right,
    top: CHART_PADDING.top,
    bottom: CHART_VIEW_HEIGHT - CHART_PADDING.bottom,
  };
}

// Default percent formatting for the EV-curve widgets' y axis.
function formatEvPercentTick(tick) {
  return `${tick > 0 ? "+" : ""}${Math.round(tick * 100)}%`;
}

// Default x axis for the EV-curve widgets: the take-profit sweep. The
// stop-loss-sweep widget swaps in its own via config.xAxis.
const EV_CURVE_X_AXIS = {
  max: EV_CURVE_MAX_THRESHOLD - EV_CURVE_MIN_THRESHOLD,
  tickStep: 100,
  formatTick: (tick) => `+${tick}%`,
};

// Clears and redraws the svg (gridlines, axis labels, data line); returns
// the scales so the hover layer can map pointer position back to a data
// point. points are { increase, value } — value's unit (percent-of-stake or
// dollars) is opaque here; formatYTick renders it for the y axis, and xAxis
// names the swept variable's domain and tick format.
function renderEvChart(svg, points, color, formatYTick = formatEvPercentTick, xAxis = EV_CURVE_X_AXIS) {
  svg.innerHTML = "";
  const plot = chartPlotArea();
  const xDomain = [0, xAxis.max];
  const values = points.map((p) => p.value);
  const yDataMin = Math.min(...values, 0);
  const yDataMax = Math.max(...values, 0);
  const yPad = (yDataMax - yDataMin) * 0.08 || 0.05;
  const yDomain = [yDataMin - yPad, yDataMax + yPad];

  const xScale = linearScale(xDomain, [plot.left, plot.right]);
  const yScale = linearScale(yDomain, [plot.bottom, plot.top]);

  const grid = svgEl("g", { class: "chart-grid" });
  niceTicks(yDomain[0], yDomain[1], 5).forEach((tick) => {
    const y = yScale(tick);
    grid.appendChild(
      svgEl("line", { x1: plot.left, x2: plot.right, y1: y, y2: y, class: tick === 0 ? "chart-zero-line" : "chart-gridline" })
    );
    const label = svgEl("text", { x: plot.left - 8, y, class: "chart-axis-label", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = formatYTick(tick);
    grid.appendChild(label);
  });
  for (let tick = xDomain[0]; tick <= xDomain[1]; tick += xAxis.tickStep) {
    const label = svgEl("text", { x: xScale(tick), y: plot.bottom + 20, class: "chart-axis-label", "text-anchor": "middle" });
    label.textContent = xAxis.formatTick(tick);
    grid.appendChild(label);
  }
  svg.appendChild(grid);

  const linePoints = points.map((p) => `${xScale(p.increase)},${yScale(p.value)}`).join(" ");
  svg.appendChild(svgEl("polyline", { points: linePoints, class: "chart-line", style: `stroke:${color}` }));

  return { xScale, yScale, plot };
}

function formatEvPercentTooltip(point) {
  return `${point.value >= 0 ? "+" : ""}${(point.value * 100).toFixed(1)}% expected profit`;
}

// Transparent overlay over the plot area that tracks the pointer, snaps to
// the nearest sampled point (points are one per integer % so the index IS
// the increase value), and drives a crosshair + tooltip — see
// references/interaction.md's "crosshair finds the X" pattern.
// formatTooltipTitle names the swept variable for the tooltip's first line.
function attachEvChartHover(widget, svg, points, scales, color, tooltip, formatTooltipValue = formatEvPercentTooltip, formatTooltipTitle = (point) => `+${point.increase}% max price`) {
  const { xScale, yScale, plot } = scales;
  const crosshair = svgEl("line", { x1: 0, x2: 0, y1: plot.top, y2: plot.bottom, class: "chart-crosshair" });
  const dot = svgEl("circle", { r: 4, class: "chart-hover-dot", fill: color });
  const overlay = svgEl("rect", {
    x: plot.left,
    y: plot.top,
    width: plot.right - plot.left,
    height: plot.bottom - plot.top,
    class: "chart-overlay",
  });
  svg.appendChild(crosshair);
  svg.appendChild(dot);
  svg.appendChild(overlay);

  const hide = () => {
    crosshair.classList.remove("visible");
    dot.classList.remove("visible");
    tooltip.hidden = true;
  };

  overlay.addEventListener("pointermove", (event) => {
    const svgRect = svg.getBoundingClientRect();
    const mouseXInView = ((event.clientX - svgRect.left) / svgRect.width) * CHART_VIEW_WIDTH;
    const increase = Math.round(Math.max(0, Math.min(points.length - 1, xScale.invert(mouseXInView))));
    const point = points[increase];
    if (!point) return;

    const x = xScale(point.increase);
    const y = yScale(point.value);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.classList.add("visible");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.classList.add("visible");

    tooltip.hidden = false;
    tooltip.innerHTML = "";
    const line1 = document.createElement("div");
    line1.textContent = formatTooltipTitle(point);
    const line2 = document.createElement("div");
    line2.className = "chart-tooltip-value";
    line2.textContent = formatTooltipValue(point);
    tooltip.append(line1, line2);

    const wrapRect = widget.querySelector(".chart-wrap").getBoundingClientRect();
    tooltip.style.left = `${svgRect.left - wrapRect.left + (x / CHART_VIEW_WIDTH) * svgRect.width}px`;
    tooltip.style.top = `${svgRect.top - wrapRect.top + (y / CHART_VIEW_HEIGHT) * svgRect.height}px`;
  });
  overlay.addEventListener("pointerleave", hide);
}

const EXIT_POLICY_Y_TICKS = [10, 20, 50, 100, 200, 500, 1000, 2000];

function formatWinProbEdge(value) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatWinProbBand(lo, hi) {
  return `${formatWinProbEdge(lo)}–${formatWinProbEdge(hi)}%`;
}

// x positions for one band's marks, inset 1px per side so adjacent bands
// keep a visible gap instead of fusing into one block.
function bandXBounds(band, xScale) {
  return { x1: xScale(band.lo) + 1, x2: xScale(band.hi) - 1 };
}

// Below this pixel width, a band gets no in-chart text: 2.5%-wide bands
// pack too tightly for "+635%"-style labels, so hover and the table carry
// the exact numbers instead.
const BAND_LABEL_MIN_WIDTH = 40;

// Draws one profitable band's exit policy: a solid take-profit line, a
// dashed stop-loss line (when one is set), and a shaded "hold corridor"
// between them — from the take-profit down to the stop-loss, or to the
// bottom of the plot when there's no stop-loss (an unstopped position rides
// all the way down).
function drawBandCorridor(svg, band, xScale, yScale, plotBottom, color) {
  const { x1, x2 } = bandXBounds(band, xScale);
  const mid = (x1 + x2) / 2;
  const showLabels = x2 - x1 >= BAND_LABEL_MIN_WIDTH;
  const yTp = yScale(band.exit.threshold);
  const hasStop = band.exit.stopLoss > 0;
  const yBottom = hasStop ? yScale(band.exit.stopLoss) : plotBottom;

  svg.appendChild(svgEl("rect", { x: x1, y: yTp, width: x2 - x1, height: yBottom - yTp, fill: color, opacity: 0.12 }));
  svg.appendChild(svgEl("line", { x1, x2, y1: yTp, y2: yTp, stroke: color, "stroke-width": 2.5 }));
  if (showLabels) {
    const tpLabel = svgEl("text", { x: mid, y: yTp - 6, class: "chart-band-label", "text-anchor": "middle" });
    tpLabel.textContent = `+${band.exit.threshold - EV_CURVE_MIN_THRESHOLD}%`;
    svg.appendChild(tpLabel);
  }

  if (hasStop) {
    svg.appendChild(svgEl("line", { x1, x2, y1: yBottom, y2: yBottom, stroke: color, "stroke-width": 2, "stroke-dasharray": "5 4" }));
    if (showLabels) {
      const slLabel = svgEl("text", { x: mid, y: yBottom + 13, class: "chart-band-sublabel", "text-anchor": "middle" });
      slLabel.textContent = `≤${band.exit.stopLoss}%`;
      svg.appendChild(slLabel);
    }
  }
}

// Draws a skipped band (unprofitable at its best, or under the sample
// floor) as a muted full-height tint with a one-word explanation at the
// entry line (dropped when the band is too narrow to fit it).
function drawBandSkip(svg, band, xScale, yEntry, plot) {
  const { x1, x2 } = bandXBounds(band, xScale);
  svg.appendChild(svgEl("rect", { x: x1, y: plot.top, width: x2 - x1, height: plot.bottom - plot.top, class: "chart-band-skip" }));
  if (x2 - x1 < BAND_LABEL_MIN_WIDTH) return;
  const label = svgEl("text", { x: (x1 + x2) / 2, y: yEntry - 6, class: "chart-band-sublabel", "text-anchor": "middle" });
  label.textContent = band.exit ? "no bet" : `n=${band.matches}`;
  svg.appendChild(label);
}

// The hard ceiling on any sell price: a contract can't trade above $1, so a
// side entered at p% can never sell above (100/p)x its entry — which is why
// the optimal take-profit has to fall as win probability rises. Drawn as a
// dashed reference curve, clipped to the plot's y range, with a legend-style
// key in the top-right corner (the curve only nears the top at the left
// edge, so that corner is reliably empty).
function drawPriceCeilingCurve(svg, xDomain, xScale, yScale, yMax, plot) {
  const samples = [];
  for (let p = xDomain[0]; p <= xDomain[1]; p += 0.5) {
    const ceiling = 10000 / p;
    if (ceiling <= yMax) samples.push(`${xScale(p)},${yScale(ceiling)}`);
  }
  if (samples.length < 2) return;
  svg.appendChild(svgEl("polyline", { points: samples.join(" "), class: "chart-ceiling-line" }));

  const keyY = plot.top + 8;
  const label = svgEl("text", { x: plot.right - 4, y: keyY, class: "chart-band-sublabel", "text-anchor": "end", "dominant-baseline": "middle" });
  label.textContent = "price ceiling ($1)";
  svg.appendChild(label);
  const labelStart = plot.right - 4 - label.getComputedTextLength();
  svg.appendChild(svgEl("line", { x1: labelStart - 26, x2: labelStart - 8, y1: keyY, y2: keyY, class: "chart-ceiling-line" }));
}

// The band optimizer's result chart: win probability at match start on x,
// sell trigger as a % of entry price on log-scale y (100% = entry, marked
// with the darker gridline). Each profitable band gets a hold corridor
// (see drawBandCorridor); skipped bands get a muted tint; the dashed curve
// is the $1 price ceiling explaining the downward-stepping take-profits.
function renderExitPolicyChart(svg, bands, side) {
  svg.innerHTML = "";
  const plot = chartPlotArea();
  const color = SIDE_COLORS[side];

  const xDomain = [bands[0].lo, bands[bands.length - 1].hi];
  const tpLevels = bands.filter((band) => band.bet).map((band) => band.exit.threshold);
  const slLevels = bands.filter((band) => band.bet && band.exit.stopLoss > 0).map((band) => band.exit.stopLoss);
  const yMax = Math.max(...tpLevels, 150) * 1.6;
  const yMin = Math.min(60, ...slLevels.map((level) => level * 0.6));
  const xScale = linearScale(xDomain, [plot.left, plot.right]);
  const yScale = logScale([yMin, yMax], [plot.bottom, plot.top]);

  const grid = svgEl("g", { class: "chart-grid" });
  for (const tick of EXIT_POLICY_Y_TICKS) {
    if (tick < yMin || tick > yMax) continue;
    const y = yScale(tick);
    grid.appendChild(svgEl("line", { x1: plot.left, x2: plot.right, y1: y, y2: y, class: tick === 100 ? "chart-zero-line" : "chart-gridline" }));
    const label = svgEl("text", { x: plot.left - 8, y, class: "chart-axis-label", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = `${tick}%`;
    grid.appendChild(label);
  }
  let lastTickX = -Infinity;
  for (const edge of [...bands.map((band) => band.lo), bands[bands.length - 1].hi]) {
    const x = xScale(edge);
    if (x - lastTickX < 30) continue;
    lastTickX = x;
    const label = svgEl("text", { x, y: plot.bottom + 20, class: "chart-axis-label", "text-anchor": "middle" });
    label.textContent = `${formatWinProbEdge(edge)}%`;
    grid.appendChild(label);
  }
  svg.appendChild(grid);

  drawPriceCeilingCurve(svg, xDomain, xScale, yScale, yMax, plot);
  const yEntry = yScale(100);
  for (const band of bands) {
    if (band.bet) drawBandCorridor(svg, band, xScale, yScale, plot.bottom, color);
    else drawBandSkip(svg, band, xScale, yEntry, plot);
  }

  return { xScale, yScale, plot };
}

// Why a band with a found exit still isn't "bet": either its best exit
// lost money outright, or it made money too thin/noisy relative to its
// sample to clear its own 95% margin of error (see marginOfError) — e.g.
// +$30 over 104 matches, ±$210, is well within the swing you'd expect from
// chance alone.
function bandSkipReason(exit) {
  if (exit.value <= 0) return "unprofitable at best";
  return `not significant (±${formatDollars(exit.marginOfError)})`;
}

function exitPolicyTooltipValue(band) {
  if (!band.exit) return `too few matches (n=${band.matches})`;
  const stop = band.exit.stopLoss > 0 ? `SL ≤${band.exit.stopLoss}%` : "no stop-loss";
  const outcome = `${band.exit.value >= 0 ? "+" : ""}${formatDollars(band.exit.value)} (n=${band.exit.n})`;
  if (!band.bet) return `no bet, ${bandSkipReason(band.exit)} — best exit ${outcome}`;
  return `TP +${band.exit.threshold - EV_CURVE_MIN_THRESHOLD}%, ${stop} → ${outcome}`;
}

// Hover layer for the exit-policy chart: outlines the band under the
// pointer and shows its full decision in a tooltip. Bands are wide slabs
// rather than points, so this highlights the whole band instead of
// snapping a crosshair the way attachEvChartHover does.
function attachExitPolicyHover(wrap, svg, bands, scales) {
  const { xScale, plot } = scales;
  const tooltip = wrap.querySelector(".chart-tooltip");
  const outline = svgEl("rect", { y: plot.top, height: plot.bottom - plot.top, class: "chart-band-outline" });
  const overlay = svgEl("rect", { x: plot.left, y: plot.top, width: plot.right - plot.left, height: plot.bottom - plot.top, class: "chart-overlay" });
  svg.appendChild(outline);
  svg.appendChild(overlay);

  const hide = () => {
    outline.classList.remove("visible");
    tooltip.hidden = true;
  };

  overlay.addEventListener("pointermove", (event) => {
    const svgRect = svg.getBoundingClientRect();
    const mouseXInView = ((event.clientX - svgRect.left) / svgRect.width) * CHART_VIEW_WIDTH;
    const winProb = xScale.invert(mouseXInView);
    const band = bands.find((candidate) => winProb >= candidate.lo && winProb <= candidate.hi);
    if (!band) {
      hide();
      return;
    }

    const { x1, x2 } = bandXBounds(band, xScale);
    outline.setAttribute("x", x1);
    outline.setAttribute("width", x2 - x1);
    outline.classList.add("visible");

    tooltip.hidden = false;
    tooltip.innerHTML = "";
    const line1 = document.createElement("div");
    line1.textContent = `Win prob ${formatWinProbBand(band.lo, band.hi)} at start`;
    const line2 = document.createElement("div");
    line2.className = "chart-tooltip-value";
    line2.textContent = exitPolicyTooltipValue(band);
    tooltip.append(line1, line2);

    const wrapRect = wrap.getBoundingClientRect();
    const mid = (x1 + x2) / 2;
    tooltip.style.left = `${svgRect.left - wrapRect.left + (mid / CHART_VIEW_WIDTH) * svgRect.width}px`;
    tooltip.style.top = `${svgRect.top - wrapRect.top + (plot.top / CHART_VIEW_HEIGHT) * svgRect.height + 24}px`;
  });
  overlay.addEventListener("pointerleave", hide);
}

function showChartMessage(widget, text) {
  widget.querySelector(".ev-chart").innerHTML = "";
  const messageEl = widget.querySelector(".chart-message");
  messageEl.textContent = text;
  messageEl.hidden = false;
}

function hideChartMessage(widget) {
  widget.querySelector(".chart-message").hidden = true;
}

// Builds one labeled min/max slider (markup matches the styling in
// analysis.css, which is written generically so any number of these can be
// stacked in one widget) and wires the two thumbs to keep min <= max.
function buildDualRangeControl(id, labelText, onChange) {
  const container = document.createElement("div");
  container.className = "range-control";
  container.id = id;
  container.innerHTML = `
    <label>${labelText}: <span class="range-label"></span> <span class="range-sample-size"></span></label>
    <div class="dual-range">
      <div class="dual-range-track"></div>
      <div class="dual-range-fill"></div>
      <input type="range" class="range-min" min="0" max="1000" step="1" value="0" />
      <input type="range" class="range-max" min="0" max="1000" step="1" value="1000" />
    </div>
  `;

  const els = {
    container,
    rangeLabel: container.querySelector(".range-label"),
    rangeSampleSize: container.querySelector(".range-sample-size"),
    rangeFill: container.querySelector(".dual-range-fill"),
    rangeMin: container.querySelector(".range-min"),
    rangeMax: container.querySelector(".range-max"),
  };

  [els.rangeMin, els.rangeMax].forEach((input) => {
    input.addEventListener("input", () => {
      if (Number(els.rangeMin.value) > Number(els.rangeMax.value)) {
        const clampTo = input === els.rangeMin ? els.rangeMax : els.rangeMin;
        clampTo.value = input.value;
      }
      onChange();
    });
  });

  return els;
}

// Positions a .single-range's fill bar to match its slider's current value,
// so a lone slider fills the same way a .dual-range's does (see
// buildDualRangeControl) instead of relying on the browser's native track.
function updateSingleRangeFill(container) {
  const slider = container.querySelector("input[type=range]");
  const pct = ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
  container.querySelector(".single-range-fill").style.width = `${pct}%`;
}

// Single slider styled like .dual-range (see buildDualRangeControl) for the
// EV-curve widget's optional stop-loss: sell if price falls to or below
// this % of the start price, instead of always riding a miss to a total loss.
function buildStopLossControl(onChange) {
  const container = document.createElement("div");
  container.className = "range-control percent-control";
  container.innerHTML = `
    <label>Stop-loss — sell if price falls to &le; <span class="range-label"></span> of price at match start</label>
    <div class="single-range">
      <div class="single-range-track"></div>
      <div class="single-range-fill"></div>
      <input type="range" class="stop-loss-slider" min="0" max="100" step="1" value="0" />
    </div>
  `;

  const slider = container.querySelector(".stop-loss-slider");
  slider.addEventListener("input", () => {
    updateSingleRangeFill(container);
    onChange();
  });
  updateSingleRangeFill(container);
  return { container, slider, label: container.querySelector(".range-label") };
}

// Mirror of buildStopLossControl for the stop-loss-sweep widget's optional
// take-profit: sell if price rises to or above entry plus this % increase,
// with 0 meaning no take-profit at all (the position exits only via the
// stop-loss or settlement).
function buildTakeProfitControl(onChange) {
  const container = document.createElement("div");
  container.className = "range-control percent-control";
  container.innerHTML = `
    <label>Take-profit — sell if price rises to &ge; <span class="range-label"></span> above price at match start</label>
    <div class="single-range">
      <div class="single-range-track"></div>
      <div class="single-range-fill"></div>
      <input type="range" class="take-profit-slider" min="0" max="${EV_CURVE_MAX_THRESHOLD - EV_CURVE_MIN_THRESHOLD}" step="5" value="0" />
    </div>
  `;

  const slider = container.querySelector(".take-profit-slider");
  slider.addEventListener("input", () => {
    updateSingleRangeFill(container);
    onChange();
  });
  updateSingleRangeFill(container);
  return { container, slider, label: container.querySelector(".range-label") };
}

// Plain dollar-amount input for the dollar-profit EV-curve widget's
// per-match bet size — styled like buildStopLossControl's percent-control
// wrapper, just with a typed number instead of a slider.
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

// Integer input for the optimizer widget's sample-size floor — styled like
// buildBetAmountControl, just constrained to whole matches. label lets the
// band optimizer spell out that the floor applies per win-probability band,
// not to the search's total match count.
function buildMinSampleSizeControl(onChange, label = "Minimum sample size (matches)") {
  const container = document.createElement("div");
  container.className = "percent-control bet-amount-control";
  container.innerHTML = `
    <label for="min-sample-size-input">${label}</label>
    <input id="min-sample-size-input" type="number" min="1" step="1" value="20" />
  `;
  const input = container.querySelector("input");
  input.addEventListener("input", onChange);
  return { container, input };
}

// Numeric input for the band optimizer's win-probability band width (in
// percentage points) — same styling as buildMinSampleSizeControl.
function buildBandWidthControl(onChange) {
  const container = document.createElement("div");
  container.className = "percent-control bet-amount-control";
  container.innerHTML = `
    <label for="band-width-input">Win-probability band width (%)</label>
    <input id="band-width-input" type="number" min="0.5" step="0.5" value="${BAND_OPTIMIZER_BAND_WIDTH}" />
  `;
  const input = container.querySelector("input");
  input.addEventListener("input", onChange);
  return { container, input };
}

// Spread toggle for the dollar-profit widget — switches simulateMatchProfit
// from the naive bid/ask-midpoint fill (buy and sell at the same mid price)
// to buying at the ask and selling at the bid. Independent of fee
// simulation (see buildFeeSimControl) — spread and fees model two separate
// costs, so either can be toggled on its own.
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

// Fee-simulation dropdown for the dollar-profit widget — picks which
// venue's per-leg fee formula (see simulatedFee) simulateMatchProfit
// subtracts, independent of the spread toggle above.
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

// config: { id, title, volumeLabel, volumeOf(pair), maxVolume(), winProbFilter? }
// — volumeOf reads the filter value off an { event, stat } pair (see
// eventStatPairs), so the same widget shape can filter by an event-level
// field (total volume) or a stat-level one (volume before match start).
// winProbFilter, when true, adds a second slider filtering by the currently
// selected side's implied win probability (share price) at match start.
// stopLoss, when true, adds a slider that makes matches which never hit the
// take-profit threshold but did fall to or below it a smaller ("stopped
// out") loss instead of a total one — see expectedValuePerBet. betAmount,
// when true, adds a typed dollar-per-match input (see buildBetAmountControl)
// for configs that price outcomes in dollars rather than percent-of-stake.
// computePoints/formatYTick/formatTooltipValue let a config swap in its own
// point computation and value formatting (see computeDollarCurve and
// DOLLAR_PROFIT_CONFIG) instead of the default percent-of-stake EV curve.
// takeProfit, when true, adds a fixed take-profit slider (for configs that
// sweep the stop-loss instead — see STOP_LOSS_DOLLAR_CONFIG), and
// xAxis/formatTooltipTitle rename the swept variable's axis and tooltip.
function buildEvCurveWidget(config) {
  const widget = document.createElement("div");
  widget.className = "widget widget-wide";
  widget.id = config.id;
  widget.innerHTML = `
    <div class="widget-header">
      <span class="widget-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <h2>${config.title}</h2>
    </div>
    <div class="side-toggle" role="group" aria-label="Side">
      <button type="button" data-side="underdog" class="active">Underdog</button>
      <button type="button" data-side="overdog">Overdog</button>
    </div>
    <div class="chart-wrap">
      <svg class="ev-chart" viewBox="0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}"></svg>
      <div class="chart-message" hidden></div>
      <div class="chart-tooltip" hidden></div>
    </div>
    <div class="range-controls"></div>
  `;

  const local = { side: "underdog", betAmount: 100, spread: false, feeSim: "none" };
  const update = () => updateEvCurveWidget(widget, els, local, config);

  const rangeControls = widget.querySelector(".range-controls");
  const els = {
    svg: widget.querySelector(".ev-chart"),
    tooltip: widget.querySelector(".chart-tooltip"),
    volume: buildDualRangeControl("volume-range", config.volumeLabel, update),
    winProb: config.winProbFilter
      ? buildDualRangeControl("winprob-range", "Side's win probability at match start", update)
      : null,
    stopLoss: config.stopLoss ? buildStopLossControl(update) : null,
    takeProfit: config.takeProfit ? buildTakeProfitControl(update) : null,
    betAmount: config.betAmount ? buildBetAmountControl(update) : null,
    spread: config.realisticFill ? buildSpreadControl(update) : null,
    feeSim: config.realisticFill ? buildFeeSimControl(update) : null,
  };
  rangeControls.appendChild(els.volume.container);
  if (els.winProb) rangeControls.appendChild(els.winProb.container);
  if (els.stopLoss) rangeControls.appendChild(els.stopLoss.container);
  if (els.takeProfit) rangeControls.appendChild(els.takeProfit.container);
  if (els.betAmount) rangeControls.appendChild(els.betAmount.container);
  if (els.spread) rangeControls.appendChild(els.spread.container);
  if (els.feeSim) rangeControls.appendChild(els.feeSim.container);

  widget.querySelectorAll(".side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      local.side = button.dataset.side;
      widget.querySelectorAll(".side-toggle button").forEach((b) => b.classList.toggle("active", b === button));
      update();
    });
  });

  evCurveWidgetUpdaters.push(update);
  return widget;
}

function updateEvCurveWidget(widget, els, local, config) {
  const maxVolumeForScale = config.maxVolume();
  const minVolume = sliderPositionToVolume(Number(els.volume.rangeMin.value), maxVolumeForScale);
  const maxVolumePosition = Number(els.volume.rangeMax.value);
  const maxVolume = maxVolumePosition >= 1000 ? Infinity : sliderPositionToVolume(maxVolumePosition, maxVolumeForScale);
  els.volume.rangeLabel.textContent = `${formatVolume(minVolume)} – ${maxVolumePosition >= 1000 ? "max" : formatVolume(maxVolume)}`;
  els.volume.rangeFill.style.left = `${Number(els.volume.rangeMin.value) / 10}%`;
  els.volume.rangeFill.style.right = `${100 - maxVolumePosition / 10}%`;

  let minWinProb = 0;
  let maxWinProb = 100;
  if (els.winProb) {
    minWinProb = sliderPositionToPercent(Number(els.winProb.rangeMin.value));
    maxWinProb = sliderPositionToPercent(Number(els.winProb.rangeMax.value));
    els.winProb.rangeLabel.textContent = `${minWinProb.toFixed(0)}% – ${maxWinProb.toFixed(0)}%`;
    els.winProb.rangeFill.style.left = `${Number(els.winProb.rangeMin.value) / 10}%`;
    els.winProb.rangeFill.style.right = `${100 - Number(els.winProb.rangeMax.value) / 10}%`;
  }

  let stopLossPercent = 0;
  if (els.stopLoss) {
    stopLossPercent = Number(els.stopLoss.slider.value);
    els.stopLoss.label.textContent = stopLossPercent === 0 ? "Off" : `${stopLossPercent}%`;
  }

  let takeProfitPercent = null;
  if (els.takeProfit) {
    const increase = Number(els.takeProfit.slider.value);
    if (increase > 0) takeProfitPercent = EV_CURVE_MIN_THRESHOLD + increase;
    els.takeProfit.label.textContent = increase === 0 ? "Off" : `+${increase}%`;
  }

  if (els.betAmount) {
    local.betAmount = Number(els.betAmount.input.value) || 0;
  }

  local.spread = els.spread ? els.spread.checkbox.checked : false;
  local.feeSim = els.feeSim ? els.feeSim.select.value : "none";

  if (!state.statsLoaded) {
    els.volume.rangeSampleSize.textContent = "";
    if (els.winProb) els.winProb.rangeSampleSize.textContent = "";
    showChartMessage(widget, "Loading match price data (first load can take a minute or two)…");
    return;
  }

  const pairs = eventStatPairs(sidebarFilteredEvents()).filter((pair) => {
    const volume = config.volumeOf(pair);
    if (volume < minVolume || volume > maxVolume) return false;
    if (els.winProb) {
      const winProb = pair.stat[`${local.side}_start_price`] * 100;
      if (winProb < minWinProb || winProb > maxWinProb) return false;
    }
    return true;
  });
  els.volume.rangeSampleSize.textContent = `(n=${pairs.length} match${pairs.length === 1 ? "" : "es"})`;
  if (els.winProb) els.winProb.rangeSampleSize.textContent = `(n=${pairs.length} match${pairs.length === 1 ? "" : "es"})`;

  const stats = pairs.map((pair) => pair.stat);
  const points = config.computePoints
    ? config.computePoints(stats, local.side, { stopLossPercent, takeProfitPercent, betAmount: local.betAmount, spread: local.spread, feeSim: local.feeSim })
    : computeEvCurve(stats, local.side, stopLossPercent);
  if (points.length === 0) {
    showChartMessage(widget, "No matches with usable price data in the current filters.");
    return;
  }

  hideChartMessage(widget);
  const color = SIDE_COLORS[local.side];
  const formatYTick = config.formatYTick ? (tick) => config.formatYTick(tick, local) : undefined;
  const formatTooltipValue = config.formatTooltipValue ? (point) => config.formatTooltipValue(point, local) : undefined;
  const scales = renderEvChart(els.svg, points, color, formatYTick, config.xAxis);
  attachEvChartHover(widget, els.svg, points, scales, color, els.tooltip, formatTooltipValue, config.formatTooltipTitle);
}

const evCurveWidgetUpdaters = [];

const TOTAL_VOLUME_CONFIG = {
  id: "widget-ev-curve",
  title: "Max price increase vs. expected profit",
  volumeLabel: "Total volume range",
  volumeOf: (pair) => pair.event.volume,
  maxVolume: () => state.maxVolume,
};

const PRE_MATCH_VOLUME_CONFIG = {
  id: "widget-ev-curve-prematch",
  title: "Max price increase vs. expected profit (by pre-match volume)",
  volumeLabel: "Pre-match volume",
  volumeOf: (pair) => pair.stat.volume_before_start,
  maxVolume: () => state.maxVolumeBeforeStart,
  winProbFilter: true,
  stopLoss: true,
};

// Same pre-match-volume filter set as PRE_MATCH_VOLUME_CONFIG, but priced in
// dollars via a real time-ordered path simulation (simulateMatchProfit)
// instead of the plain max/min-based percent EV curve — see
// simulateMatchProfit and computeDollarCurve for why those aren't
// interchangeable (first-touch ordering of take-profit vs. stop-loss).
const DOLLAR_PROFIT_CONFIG = {
  id: "widget-ev-curve-dollar",
  title: "Max price increase vs. money made (by pre-match volume)",
  volumeLabel: "Pre-match volume",
  volumeOf: (pair) => pair.stat.volume_before_start,
  maxVolume: () => state.maxVolumeBeforeStart,
  winProbFilter: true,
  stopLoss: true,
  betAmount: true,
  realisticFill: true,
  computePoints: computeDollarCurve,
  formatYTick: (tick) => formatDollars(tick),
  formatTooltipValue: formatDollarsTooltipValue,
};

// The stop-loss counterpart of DOLLAR_PROFIT_CONFIG: same filters and
// realistic-fill simulation, but sweeping the stop-loss level on the x axis
// (0 = no stop-loss, 100 = sell on any dip below entry) with an optional
// fixed take-profit as the slider, instead of the other way around.
const STOP_LOSS_DOLLAR_CONFIG = {
  id: "widget-sl-curve-dollar",
  title: "Stop-loss vs. money made (by pre-match volume)",
  volumeLabel: "Pre-match volume",
  volumeOf: (pair) => pair.stat.volume_before_start,
  maxVolume: () => state.maxVolumeBeforeStart,
  winProbFilter: true,
  takeProfit: true,
  betAmount: true,
  realisticFill: true,
  computePoints: computeStopLossDollarCurve,
  xAxis: { max: 100, tickStep: 10, formatTick: (tick) => (tick === 0 ? "off" : `≤${tick}%`) },
  formatTooltipTitle: (point) => (point.increase === 0 ? "No stop-loss" : `Stop-loss ≤${point.increase}% of entry`),
  formatYTick: (tick) => formatDollars(tick),
  formatTooltipValue: formatDollarsTooltipValue,
};

// config: { id, title, note, run, render } — run is the async grid search
// (runOptimizer's signature) and render draws its winning result
// (renderOptimizerResult's signature), so the single-threshold optimizer
// and the per-band exit-policy optimizer share one widget shell.
const OPTIMIZER_CONFIG = {
  id: "widget-optimizer",
  title: "Optimal filter combination (max profit, by pre-match volume)",
  note: "Grid search over pre-match volume, win probability, stop-loss, and take-profit thresholds for the combination with the highest total profit — a coarse approximation snapped to quantiles of the actual data, not a guaranteed global optimum. Uses the same realistic spread/fee simulation as the dollar-profit widget above.",
  run: runOptimizer,
  render: renderOptimizerResult,
};

const BAND_OPTIMIZER_CONFIG = {
  id: "widget-optimizer-bands",
  title: "Optimal exit policy by win probability (max profit, by pre-match volume)",
  note: "Like the optimizer above, but instead of one static take-profit threshold it partitions matches into fixed-width win-probability bands (width set below) and finds each band's own optimal stop-loss and take-profit — a side entered at 45% can never gain more than ~+120% (price caps at $1), so the optimal exit shifts with the starting probability. A band is only counted as “bet” if its best exit clears its own 95% margin of error — e.g. +$30 over 104 matches is within the swing you'd expect from chance alone and gets skipped, even though it's technically positive; everything else is skipped (“no bet”). Pre-match volume stays a single shared range. Minimum sample size is a per-band floor, not a floor on the total match count — each band needs that many matches of its own to be searched at all, so narrower bands (or a stricter floor) leave more edge bands skipped for lack of data. Same grid-search caveats and spread/fee simulation as above.",
  run: runBandOptimizer,
  render: renderBandOptimizerResult,
  perBand: true,
};

// Unlike the EV-curve widgets above, this one doesn't recompute on every
// filter tweak (renderAll/evCurveWidgetUpdaters) — a run costs a bounded
// but still noticeable grid search (see config.run), so it only runs
// when the button is clicked, and other controls just mark the last result
// stale rather than kicking off a new search themselves.
function buildOptimizerWidget(config) {
  const widget = document.createElement("div");
  widget.className = "widget widget-wide";
  widget.id = config.id;
  widget.innerHTML = `
    <div class="widget-header">
      <span class="widget-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <h2>${config.title}</h2>
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
    <div class="optimizer-result" hidden></div>
    <p class="optimizer-note">${config.note}</p>
  `;

  const local = { side: "underdog", runToken: 0 };
  const rangeControls = widget.querySelector(".range-controls");
  const runButton = widget.querySelector(".optimizer-run-button");
  const resultEl = widget.querySelector(".optimizer-result");
  const progressEl = widget.querySelector(".optimizer-progress");
  const progressFill = widget.querySelector(".optimizer-progress-fill");
  const progressLabel = widget.querySelector(".optimizer-progress-label");

  const markStale = () => resultEl.classList.toggle("optimizer-result-stale", !resultEl.hidden);

  const els = {
    betAmount: buildBetAmountControl(markStale),
    minSampleSize: buildMinSampleSizeControl(markStale, config.perBand ? "Minimum sample size (matches per band)" : undefined),
    bandWidth: config.perBand ? buildBandWidthControl(markStale) : null,
    spread: buildSpreadControl(markStale),
    feeSim: buildFeeSimControl(markStale),
  };
  rangeControls.append(els.betAmount.container, els.minSampleSize.container);
  if (els.bandWidth) rangeControls.append(els.bandWidth.container);
  rangeControls.append(els.spread.container, els.feeSim.container);

  widget.querySelectorAll(".side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      local.side = button.dataset.side;
      widget.querySelectorAll(".side-toggle button").forEach((b) => b.classList.toggle("active", b === button));
      markStale();
    });
  });

  const currentParams = () => ({
    side: local.side,
    betAmount: Number(els.betAmount.input.value) || 0,
    minSampleSize: Math.max(1, Math.round(Number(els.minSampleSize.input.value) || 1)),
    bandWidth: els.bandWidth ? Math.max(0.5, Number(els.bandWidth.input.value) || BAND_OPTIMIZER_BAND_WIDTH) : undefined,
    spread: els.spread.checkbox.checked,
    feeSim: els.feeSim.select.value,
  });

  const renderResult = (best, params, totalMatches) =>
    config.render(resultEl, best, params.side, params.betAmount, params.minSampleSize, params.spread, params.feeSim, totalMatches);

  const runSearch = async (params) => {
    const token = ++local.runToken;
    const pairs = eventStatPairs(sidebarFilteredEvents());

    runButton.disabled = true;
    resultEl.hidden = true;
    progressEl.hidden = false;
    progressFill.style.width = "0%";
    progressLabel.textContent = "0%";

    const best = await config.run(
      pairs,
      params.side,
      params.betAmount,
      params.minSampleSize,
      params.spread,
      params.feeSim,
      (fraction) => {
        progressFill.style.width = `${Math.round(fraction * 100)}%`;
        progressLabel.textContent = `${Math.round(fraction * 100)}%`;
      },
      () => token === local.runToken,
      params.bandWidth
    );

    if (token !== local.runToken) return; // superseded by a newer run

    progressEl.hidden = true;
    runButton.disabled = false;
    renderResult(best, params, pairs.length);
  };

  runButton.addEventListener("click", () => {
    if (!state.statsLoaded) {
      resultEl.hidden = false;
      resultEl.classList.remove("optimizer-result-stale");
      resultEl.innerHTML = `<div class="optimizer-result-empty">Loading match price data (first load can take a minute or two)…</div>`;
      return;
    }

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

// Renders runOptimizer's winning combination (or an explanatory empty
// state) into the optimizer widget's result panel.
function renderOptimizerResult(resultEl, best, side, betAmount, minSampleSize, spread, feeSim, totalMatches) {
  resultEl.hidden = false;
  resultEl.classList.remove("optimizer-result-stale");

  if (!best) {
    resultEl.innerHTML = `<div class="optimizer-result-empty">No combination of filters reached a sample size of ${minSampleSize} match${minSampleSize === 1 ? "" : "es"} (of ${totalMatches} matches in the current sidebar filters).</div>`;
    return;
  }

  const suffix = simulationNotesSuffix(spread, feeSim);

  const item = (label, value) => `
    <div class="optimizer-result-item">
      <div class="result-label">${label}</div>
      <div class="result-value">${value}</div>
    </div>`;

  resultEl.innerHTML = `
    <div class="optimizer-result-headline">
      <div class="result-label">Best total profit betting $${betAmount}/match, ${side}${suffix}</div>
      <div class="result-value ${best.value >= 0 ? "positive" : "negative"}">${best.value >= 0 ? "+" : ""}${formatDollars(best.value)}</div>
      <div class="result-detail">n=${best.n} of ${totalMatches} matches in the current sidebar filters</div>
    </div>
    <div class="optimizer-result-grid">
      ${item("Pre-match volume", `${formatVolume(best.minVolume)} – ${formatVolume(best.maxVolume)}`)}
      ${item("Win probability at start", `${best.minWinProb.toFixed(0)}% – ${best.maxWinProb.toFixed(0)}%`)}
      ${item("Stop-loss", best.stopLoss === 0 ? "Off" : `≤ ${best.stopLoss}% of start price`)}
      ${item("Take-profit (max price)", `+${best.threshold - EV_CURVE_MIN_THRESHOLD}%`)}
    </div>
  `;
}

// One row of the band optimizer's policy table — dims bands the policy
// skips and says why (unprofitable at their best, or under the sample
// floor) instead of hiding them.
function bandTableRow(band) {
  const range = formatWinProbBand(band.lo, band.hi);
  if (!band.exit) {
    return `<tr class="band-no-bet"><td>${range}</td><td>—</td><td>—</td><td>too few matches</td><td>${band.matches}</td></tr>`;
  }
  const takeProfit = `+${band.exit.threshold - EV_CURVE_MIN_THRESHOLD}%`;
  const stopLoss = band.exit.stopLoss === 0 ? "Off" : `≤ ${band.exit.stopLoss}% of entry`;
  const profit = `${band.exit.value >= 0 ? "+" : ""}${formatDollars(band.exit.value)}`;
  if (!band.bet) {
    return `<tr class="band-no-bet"><td>${range}</td><td>${takeProfit}</td><td>${stopLoss}</td><td>no bet — ${bandSkipReason(band.exit)} (${profit} at best)</td><td>${band.exit.n}</td></tr>`;
  }
  return `<tr><td>${range}</td><td>${takeProfit}</td><td>${stopLoss}</td><td class="positive">${profit} ± ${formatDollars(band.exit.marginOfError)}</td><td>${band.exit.n}</td></tr>`;
}

// Renders runBandOptimizer's winning policy (or an explanatory empty
// state): headline total, the exit-policy corridor chart, and a per-band
// table with the exact levels.
function renderBandOptimizerResult(resultEl, best, side, betAmount, minSampleSize, spread, feeSim, totalMatches) {
  resultEl.hidden = false;
  resultEl.classList.remove("optimizer-result-stale");

  if (!best) {
    resultEl.innerHTML = `<div class="optimizer-result-empty">No win-probability band reached a profitable exit at a sample size of ${minSampleSize} match${minSampleSize === 1 ? "" : "es"} per band (of ${totalMatches} matches in the current sidebar filters).</div>`;
    return;
  }

  resultEl.innerHTML = `
    <div class="optimizer-result-headline">
      <div class="result-label">Best total profit betting $${betAmount}/match, ${side}${simulationNotesSuffix(spread, feeSim)}</div>
      <div class="result-value ${best.value >= 0 ? "positive" : "negative"}">${best.value >= 0 ? "+" : ""}${formatDollars(best.value)}</div>
      <div class="result-detail">Pre-match volume ${formatVolume(best.minVolume)} – ${formatVolume(best.maxVolume)} · n=${best.n} matches in bet bands, of ${totalMatches} in the current sidebar filters</div>
    </div>
    <div class="result-label band-chart-caption">Sell trigger (% of entry price) by win probability at match start</div>
    <div class="chart-wrap">
      <svg class="ev-chart" viewBox="0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}"></svg>
      <div class="chart-tooltip" hidden></div>
    </div>
    <table class="band-table">
      <thead><tr><th>Win prob at start</th><th>Take-profit</th><th>Stop-loss</th><th>Profit</th><th>n</th></tr></thead>
      <tbody>${best.bands.map(bandTableRow).join("")}</tbody>
    </table>
  `;

  const svg = resultEl.querySelector(".ev-chart");
  const scales = renderExitPolicyChart(svg, best.bands, side);
  attachExitPolicyHover(resultEl.querySelector(".chart-wrap"), svg, best.bands, scales);
}

function buildPriceSpikeWidget() {
  const widget = document.createElement("div");
  widget.className = "widget";
  widget.id = "widget-price-spike";
  widget.innerHTML = `
    <div class="widget-header">
      <span class="widget-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <h2>Price spike vs. match start</h2>
    </div>
    <div class="widget-controls">
      <div class="side-toggle" role="group" aria-label="Side">
        <button type="button" data-side="underdog" class="active">Underdog</button>
        <button type="button" data-side="overdog">Overdog</button>
      </div>
      <div class="percent-control">
        <label for="threshold-slider">Max price reached &ge; <span id="threshold-label"></span> of price at match start</label>
        <div class="single-range">
          <div class="single-range-track"></div>
          <div class="single-range-fill"></div>
          <input id="threshold-slider" type="range" min="100" max="1000" step="0.1" value="${DEFAULT_THRESHOLD_PERCENT}" />
        </div>
      </div>
      <div id="volume-filter">
        <label for="min-volume">Min total volume: <span id="min-volume-label">0</span></label>
        <div class="single-range">
          <div class="single-range-track"></div>
          <div class="single-range-fill"></div>
          <input id="min-volume" type="range" min="0" max="1000" value="0" step="1" />
        </div>
      </div>
    </div>
    <div class="widget-result">
      <div class="result-label">Hit rate</div>
      <div class="result-value" id="result-value">—</div>
      <div class="result-detail" id="result-detail"></div>
    </div>
    <div class="widget-result">
      <div class="result-label">Expected value per bet</div>
      <div class="result-value" id="ev-value">—</div>
      <div class="result-detail">Sell the instant the threshold is hit; otherwise assume a total loss.</div>
    </div>
  `;

  widget.querySelectorAll(".side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      state.side = button.dataset.side;
      widget.querySelectorAll(".side-toggle button").forEach((b) => b.classList.toggle("active", b === button));
      updatePriceSpikeResult();
    });
  });

  const thresholdSlider = widget.querySelector("#threshold-slider");
  thresholdSlider.addEventListener("input", (e) => {
    state.thresholdPercent = Number(e.target.value);
    updateSingleRangeFill(thresholdSlider.closest(".single-range"));
    updatePriceSpikeResult();
  });
  updateSingleRangeFill(thresholdSlider.closest(".single-range"));

  const minVolumeSlider = widget.querySelector("#min-volume");
  minVolumeSlider.addEventListener("input", () => {
    updateSingleRangeFill(minVolumeSlider.closest(".single-range"));
    updateMinVolumeLabel();
    updatePriceSpikeResult();
  });
  updateSingleRangeFill(minVolumeSlider.closest(".single-range"));

  return widget;
}

function updatePriceSpikeResult() {
  document.getElementById("threshold-label").textContent = `${state.thresholdPercent.toFixed(1)}%`;

  const resultEl = document.getElementById("result-value");
  const detailEl = document.getElementById("result-detail");
  if (!state.statsLoaded) {
    resultEl.textContent = "…";
    detailEl.textContent = "Loading match price data (first load can take a minute or two)…";
    updateExpectedValue(0, 0, state.thresholdPercent);
    return;
  }

  const inScope = widgetFilteredEvents();
  const stats = statsForEvents(inScope);
  const { count, total } = spikeResult(stats, state.side, state.thresholdPercent);
  updateExpectedValue(count, total, state.thresholdPercent);
  if (total === 0) {
    resultEl.textContent = "—";
    detailEl.textContent = "No matches with usable price data in the current filters.";
    return;
  }

  const pct = (100 * count) / total;
  resultEl.textContent = `${pct.toFixed(1)}%`;
  detailEl.textContent = `${count} of ${total} matches with a reachable target (of the ${inScope.length} matching the current filters)`;
}

// If the take-profit threshold is reached, selling there banks
// (thresholdPercent/100 - 1) profit. Failing that, if a stop-loss is set
// (stopLossPercent > 0) and stoppedRate of matches fell to or below it,
// selling there banks (stopLossPercent/100 - 1) — a smaller loss than
// riding it out. Everything else is modeled as a total loss (matches the
// widget's binary hit/miss framing — see the "Sell the instant..." detail
// text). stoppedRate/stopLossPercent default to 0, which reduces this to
// the plain hit-or-total-loss formula.
function expectedValuePerBet(winRate, thresholdPercent, stoppedRate = 0, stopLossPercent = 0) {
  const missRate = 1 - winRate - stoppedRate;
  const profitIfHit = thresholdPercent / 100 - 1;
  const profitIfStopped = stopLossPercent / 100 - 1;
  return winRate * profitIfHit + stoppedRate * profitIfStopped - missRate * 1;
}

function updateExpectedValue(count, total, thresholdPercent) {
  const evEl = document.getElementById("ev-value");
  if (total === 0) {
    evEl.textContent = "—";
    evEl.classList.remove("positive", "negative");
    return;
  }

  const ev = expectedValuePerBet(count / total, thresholdPercent);
  evEl.textContent = `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
  evEl.classList.toggle("positive", ev >= 0);
  evEl.classList.toggle("negative", ev < 0);
}

function renderAll() {
  updateFilterSummary(sidebarFilteredEvents().length);
  updatePriceSpikeResult();
  evCurveWidgetUpdaters.forEach((update) => update());
}

function setupFilters() {
  document.getElementById("analysis-search").addEventListener("input", renderAll);
  document.getElementById("analysis-date-from").addEventListener("change", renderAll);
  document.getElementById("analysis-date-to").addEventListener("change", renderAll);
  document.querySelectorAll("#analysis-date-filter .date-presets button").forEach((button) => {
    button.addEventListener("click", () => applyDatePreset(button.dataset.preset));
  });
  document.getElementById("only-pandascore-start").addEventListener("change", renderAll);
}

async function loadPriceSpikeStats() {
  const stats = await fetchJson("/api/price-spike-stats");
  state.statsByTicker = new Map(stats.map((stat) => [stat.event_ticker, stat]));
  state.statsLoaded = true;
  state.maxVolumeBeforeStart = Math.max(0, ...stats.map((stat) => stat.volume_before_start));
  renderAll();
}

async function init() {
  const widgets = document.getElementById("widgets");
  widgets.appendChild(buildPriceSpikeWidget());
  widgets.appendChild(buildEvCurveWidget(TOTAL_VOLUME_CONFIG));
  widgets.appendChild(buildEvCurveWidget(PRE_MATCH_VOLUME_CONFIG));
  widgets.appendChild(buildEvCurveWidget(DOLLAR_PROFIT_CONFIG));
  widgets.appendChild(buildEvCurveWidget(STOP_LOSS_DOLLAR_CONFIG));
  widgets.appendChild(buildOptimizerWidget(OPTIMIZER_CONFIG));
  widgets.appendChild(buildOptimizerWidget(BAND_OPTIMIZER_CONFIG));
  applyWidgetOrder(widgets, loadWidgetOrder());
  setupWidgetDragAndDrop(widgets);
  setupFilters();

  state.events = await loadEvents();
  state.maxVolume = Math.max(0, ...state.events.map((event) => event.volume));
  updateMinVolumeLabel();
  renderAll();

  loadPriceSpikeStats();
}

init();
})();
