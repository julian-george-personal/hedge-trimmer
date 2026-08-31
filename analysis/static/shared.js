async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

const DATA_SOURCE_STORAGE_KEY = "dataSource";

function getDataSource() {
  return localStorage.getItem(DATA_SOURCE_STORAGE_KEY) || "kalshi";
}

// Switching source reloads the page rather than trying to reset explorer.js's
// and analysis-core.js's independent state in place (selected match, chart,
// cached stats, filter ranges) — both views already read getDataSource() at
// init time, so a reload is simpler and more robust than reactive resets in
// two separately-scoped views (see CLAUDE.md on their intentional duplication).
function setDataSource(source) {
  if (source === getDataSource()) return;
  localStorage.setItem(DATA_SOURCE_STORAGE_KEY, source);
  location.reload();
}

// Wires the data-source toggle buttons inside one sidebar (explorer's and
// analysis's each have their own, per CLAUDE.md's per-view id namespacing).
function setupDataSourceToggle(containerId) {
  const container = document.getElementById(containerId);
  const current = getDataSource();
  container.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.source === current);
    button.addEventListener("click", () => setDataSource(button.dataset.source));
  });
}

document.body.dataset.source = getDataSource();

// Memoized per source so explorer and analysis share one /api/events fetch
// for the current source — switching views never re-requests it (switching
// source does, via setDataSource's reload).
const eventsPromiseBySource = new Map();

function loadEvents() {
  const source = getDataSource();
  if (!eventsPromiseBySource.has(source)) {
    eventsPromiseBySource.set(source, fetchJson(`/api/events?source=${source}`));
  }
  return eventsPromiseBySource.get(source);
}
