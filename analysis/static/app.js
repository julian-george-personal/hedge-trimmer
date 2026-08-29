// Client-side router between the explorer and analysis views. Both views'
// DOM/JS state lives in this one document permanently — switching just
// toggles visibility, it never navigates, so nothing is torn down or
// refetched. explorer.html/analysis.html stay real URLs (server.py maps
// both to this page) purely so links/bookmarks/reloads land on the right
// view.
const VIEWS = ["explorer", "analysis"];

function viewFromPath(path) {
  return path === "/analysis.html" ? "analysis" : "explorer";
}

function showView(view, { pushState = true } = {}) {
  VIEWS.forEach((v) => {
    document.getElementById(`${v}-view`).hidden = v !== view;
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === view);
  });
  document.title = `hedge trimmer — ${view}`;

  const path = `/${view}.html`;
  if (pushState && location.pathname !== path) history.pushState({ view }, "", path);
}

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    showView(link.dataset.view);
  });
});

window.addEventListener("popstate", () => showView(viewFromPath(location.pathname), { pushState: false }));

showView(viewFromPath(location.pathname), { pushState: false });
