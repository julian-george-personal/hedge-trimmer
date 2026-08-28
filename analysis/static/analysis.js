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

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
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

function updateMinVolumeLabel() {
  document.getElementById("min-volume-label").textContent = formatVolume(currentMinVolume());
}

function toDateInputValue(date) {
  return date.toLocaleDateString("en-CA"); // yyyy-mm-dd, respects local timezone
}

function currentDateRange() {
  const from = document.getElementById("date-from").value;
  const to = document.getElementById("date-to").value;
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
  const fromInput = document.getElementById("date-from");
  const toInput = document.getElementById("date-to");

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
  const query = document.getElementById("search").value.trim();
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

function spikeResult(stats, side, thresholdPercent) {
  if (stats.length === 0) return { count: 0, total: 0 };
  const factor = thresholdPercent / 100;
  const count = stats.filter((stat) => {
    const startPrice = stat[`${side}_start_price`];
    const maxPrice = stat[`${side}_max_price`];
    return maxPrice >= factor * startPrice;
  }).length;
  return { count, total: stats.length };
}

// Samples the EV formula across the whole threshold range so the curve
// widget can plot expected profit as a function of the exit threshold. The
// true curve is a step function (hit rate only changes at each match's own
// max/start ratio) that's linear between steps; sampling every integer
// percentage point renders that closely enough at chart resolution.
function computeEvCurve(stats, side) {
  const points = [];
  for (let threshold = EV_CURVE_MIN_THRESHOLD; threshold <= EV_CURVE_MAX_THRESHOLD; threshold += EV_CURVE_STEP) {
    const { count, total } = spikeResult(stats, side, threshold);
    if (total === 0) return [];
    points.push({ increase: threshold - EV_CURVE_MIN_THRESHOLD, ev: expectedValuePerBet(count / total, threshold) });
  }
  return points;
}

function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = (value) => r0 + ((value - d0) / span) * (r1 - r0);
  scale.invert = (value) => d0 + ((value - r0) / (r1 - r0 || 1)) * span;
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

// Clears and redraws the svg (gridlines, axis labels, data line); returns
// the scales so the hover layer can map pointer position back to a data point.
function renderEvChart(svg, points, color) {
  svg.innerHTML = "";
  const plot = chartPlotArea();
  const xDomain = [0, EV_CURVE_MAX_THRESHOLD - EV_CURVE_MIN_THRESHOLD];
  const evs = points.map((p) => p.ev);
  const yDataMin = Math.min(...evs, 0);
  const yDataMax = Math.max(...evs, 0);
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
    label.textContent = `${tick > 0 ? "+" : ""}${Math.round(tick * 100)}%`;
    grid.appendChild(label);
  });
  for (let tick = xDomain[0]; tick <= xDomain[1]; tick += 100) {
    const label = svgEl("text", { x: xScale(tick), y: plot.bottom + 20, class: "chart-axis-label", "text-anchor": "middle" });
    label.textContent = `+${tick}%`;
    grid.appendChild(label);
  }
  svg.appendChild(grid);

  const linePoints = points.map((p) => `${xScale(p.increase)},${yScale(p.ev)}`).join(" ");
  svg.appendChild(svgEl("polyline", { points: linePoints, class: "chart-line", style: `stroke:${color}` }));

  return { xScale, yScale, plot };
}

