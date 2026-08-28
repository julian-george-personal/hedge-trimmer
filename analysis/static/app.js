const TEAM_COLORS = ["#4f8cff", "#e0a63f", "#3fbf7f", "#e0555a"];

const state = {
  events: [],
  activeIndex: -1,
  chart: null,
};

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

function eventMatchesQuery(event, query) {
  const haystack = `${event.title} ${event.event_ticker}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderSuggestions(matches) {
  const container = document.getElementById("suggestions");
  container.innerHTML = "";
  container.hidden = matches.length === 0;
  state.activeIndex = -1;

  matches.forEach((event) => {
    const row = document.createElement("div");
    row.className = "suggestion-row" + (event.has_candles ? "" : " no-candles");
    row.innerHTML = `
      <div class="title">${event.title}</div>
      <div class="meta">
        <span>${event.event_ticker}</span>
        <span>close: ${event.close_time}</span>
      </div>
    `;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectEvent(event);
    });
    container.appendChild(row);
  });
}

function handleSearchInput() {
  const query = document.getElementById("search").value.trim();
  if (!query) {
    renderSuggestions([]);
    return;
  }
  const matches = state.events.filter((event) => eventMatchesQuery(event, query)).slice(0, 20);
  renderSuggestions(matches);
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
    <div class="teams">${teamStats}</div>
  `;
}

function midPriceSeries(candles) {
  return candles.map((c) => ({
    time: c.t,
    value: (c.yes_bid_close + c.yes_ask_close) / 2,
  }));
}

async function renderChart(event) {
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
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
  });

  const candlesByMarket = await Promise.all(
    event.markets.map((market) => fetchJson(`/api/candles?ticker=${encodeURIComponent(market.ticker)}`))
  );

  event.markets.forEach((market, i) => {
    const series = state.chart.addLineSeries({
      color: TEAM_COLORS[i],
      lineWidth: 2,
      title: market.team_name,
    });
    series.setData(midPriceSeries(candlesByMarket[i]));
  });

  state.chart.timeScale().fitContent();
}

async function selectEvent(event) {
  document.getElementById("search").value = event.title;
  renderSuggestions([]);
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
  });
}

async function init() {
  state.events = await fetchJson("/api/events");
  document.getElementById("search").addEventListener("input", handleSearchInput);
  document.getElementById("search").addEventListener("blur", () => {
    setTimeout(() => renderSuggestions([]), 100);
  });
  setupKeyboardNav();
}

init();
