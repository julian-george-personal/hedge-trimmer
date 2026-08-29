(function () {
const TEAM_COLORS = ["#4f8cff", "#e0a63f", "#3fbf7f", "#e0555a"];

// Favorite (higher win probability) is always blue, underdog always orange —
// see pickTeamColors.
const OVERDOG_COLOR = TEAM_COLORS[0];
const UNDERDOG_COLOR = TEAM_COLORS[1];

const VOLUME_SLIDER_STEPS = 1000;
const VOLUME_SLIDER_MIDPOINT = 100_000;

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 560;

// How many matches the sidebar renders at once; "Load more" reveals the next page.
const MARKETS_PAGE_SIZE = 25;

// Default chart zoom: prefer starting 30min before the PandaScore match
// start (when we found one); otherwise fall back to the last 2h before the
// market settled.
const DEFAULT_ZOOM_MATCH_START_LEAD_SECONDS = 30 * 60;
const DEFAULT_ZOOM_FALLBACK_WINDOW_SECONDS = 2 * 60 * 60;

const state = {
  events: [],
  activeIndex: -1,
  selectedTicker: null,
  chart: null,
  matchStartAt: null,
  maxVolume: 0,
  maxPreMatchVolume: 0,
  totalVolumeFilter: null,
  preMatchVolumeFilter: null,
  visibleCount: MARKETS_PAGE_SIZE,
};

function eventMatchesQuery(event, query) {
  const haystack = `${event.title} ${event.event_ticker}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function formatVolume(volume) {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return String(Math.round(volume));
}

// Two-segment exponential mapping, anchored so VOLUME_SLIDER_MIDPOINT sits at
// the slider's midpoint: the bottom half sweeps 0 -> midpoint, the top half
// sweeps midpoint -> max. This gives fine control around the (heavily
// right-skewed) bulk of the distribution instead of cramming it into a
// sliver of the range.
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

// Drives one "min – max" dual-thumb volume slider (two overlapping <input
// type=range> elements sharing a track — see .range-slider in explorer.css).
// `getMaxVolume` is read lazily since the domain (state.maxVolume or
// state.maxPreMatchVolume) isn't known until data has loaded.
function createVolumeRangeFilter(prefix, { getMaxVolume, onChange }) {
  const minInput = document.getElementById(`${prefix}-min`);
  const maxInput = document.getElementById(`${prefix}-max`);
  const label = document.getElementById(`${prefix}-label`);
  const fill = document.getElementById(`${prefix}-fill`);
  const container = document.getElementById(`${prefix}-filter`);
  let enabled = true;

  function currentRange() {
    const maxVolume = getMaxVolume();
    return {
      min: sliderPositionToVolume(Number(minInput.value), maxVolume),
      max: sliderPositionToVolume(Number(maxInput.value), maxVolume),
    };
  }

  function refresh() {
    const minPct = (Number(minInput.value) / VOLUME_SLIDER_STEPS) * 100;
    const maxPct = (Number(maxInput.value) / VOLUME_SLIDER_STEPS) * 100;
    fill.style.left = `${minPct}%`;
    fill.style.right = `${100 - maxPct}%`;

    const { min, max } = currentRange();
    label.textContent = `${formatVolume(min)} – ${formatVolume(max)}`;
  }

  minInput.addEventListener("input", () => {
    if (Number(minInput.value) > Number(maxInput.value)) minInput.value = maxInput.value;
    refresh();
    onChange();
  });
  maxInput.addEventListener("input", () => {
    if (Number(maxInput.value) < Number(minInput.value)) maxInput.value = minInput.value;
    refresh();
    onChange();
  });

  return {
    currentRange,
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;
      minInput.disabled = !enabled;
      maxInput.disabled = !enabled;
      container.classList.toggle("loading", !enabled);
      if (enabled) {
        refresh();
      } else {
        label.textContent = "Loading…";
      }
    },
  };
}

function toDateInputValue(date) {
  return date.toLocaleDateString("en-CA"); // yyyy-mm-dd, respects local timezone
}

function currentDateRange() {
  const from = document.getElementById("explorer-date-from").value;
  const to = document.getElementById("explorer-date-to").value;
  return { from, to };
}

function eventInDateRange(event, { from, to }) {
  const closeTime = new Date(event.close_time).getTime();
  if (from && closeTime < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && closeTime > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function applyDatePreset(preset) {
  const today = new Date();
  const fromInput = document.getElementById("explorer-date-from");
  const toInput = document.getElementById("explorer-date-to");

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

  renderMarketList();
}

function formatDateLabel(closeTime) {
  return new Date(closeTime).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function groupEventsByDate(events) {
  const groups = [];
  let currentLabel = null;
  let currentGroup = null;

  events.forEach((event) => {
    const label = formatDateLabel(event.close_time);
    if (label !== currentLabel) {
      currentGroup = { label, events: [] };
      groups.push(currentGroup);
      currentLabel = label;
    }
    currentGroup.events.push(event);
  });

  return groups;
}

function buildMarketRow(event) {
  const row = document.createElement("div");
  row.className = "suggestion-row" + (event.has_candles ? "" : " no-candles");
  row.dataset.eventTicker = event.event_ticker;
  row.classList.toggle("selected", event.event_ticker === state.selectedTicker);
  row.innerHTML = `
    <div class="title">${event.title}</div>
    <div class="meta">
      <span>${event.event_ticker}</span>
      <span>vol: ${formatVolume(event.volume)}</span>
    </div>
  `;
  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    selectEvent(event);
  });
  return row;
}

function buildDateGroup(group) {
  const section = document.createElement("div");
  section.className = "date-group";

  const header = document.createElement("div");
  header.className = "date-header";
  header.textContent = group.label;
  section.appendChild(header);

  group.events.forEach((event) => section.appendChild(buildMarketRow(event)));
  return section;
}

function renderMarketList({ resetPaging = true } = {}) {
  const query = document.getElementById("explorer-search").value.trim();
  const totalVolumeRange = state.totalVolumeFilter.currentRange();
  const preMatchVolumeRange = state.preMatchVolumeFilter.currentRange();
  const preMatchVolumeActive = state.preMatchVolumeFilter.isEnabled();
  const dateRange = currentDateRange();
  const container = document.getElementById("market-list");
  container.innerHTML = "";
  state.activeIndex = -1;
  if (resetPaging) state.visibleCount = MARKETS_PAGE_SIZE;

  const matches = state.events.filter(
    (event) =>
      (!query || eventMatchesQuery(event, query)) &&
      event.volume >= totalVolumeRange.min &&
      event.volume <= totalVolumeRange.max &&
      (!preMatchVolumeActive ||
        ((event.pre_match_volume ?? 0) >= preMatchVolumeRange.min &&
          (event.pre_match_volume ?? 0) <= preMatchVolumeRange.max)) &&
      eventInDateRange(event, dateRange)
  );

  const visible = matches.slice(0, state.visibleCount);
  groupEventsByDate(visible).forEach((group) => container.appendChild(buildDateGroup(group)));

  updateListFooter(matches.length, visible.length);
}

function updateListFooter(totalCount, visibleCount) {
  document.getElementById("list-count").textContent =
    totalCount === 0 ? "No matches" : `Showing ${visibleCount} of ${totalCount}`;

  const loadMoreButton = document.getElementById("load-more");
  loadMoreButton.hidden = visibleCount >= totalCount;
}

function outcomeBadge(result) {
  if (result === "yes") return '<span class="outcome yes">won</span>';
  if (result === "no") return '<span class="outcome no">lost</span>';
  return "";
}

function renderMatchHeader(event) {
  const teamStats = event.markets
    .map(
      (market, i) => `
        <div class="team-stat">
          <span class="swatch" style="background:${TEAM_COLORS[i]}"></span>
          <span class="name">${market.team_name}</span>
          ${outcomeBadge(market.result)}
        </div>
      `
    )
    .join("");

  document.getElementById("match-header").innerHTML = `
    <h1>${event.title}</h1>
    <div class="match-id">${event.event_ticker}</div>
    <div id="match-start" class="match-start"></div>
    <div class="teams">${teamStats}</div>
  `;
}

function formatMatchStart(beginAt) {
  return new Date(beginAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadMatchStart(event) {
  const el = document.getElementById("match-start");
  el.textContent = "";
  try {
    const params = new URLSearchParams({ close_time: event.close_time });
    event.markets.forEach((m) => params.append("team", m.team_name));
    const { begin_at } = await fetchJson(`/api/match-start?${params}`);
    if (state.selectedTicker !== event.event_ticker) return; // user moved on
    el.textContent = begin_at ? `Match start: ${formatMatchStart(begin_at)}` : "";
    state.matchStartAt = begin_at;
    updateMatchStartLine();
  } catch {
    if (state.selectedTicker !== event.event_ticker) return;
    el.textContent = "";
  }
}

// Positions a vertical dotted line over the chart at the match's PandaScore
// begin_at. Runs on data load, resize, and pan/zoom (timeToCoordinate is a
// screen-space pixel offset, so it's stale after any of those).
function updateMatchStartLine() {
  const container = document.getElementById("chart-overlay");
  let line = document.getElementById("match-start-line");
  let label = document.getElementById("match-start-label");

  if (!state.chart || !state.matchStartAt) {
    line?.remove();
    label?.remove();
    return;
  }

  // timeToCoordinate only resolves times that exactly match a data point, so
  // interpolate linearly across the visible range's endpoints (which always
  // resolve, being real bar times) rather than querying the target directly.
  const timeScale = state.chart.timeScale();
  const time = Math.floor(new Date(state.matchStartAt).getTime() / 1000);
  const range = timeScale.getVisibleRange();
  if (!range || time < range.from || time > range.to) {
    line?.remove();
    label?.remove();
    return;
  }
  const x0 = timeScale.timeToCoordinate(range.from);
  const x1 = timeScale.timeToCoordinate(range.to);
  const x = x0 + ((time - range.from) / (range.to - range.from)) * (x1 - x0);

  if (!line) {
    line = document.createElement("div");
    line.id = "match-start-line";
    container.appendChild(line);
  }
  line.style.left = `${x}px`;

  if (!label) {
    label = document.createElement("div");
    label.id = "match-start-label";
    label.textContent = "Match Start";
    container.appendChild(label);
  }
  label.style.left = `${x}px`;
}

// Left edge of the default chart view: 30min before the match's PandaScore
// start when we found one, else 2h before the market settled. Clamped to
// the earliest candle so short-lived markets don't render mostly-empty.
function defaultZoomRange(event, candlesByMarket) {
  const allTimes = candlesByMarket.flat().map((c) => c.t);
  if (allTimes.length === 0) return null;
  const dataFrom = Math.min(...allTimes);
  const dataTo = Math.max(...allTimes);

  const from = state.matchStartAt
    ? Math.floor(new Date(state.matchStartAt).getTime() / 1000) - DEFAULT_ZOOM_MATCH_START_LEAD_SECONDS
    : Math.floor(new Date(event.close_time).getTime() / 1000) - DEFAULT_ZOOM_FALLBACK_WINDOW_SECONDS;

  return { from: Math.max(from, dataFrom), to: dataTo };
}

function midPriceSeries(candles) {
  return candles.map((c) => ({
    time: c.t,
    value: (c.yes_bid_close + c.yes_ask_close) / 2,
  }));
}

// Reference time for judging favorite vs. underdog: the match's actual
// PandaScore start when known, else 2h before the market closed (mirrors the
// chart's default-zoom fallback).
function oddsReferenceTime(event) {
  return state.matchStartAt
    ? Math.floor(new Date(state.matchStartAt).getTime() / 1000)
    : Math.floor(new Date(event.close_time).getTime() / 1000) - DEFAULT_ZOOM_FALLBACK_WINDOW_SECONDS;
}

// Mid price of the candle at or immediately before targetSeconds (candles
// are ordered ascending by time), falling back to the earliest candle if
// targetSeconds precedes all of them.
function priceAt(candles, targetSeconds) {
  if (candles.length === 0) return null;
  let chosen = candles[0];
  for (const c of candles) {
    if (c.t > targetSeconds) break;
    chosen = c;
  }
  return (chosen.yes_bid_close + chosen.yes_ask_close) / 2;
}

// Colors line series (and header swatches) by favorite/underdog rather than
// market order: whichever team has the higher win probability at match start
// (or 2h-before-close, if we never found a match start) is blue, the other
// orange. Falls back to the fixed palette when there aren't exactly two
// markets to compare, or the reference prices are missing/tied.
function pickTeamColors(event, candlesByMarket) {
  if (event.markets.length !== 2) return TEAM_COLORS;

  const refTime = oddsReferenceTime(event);
  const [priceA, priceB] = candlesByMarket.map((candles) => priceAt(candles, refTime));
  if (priceA == null || priceB == null || priceA === priceB) return TEAM_COLORS;

  return priceA > priceB ? [OVERDOG_COLOR, UNDERDOG_COLOR] : [UNDERDOG_COLOR, OVERDOG_COLOR];
}

function applyTeamSwatchColors(colors) {
  document.querySelectorAll("#match-header .team-stat .swatch").forEach((swatch, i) => {
    swatch.style.background = colors[i];
  });
}

// Combined volume across all of an event's markets, bucketed by candle time.
function totalVolumeSeries(candlesByMarket) {
  const totals = new Map();
  candlesByMarket.forEach((candles) => {
    candles.forEach((c) => totals.set(c.t, (totals.get(c.t) || 0) + c.volume));
  });
  return [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time, value }));
}

async function renderChart(event, matchStartPromise) {
  const chartEl = document.getElementById("chart");
  state.chart?.remove();
  state.chart = LightweightCharts.createChart(chartEl, {
    width: chartEl.clientWidth,
    height: chartEl.clientHeight,
    layout: { background: { color: "#161922" }, textColor: "#8b93a7" },
    grid: {
      vertLines: { color: "#262b38" },
      horzLines: { color: "#262b38" },
    },
    rightPriceScale: {
      scaleMargins: { top: 0.1, bottom: 0.3 },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
  });

  const candlesByMarket = await Promise.all(
    event.markets.map((market) => fetchJson(`/api/candles?ticker=${encodeURIComponent(market.ticker)}`))
  );

  await matchStartPromise; // resolves state.matchStartAt (or leaves it null)
  if (state.selectedTicker !== event.event_ticker) return; // user moved on

  const teamColors = pickTeamColors(event, candlesByMarket);
  applyTeamSwatchColors(teamColors);

  event.markets.forEach((market, i) => {
    const series = state.chart.addLineSeries({
      color: teamColors[i],
      lineWidth: 2,
      title: market.team_name,
    });
    series.setData(midPriceSeries(candlesByMarket[i]));
  });

  const volumeSeries = state.chart.addHistogramSeries({
    color: "#4f8cff",
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
  });
  state.chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  volumeSeries.setData(totalVolumeSeries(candlesByMarket));

  const zoom = defaultZoomRange(event, candlesByMarket);
  if (zoom) {
    state.chart.timeScale().setVisibleRange(zoom);
  } else {
    state.chart.timeScale().fitContent();
  }
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(updateMatchStartLine);
  updateMatchStartLine();
}

async function selectEvent(event) {
  state.selectedTicker = event.event_ticker;
  document.querySelectorAll(".suggestion-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.eventTicker === event.event_ticker);
  });

  document.getElementById("empty-state").hidden = true;
  document.getElementById("match-detail").hidden = false;

  state.matchStartAt = null;
  renderMatchHeader(event);
  const matchStartPromise = loadMatchStart(event);
  if (event.has_candles) {
    await renderChart(event, matchStartPromise);
  } else {
    state.chart?.remove();
    state.chart = null;
    document.getElementById("chart").innerHTML =
      '<div style="color: var(--text-dim); padding: 20px;">No candlestick data ingested for this match.</div>';
  }
}

function setSidebarWidth(width) {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  document.getElementById("explorer-root").style.setProperty("--sidebar-width", `${clamped}px`);
  localStorage.setItem("sidebarWidth", String(clamped));
}

function setSidebarCollapsed(collapsed) {
  document.getElementById("explorer-root").classList.toggle("sidebar-collapsed", collapsed);
  const toggle = document.getElementById("sidebar-toggle");
  toggle.textContent = collapsed ? "›" : "‹";
  toggle.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
  localStorage.setItem("sidebarCollapsed", String(collapsed));
}

function restoreSidebarState() {
  const storedWidth = Number(localStorage.getItem("sidebarWidth"));
  if (storedWidth) setSidebarWidth(storedWidth);
  setSidebarCollapsed(localStorage.getItem("sidebarCollapsed") === "true");
}

function setupSidebarToggle() {
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    const collapsed = !document.getElementById("explorer-root").classList.contains("sidebar-collapsed");
    setSidebarCollapsed(collapsed);
  });
}

function setupSidebarResize() {
  const app = document.getElementById("explorer-root");
  const handle = document.getElementById("sidebar-resize-handle");

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    app.classList.add("sidebar-resizing");
    handle.classList.add("dragging");

    const onMouseMove = (moveEvent) => setSidebarWidth(moveEvent.clientX);
    const onMouseUp = () => {
      app.classList.remove("sidebar-resizing");
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

function setupChartResize() {
  const chartEl = document.getElementById("chart");
  new ResizeObserver(() => {
    state.chart?.resize(chartEl.clientWidth, chartEl.clientHeight);
    updateMatchStartLine();
  }).observe(chartEl);
}

function setupKeyboardNav() {
  document.getElementById("explorer-search").addEventListener("keydown", (e) => {
    const rows = [...document.querySelectorAll(".suggestion-row")];
    if (rows.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.activeIndex = Math.min(state.activeIndex + 1, rows.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.activeIndex = Math.max(state.activeIndex - 1, 0);
    } else if (e.key === "Enter" && state.activeIndex >= 0) {
      rows[state.activeIndex].dispatchEvent(new MouseEvent("mousedown"));
      return;
    } else {
      return;
    }
    rows.forEach((row, i) => row.classList.toggle("active", i === state.activeIndex));
    rows[state.activeIndex].scrollIntoView({ block: "nearest" });
  });
}

function setupDateFilter() {
  document.getElementById("explorer-date-from").addEventListener("change", () => renderMarketList());
  document.getElementById("explorer-date-to").addEventListener("change", () => renderMarketList());
  document.querySelectorAll("#explorer-date-filter .date-presets button").forEach((button) => {
    button.addEventListener("click", () => applyDatePreset(button.dataset.preset));
  });
}

function setupLoadMore() {
  document.getElementById("load-more").addEventListener("click", () => {
    state.visibleCount += MARKETS_PAGE_SIZE;
    renderMarketList({ resetPaging: false });
  });
}

// Pre-match volume takes a slow full candle scan to compute server-side (see
// analysis/pre_match_volume.py), so it's fetched separately from /api/events
// and the filter stays disabled ("Loading…") until it arrives.
async function loadPreMatchVolume() {
  const preMatchVolumeByTicker = await fetchJson("/api/pre-match-volume");
  state.events.forEach((event) => {
    event.pre_match_volume = preMatchVolumeByTicker[event.event_ticker] ?? 0;
  });
  state.maxPreMatchVolume = Math.max(0, ...state.events.map((event) => event.pre_match_volume));
  state.preMatchVolumeFilter.setEnabled(true);
  renderMarketList({ resetPaging: false });
}

async function init() {
  state.events = await loadEvents();
  state.maxVolume = Math.max(0, ...state.events.map((event) => event.volume));

  state.totalVolumeFilter = createVolumeRangeFilter("total-volume", {
    getMaxVolume: () => state.maxVolume,
    onChange: () => renderMarketList(),
  });
  state.totalVolumeFilter.setEnabled(true);

  state.preMatchVolumeFilter = createVolumeRangeFilter("pre-match-volume", {
    getMaxVolume: () => state.maxPreMatchVolume,
    onChange: () => renderMarketList(),
  });
  state.preMatchVolumeFilter.setEnabled(false);

  renderMarketList();
  document.getElementById("explorer-search").addEventListener("input", () => renderMarketList());
  setupDateFilter();
  setupLoadMore();
  setupKeyboardNav();
  restoreSidebarState();
  setupSidebarToggle();
  setupSidebarResize();
  setupChartResize();
  loadPreMatchVolume();
}

init();
})();
