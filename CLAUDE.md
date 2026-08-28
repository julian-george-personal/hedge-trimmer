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
  await page.goto('http://127.0.0.1:8420', { waitUntil: 'networkidle' });
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

## Frontend structure

Static UI lives in `analysis/static/` (`index.html`, `app.js`, `style.css`),
served by `analysis/server.py`. No build step — edit and reload.

Watch out for the `hidden` attribute: `app.js` toggles it via the `.hidden`
IDL property (e.g. `el.hidden = true`), which relies on the low-specificity
UA rule `[hidden] { display: none }`. Any `#id { display: ... }` rule in
`style.css` for that same element will silently win over it and keep the
element (and its layout footprint) visible. If adding `display` rules for an
element that also gets toggled via `.hidden`, pair it with an explicit
`#id[hidden] { display: none; }` override.
