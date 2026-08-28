const TEAM_COLORS = ["#4f8cff", "#e0a63f", "#3fbf7f", "#e0555a"];

const VOLUME_SLIDER_STEPS = 1000;

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 560;

// How many matches the sidebar renders at once; "Load more" reveals the next page.
const MARKETS_PAGE_SIZE = 25;

const state = {
  events: [],
  activeIndex: -1,
  selectedTicker: null,
  chart: null,
  maxVolume: 0,
  visibleCount: MARKETS_PAGE_SIZE,
};

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

function eventMatchesQuery(event, query) {
  const haystack = `${event.title} ${event.event_ticker}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function formatVolume(volume) {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return String(Math.round(volume));
}

// Logarithmic mapping so the slider gives fine control over the (heavily
// right-skewed) low end of the volume distribution, not just the top end.
function sliderPositionToVolume(position) {
  if (position <= 0 || state.maxVolume <= 0) return 0;
  return Math.pow(state.maxVolume, position / VOLUME_SLIDER_STEPS);
}

function currentMinVolume() {
  const position = Number(document.getElementById("min-volume").value);
  return sliderPositionToVolume(position);
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
  const query = document.getElementById("search").value.trim();
  const minVolume = currentMinVolume();
  const dateRange = currentDateRange();
  updateMinVolumeLabel();
  const container = document.getElementById("market-list");
  container.innerHTML = "";
  state.activeIndex = -1;
  if (resetPaging) state.visibleCount = MARKETS_PAGE_SIZE;

  const matches = state.events.filter(
    (event) =>
      (!query || eventMatchesQuery(event, query)) &&
      event.volume >= minVolume &&
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

  const matchStart = event.match_start
    ? `<div class="match-start">Match start: ${formatDateLabel(event.match_start)} ${new Date(event.match_start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>`
    : "";

  document.getElementById("match-header").innerHTML = `
    <h1>${event.title}</h1>
    <div class="match-id">${event.event_ticker}</div>
    ${matchStart}
    <div class="teams">${teamStats}</div>
  `;
}

function midPriceSeries(candles) {
  return candles.map((c) => ({
    time: c.t,
    value: (c.yes_bid_close + c.yes_ask_close) / 2,
  }));
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

function setupMatchStartLine(chartEl, timeSec) {
  const lineEl = document.createElement("div");
  lineEl.className = "match-start-line";
  chartEl.appendChild(lineEl);
  state.matchStartLineEl = lineEl;

  const update = () => {
    const x = state.chart?.timeScale().timeToCoordinate(timeSec);
    lineEl.style.display = x == null ? "none" : "block";
    if (x != null) lineEl.style.left = `${x}px`;
  };
  state.updateMatchStartLine = update;
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(update);
  update();
}

async function renderChart(event) {
  const chartEl = document.getElementById("chart");
  state.chart?.remove();
  state.matchStartLineEl?.remove();
  state.matchStartLineEl = null;
  state.updateMatchStartLine = null;
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

  const matchStartTs = event.match_start ? Date.parse(event.match_start) / 1000 : null;

  event.markets.forEach((market, i) => {
    const series = state.chart.addLineSeries({
      color: TEAM_COLORS[i],
      lineWidth: 2,
      title: market.team_name,
    });
    series.setData(midPriceSeries(candlesByMarket[i]));
  });

  const firstMarketCandles = candlesByMarket[0] || [];
  if (matchStartTs !== null && firstMarketCandles.length > 0) {
    const closestTs = firstMarketCandles.reduce((closest, c) =>
      Math.abs(c.t - matchStartTs) < Math.abs(closest - matchStartTs) ? c.t : closest
    , firstMarketCandles[0].t);
    setupMatchStartLine(chartEl, closestTs);
  }

  const volumeSeries = state.chart.addHistogramSeries({
    color: "#4f8cff",
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
  });
  state.chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  volumeSeries.setData(totalVolumeSeries(candlesByMarket));

  state.chart.timeScale().fitContent();
}

async function selectEvent(event) {
  state.selectedTicker = event.event_ticker;
  document.querySelectorAll(".suggestion-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.eventTicker === event.event_ticker);
  });

  document.getElementById("empty-state").hidden = true;
  document.getElementById("match-detail").hidden = false;

  renderMatchHeader(event);
  if (event.has_candles) {
    await renderChart(event);
  } else {
    document.getElementById("chart").innerHTML =
      '<div style="color: var(--text-dim); padding: 20px;">No candlestick data ingested for this match.</div>';
  }
}

function setSidebarWidth(width) {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  document.getElementById("app").style.setProperty("--sidebar-width", `${clamped}px`);
  localStorage.setItem("sidebarWidth", String(clamped));
}

function setSidebarCollapsed(collapsed) {
  document.getElementById("app").classList.toggle("sidebar-collapsed", collapsed);
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
    const collapsed = !document.getElementById("app").classList.contains("sidebar-collapsed");
    setSidebarCollapsed(collapsed);
  });
}

function setupSidebarResize() {
  const app = document.getElementById("app");
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
    state.updateMatchStartLine?.();
  }).observe(chartEl);
}

function setupKeyboardNav() {
  document.getElementById("search").addEventListener("keydown", (e) => {
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
  document.getElementById("date-from").addEventListener("change", () => renderMarketList());
  document.getElementById("date-to").addEventListener("change", () => renderMarketList());
  document.querySelectorAll(".date-presets button").forEach((button) => {
    button.addEventListener("click", () => applyDatePreset(button.dataset.preset));
  });
}

function setupLoadMore() {
  document.getElementById("load-more").addEventListener("click", () => {
    state.visibleCount += MARKETS_PAGE_SIZE;
    renderMarketList({ resetPaging: false });
  });
}

async function init() {
  state.events = await fetchJson("/api/events");
  state.maxVolume = Math.max(0, ...state.events.map((event) => event.volume));
  renderMarketList();
  document.getElementById("search").addEventListener("input", () => renderMarketList());
  document.getElementById("min-volume").addEventListener("input", () => renderMarketList());
  setupDateFilter();
  setupLoadMore();
  setupKeyboardNav();
  restoreSidebarState();
  setupSidebarToggle();
  setupSidebarResize();
  setupChartResize();
}

init();