// Transparent overlay over the plot area that tracks the pointer, snaps to
// the nearest sampled point (points are one per integer % so the index IS
// the increase value), and drives a crosshair + tooltip — see
// references/interaction.md's "crosshair finds the X" pattern.
function attachEvChartHover(widget, svg, points, scales, color, tooltip) {
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
    const y = yScale(point.ev);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.classList.add("visible");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.classList.add("visible");

    tooltip.hidden = false;
    tooltip.innerHTML = "";
    const line1 = document.createElement("div");
    line1.textContent = `+${point.increase}% max price`;
    const line2 = document.createElement("div");
    line2.className = "chart-tooltip-value";
    line2.textContent = `${point.ev >= 0 ? "+" : ""}${(point.ev * 100).toFixed(1)}% expected profit`;
    tooltip.append(line1, line2);

    const wrapRect = widget.querySelector(".chart-wrap").getBoundingClientRect();
    tooltip.style.left = `${svgRect.left - wrapRect.left + (x / CHART_VIEW_WIDTH) * svgRect.width}px`;
    tooltip.style.top = `${svgRect.top - wrapRect.top + (y / CHART_VIEW_HEIGHT) * svgRect.height}px`;
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

// config: { id, title, volumeLabel, volumeOf(pair), maxVolume() } — volumeOf
// reads the filter value off an { event, stat } pair (see eventStatPairs),
// so the same widget shape can filter by an event-level field (total
// volume) or a stat-level one (volume before match start).
function buildEvCurveWidget(config) {
  const widget = document.createElement("div");
  widget.className = "widget widget-wide";
  widget.id = config.id;
  widget.innerHTML = `
    <h2>${config.title}</h2>
    <div class="side-toggle" role="group" aria-label="Side">
      <button type="button" data-side="underdog" class="active">Underdog</button>
      <button type="button" data-side="overdog">Overdog</button>
    </div>
    <div class="chart-wrap">
      <svg class="ev-chart" viewBox="0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}"></svg>
      <div class="chart-message" hidden></div>
      <div class="chart-tooltip" hidden></div>
    </div>
    <div class="range-control">
      <label>${config.volumeLabel}: <span class="range-label"></span> <span class="range-sample-size"></span></label>
      <div class="dual-range">
        <div class="dual-range-track"></div>
        <div class="dual-range-fill"></div>
        <input type="range" class="range-min" min="0" max="1000" step="1" value="0" />
        <input type="range" class="range-max" min="0" max="1000" step="1" value="1000" />
      </div>
    </div>
  `;

  const els = {
    svg: widget.querySelector(".ev-chart"),
    tooltip: widget.querySelector(".chart-tooltip"),
    rangeLabel: widget.querySelector(".range-label"),
    rangeSampleSize: widget.querySelector(".range-sample-size"),
    rangeFill: widget.querySelector(".dual-range-fill"),
    rangeMin: widget.querySelector(".range-min"),
    rangeMax: widget.querySelector(".range-max"),
  };
  const local = { side: "underdog" };

  const update = () => updateEvCurveWidget(widget, els, local, config);

  widget.querySelectorAll(".side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      local.side = button.dataset.side;
      widget.querySelectorAll(".side-toggle button").forEach((b) => b.classList.toggle("active", b === button));
      update();
    });
  });

  [els.rangeMin, els.rangeMax].forEach((input) => {
    input.addEventListener("input", () => {
      if (Number(els.rangeMin.value) > Number(els.rangeMax.value)) {
        const clampTo = input === els.rangeMin ? els.rangeMax : els.rangeMin;
        clampTo.value = input.value;
      }
      update();
    });
  });

  evCurveWidgetUpdaters.push(update);
  return widget;
}

