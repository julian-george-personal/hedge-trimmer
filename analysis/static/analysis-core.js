// Shared analysis-view infrastructure: sidebar state/filters, the widget
// grid's drag-to-reorder/persistence, and generic formatters. Loaded as a
// plain (non-IIFE) script, like shared.js, because widget-*.js files need
// direct access to these names — only widget-internal helpers get IIFE
// privacy (see widget-optimizer.js).
//
// To add a widget: create widget-<name>.js (IIFE-wrapped) that builds a
// widget element and calls registerWidget(() => buildYourWidget()) at load
// time, add its <script> (and any widget-<name>.css <link>) to index.html
// before app.js, and add its win/HTML5 template to the widget's own file —
// nothing here needs to change.
//
// To delete a widget: remove its widget-<name>.js/.css files and their
// <script>/<link> tags from index.html. Nothing in this file references
// any specific widget, so there's nothing else to hunt down.

const state = {
  events: [],
  statsByTicker: new Map(),
  statsLoaded: false,
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

function formatDollars(amount) {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(amount)).toLocaleString()}`;
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

// The sidebar's current filter inputs, read together so a caller that needs
// to both filter events and (e.g.) label a result with what produced it only
// has to read the DOM once.
function currentSidebarFilters() {
  return {
    query: document.getElementById("analysis-search").value.trim(),
    dateRange: currentDateRange(),
    // PandaScore match-start matching only exists for Kalshi events — forced
    // off for Polymarket regardless of the (CSS-hidden) checkbox state, so it
    // can't zero out every Polymarket event via a never-populated stat.
    onlyPandascoreStart: getDataSource() === "kalshi" && document.getElementById("only-pandascore-start").checked,
  };
}

function sidebarFilteredEvents() {
  const { query, dateRange, onlyPandascoreStart } = currentSidebarFilters();

  return state.events.filter(
    (event) =>
      (!query || eventMatchesQuery(event, query)) &&
      eventInDateRange(event, dateRange) &&
      (!onlyPandascoreStart || eventHasPandascoreStart(event))
  );
}

// Pairs each event with its price-spike stat (dropped when there is none),
// so a widget can filter by either an event-level field (e.g. total volume)
// or a stat-level field (e.g. volume before match start) without losing the
// correspondence between the two.
function eventStatPairs(events) {
  return events
    .map((event) => ({ event, stat: state.statsByTicker.get(event.event_ticker) }))
    .filter((pair) => pair.stat);
}

function updateFilterSummary(matched) {
  document.getElementById("filter-summary").textContent = `${matched} of ${state.events.length} matches match filters`;
}

// Widgets register a zero-arg builder (returning their root element) here at
// script-load time; initAnalysis() appends them in registration order. This
// is the only place a widget's existence is referenced outside its own file.
const widgetBuilders = [];

function registerWidget(build) {
  widgetBuilders.push(build);
}

// Re-runs the sidebar-filter-dependent parts of the page. Widgets that only
// recompute on an explicit user action (e.g. a "run" button) don't need to
// hook in here at all.
function renderAll() {
  updateFilterSummary(sidebarFilteredEvents().length);
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
  renderAll();
}

async function initAnalysis() {
  setupDataSourceToggle("analysis-data-source");
  const widgets = document.getElementById("widgets");
  widgetBuilders.forEach((build) => widgets.appendChild(build()));
  applyWidgetOrder(widgets, loadWidgetOrder());
  setupWidgetDragAndDrop(widgets);
  setupFilters();

  state.events = await loadEvents();
  renderAll();

  // Price-spike stats need bid/ask history, which only Kalshi has — leave
  // statsByTicker empty and statsLoaded true so widgets relying on it (e.g.
  // the optimizer) render their normal "no data" state instead of hanging
  // on "loading" forever.
  if (getDataSource() === "kalshi") {
    loadPriceSpikeStats();
  } else {
    state.statsLoaded = true;
  }
}

// Deferred (rather than called immediately, like explorer.js's init()) so
// every widget-*.js file placed after this one in index.html has already
// run registerWidget() by the time this fires — DOMContentLoaded only fires
// once the whole document, including all preceding <script> tags, has
// finished executing.
document.addEventListener("DOMContentLoaded", initAnalysis);
