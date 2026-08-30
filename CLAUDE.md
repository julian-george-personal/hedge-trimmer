# hedge-trimmer

## Running the app

```
source ingestion/.venv/bin/activate
python -m analysis.server
```

Serves on `http://127.0.0.1:8420`. Binding the socket requires the sandbox
disabled (`dangerouslyDisableSandbox: true` on the Bash tool) — a plain
sandboxed run fails with `PermissionError: [Errno 1] Operation not permitted`
on `socket.bind`.

Start it in the background and poll instead of guessing a sleep:

```bash
# (Bash tool: run_in_background: true, dangerouslyDisableSandbox: true)
source ingestion/.venv/bin/activate && python -m analysis.server
```

```bash
until curl -sf http://127.0.0.1:8420 >/dev/null; do sleep 1; done
```

`Address already in use` on relaunch means a prior instance is still up —
find and kill it first: `lsof -ti:8420 -sTCP:LISTEN | xargs -r kill`.

If the server was already running before you started testing (e.g. the user
had it up), leave it running when you're done: if you had to kill/restart it
during testing, restart it afterward so it ends up back in the state you
found it.

## Driving it with Playwright

`chromium-cli` is not installed in this environment. Instead, `playwright`
is installed globally (`npm install -g playwright`, with the Chromium
binary via `playwright install chromium`) — it is not a project dependency,
so don't `npm install` it into the repo or scratchpad.

Node's ESM loader ignores `NODE_PATH`, so a plain `import "playwright"` in
an `.mjs` file won't find the global install. Use CommonJS `require`
instead, with `NODE_PATH` set to the global node_modules dir:

```bash
NODE_PATH=$(npm root -g) node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:8420/explorer.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#empty-state');
  await page.screenshot({ path: 'out.png' });
  await browser.close();
})();
"
```

For a longer script, write it to a `.js` (not `.mjs`) file in the
scratchpad and run it the same way: `NODE_PATH=$(npm root -g) node
script.js`.

Run these `node`/`npx`/`playwright` commands and the app itself with
`dangerouslyDisableSandbox: true` — network access and the browser download
are blocked otherwise.

## Viewing autotrader logs and DynamoDB table

The autotrader runs on AWS App Runner (service name `hedge-trimmer-autotrader`,
provisioned in the `personal-terraform` repo). These are read-only lookups —
never modify these resources directly; changes go through Terraform (see
global CLAUDE.md).

Logs (App Runner writes to CloudWatch Logs under a per-service log group):

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/apprunner/hedge-trimmer-autotrader
# pick the "...service" or "...application" group from the output, then:
aws logs tail /aws/apprunner/hedge-trimmer-autotrader/<service-id>/application --follow
```

DynamoDB table (name `hedge-trimmer-autotrader`, single-table design with a
`PK`/`SK` key schema):

```bash
# current trading config
aws dynamodb get-item --table-name hedge-trimmer-autotrader \
  --key '{"PK": {"S": "CONFIG"}, "SK": {"S": "CONFIG"}}'

# a specific position (event ticker required)
aws dynamodb get-item --table-name hedge-trimmer-autotrader \
  --key '{"PK": {"S": "POSITION#<event_ticker>"}, "SK": {"S": "POSITION"}}'

# full table dump (positions + market scans + config)
aws dynamodb scan --table-name hedge-trimmer-autotrader
```

Item shapes: `PK=CONFIG, SK=CONFIG` (trading config), `PK=POSITION#<event_ticker>, SK=POSITION`
(open/closed position), `PK=SCAN#<event_ticker>, SK=<scanned_at>` (market scan history).
See `autotrader/storage/state.py` for the exact key helpers.

## Frontend structure

Static UI lives in `analysis/static/`, served by `analysis/server.py`. No
build step — edit and reload. It's a single-page app: `index.html` is the
only document, containing both views' markup permanently mounted as
`#explorer-view` and `#analysis-view`. `app.js` toggles which one is visible
(via `hidden`) when a nav link is clicked — it never navigates — so
switching views keeps all JS state (selected match, chart, filters, widget
order) alive and never re-triggers a fetch. `server.py` still serves
`/explorer.html` and `/analysis.html` as real routes (both return
`index.html`'s bytes) purely so bookmarks/reloads land on the right view;
`app.js` reads `location.pathname` on load to pick the initial view and
uses `history.pushState`/`popstate` to keep the URL in sync with nav clicks.

Files:
- `shared.js` — `fetchJson` plus `loadEvents()`, a memoized `/api/events`
  fetch shared by both views so it only ever runs once per page load.
- `explorer.js` / `explorer.css` — the match explorer (sidebar list +
  chart). `explorer.js`'s body is wrapped in an IIFE.
- `analysis.js` / `analysis.css` — ad hoc analysis widgets. Also
  IIFE-wrapped.
- `base.css` — CSS vars, body reset, top nav bar, and the `.view`/
  `.view[hidden]` rules that drive the view toggle (`.view` is `display:
  contents` so the visible one's child participates directly in
  `.page-body`'s flex layout).

`explorer.js` and `analysis.js` both load in the same document now (as
plain scripts, not modules), so any top-level `const`/`function` name used
in both would collide — that's why each is IIFE-wrapped rather than
deduplicated. They already duplicate several identically-named helpers
(`state`, `formatVolume`, `sliderPositionToVolume`, `currentDateRange`,
`applyDatePreset`, etc, some flagged by comments) — that duplication is
intentional/existing, not something to clean up as a side effect of an
unrelated change.

Both views also had colliding element ids from when they were separate
documents (`app`, `sidebar`, `search`, `search-bar`, `date-filter`,
`date-from`, `date-to`). These are namespaced per view now — `explorer-*`
prefix in explorer's markup/JS/CSS, `analysis-*` in analysis's — since HTML
ids must be unique within one document. IDs that were already unique to one
view (e.g. `chart`, `widgets`, `only-pandascore-start`) were left alone.

Watch out for the `hidden` attribute: `explorer.js` toggles it via the
`.hidden` IDL property (e.g. `el.hidden = true`), which relies on the
low-specificity UA rule `[hidden] { display: none }`. Any `#id { display:
... }` rule in `explorer.css` for that same element will silently win over
it and keep the element (and its layout footprint) visible. If adding
`display` rules for an element that also gets toggled via `.hidden`, pair it
with an explicit `#id[hidden] { display: none; }` override — `base.css`'s
`.view[hidden]` rule is exactly this pattern, one level up.