function updateEvCurveWidget(widget, els, local, config) {
  const maxVolumeForScale = config.maxVolume();
  const minVolume = sliderPositionToVolume(Number(els.rangeMin.value), maxVolumeForScale);
  const maxPosition = Number(els.rangeMax.value);
  const maxVolume = maxPosition >= 1000 ? Infinity : sliderPositionToVolume(maxPosition, maxVolumeForScale);
  els.rangeLabel.textContent = `${formatVolume(minVolume)} – ${maxPosition >= 1000 ? "max" : formatVolume(maxVolume)}`;
  els.rangeFill.style.left = `${Number(els.rangeMin.value) / 10}%`;
  els.rangeFill.style.right = `${100 - maxPosition / 10}%`;

  if (!state.statsLoaded) {
    els.rangeSampleSize.textContent = "";
    showChartMessage(widget, "Loading match price data (first load can take a minute or two)…");
    return;
  }

  const pairs = eventStatPairs(sidebarFilteredEvents()).filter((pair) => {
    const volume = config.volumeOf(pair);
    return volume >= minVolume && volume <= maxVolume;
  });
  els.rangeSampleSize.textContent = `(n=${pairs.length} match${pairs.length === 1 ? "" : "es"})`;

  const points = computeEvCurve(pairs.map((pair) => pair.stat), local.side);
  if (points.length === 0) {
    showChartMessage(widget, "No matches with usable price data in the current filters.");
    return;
  }

  hideChartMessage(widget);
  const color = SIDE_COLORS[local.side];
  const scales = renderEvChart(els.svg, points, color);
  attachEvChartHover(widget, els.svg, points, scales, color, els.tooltip);
}

const evCurveWidgetUpdaters = [];

const TOTAL_VOLUME_CONFIG = {
  id: "widget-ev-curve",
  title: "Max price increase vs. expected profit",
  volumeLabel: "Volume range",
  volumeOf: (pair) => pair.event.volume,
  maxVolume: () => state.maxVolume,
};

const PRE_MATCH_VOLUME_CONFIG = {
  id: "widget-ev-curve-prematch",
  title: "Max price increase vs. expected profit (by pre-match volume)",
  volumeLabel: "Volume before match start",
  volumeOf: (pair) => pair.stat.volume_before_start,
  maxVolume: () => state.maxVolumeBeforeStart,
};

function buildPriceSpikeWidget() {
  const widget = document.createElement("div");
  widget.className = "widget";
  widget.id = "widget-price-spike";
  widget.innerHTML = `
    <h2>Price spike vs. match start</h2>
    <div class="widget-controls">
      <div class="side-toggle" role="group" aria-label="Side">
        <button type="button" data-side="underdog" class="active">Underdog</button>
        <button type="button" data-side="overdog">Overdog</button>
      </div>
      <div class="percent-control">
        <label for="threshold-slider">Max price reached &ge; <span id="threshold-label"></span> of price at match start</label>
        <input id="threshold-slider" type="range" min="100" max="1000" step="0.1" value="${DEFAULT_THRESHOLD_PERCENT}" />
      </div>
      <div id="volume-filter">
        <label for="min-volume">Min volume: <span id="min-volume-label">0</span></label>
        <input id="min-volume" type="range" min="0" max="1000" value="0" step="1" />
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

  widget.querySelector("#threshold-slider").addEventListener("input", (e) => {
    state.thresholdPercent = Number(e.target.value);
    updatePriceSpikeResult();
  });

  widget.querySelector("#min-volume").addEventListener("input", () => {
    updateMinVolumeLabel();
    updatePriceSpikeResult();
  });

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
  detailEl.textContent = `${count} of ${total} matches (of the ${inScope.length} matching the current filters)`;
}

// If the threshold is reached, selling there banks (threshold/100 - 1) profit;
// otherwise this models the bet as a total loss (matches the widget's binary
// hit/miss framing — see the "Sell the instant..." detail text).
function expectedValuePerBet(winRate, thresholdPercent) {
  const profitIfHit = thresholdPercent / 100 - 1;
  return winRate * profitIfHit - (1 - winRate) * 1;
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
  document.getElementById("search").addEventListener("input", renderAll);
  document.getElementById("date-from").addEventListener("change", renderAll);
  document.getElementById("date-to").addEventListener("change", renderAll);
  document.querySelectorAll(".date-presets button").forEach((button) => {
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
  setupFilters();

  state.events = await fetchJson("/api/events");
  state.maxVolume = Math.max(0, ...state.events.map((event) => event.volume));
  updateMinVolumeLabel();
  renderAll();

  loadPriceSpikeStats();
}

init();
