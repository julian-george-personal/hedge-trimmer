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
    points.push({ increase: threshold - EV_CURVE_MIN_THRESHOLD, ev });
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

// config: { id, title, volumeLabel, volumeOf(pair), maxVolume(), winProbFilter? }
// — volumeOf reads the filter value off an { event, stat } pair (see
// eventStatPairs), so the same widget shape can filter by an event-level
// field (total volume) or a stat-level one (volume before match start).
// winProbFilter, when true, adds a second slider filtering by the currently
// selected side's implied win probability (share price) at match start.
// stopLoss, when true, adds a slider that makes matches which never hit the
// take-profit threshold but did fall to or below it a smaller ("stopped
// out") loss instead of a total one — see expectedValuePerBet.
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

  const local = { side: "underdog" };
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
  };
  rangeControls.appendChild(els.volume.container);
  if (els.winProb) rangeControls.appendChild(els.winProb.container);
  if (els.stopLoss) rangeControls.appendChild(els.stopLoss.container);

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

  const points = computeEvCurve(pairs.map((pair) => pair.stat), local.side, stopLossPercent);
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
