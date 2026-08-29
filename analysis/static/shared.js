async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

// Memoized so explorer and analysis share one /api/events fetch — switching
// views never re-requests it.
let eventsPromise = null;

function loadEvents() {
  if (!eventsPromise) eventsPromise = fetchJson("/api/events");
  return eventsPromise;
}
