# MaxLoad Desktop (Electron) — standalone prototype

Runs the **exact same MaxLoad codebase** (the Chrome-extension content scripts,
engines, and panel UI) as a standalone desktop app — no Chrome, no extension
install. The extension's `chrome.*` calls are satisfied by a small compatibility
shim, so **none of the engine/panel code is forked or copied** — this folder only
adds the Electron shell around it.

## How login works (important)

**We do NOT automate or store your Maximo login.** The app embeds a real
Chromium view. You type your Maximo URL and **log in manually** — password, SSO,
or MFA all work exactly as in a normal browser. The session cookie is persisted
in a named partition (`persist:maximo`), so you normally sign in once and stay
logged in until Maximo's own timeout. MaxLoad only ever acts on that live,
already-authenticated session — same assumption the extension made about your
open Maximo tab.

## Run it

```bash
cd desktop
npm install      # first time only (downloads Electron)
npm start
```

Then:
1. Type your Maximo URL in the address bar → **Enter**.
2. Log in normally.
3. The **MaxLoad panel** is docked on the right — Teach / Bind / Run as usual.
   Toggle it with the **Panel** button.

The panel's DevTools opens automatically in this prototype so you can see logs
and any errors. To stop that, unset the block in `main.js`
(`panelWC().openDevTools`).

## Architecture (what maps to what)

| Extension | Desktop equivalent | File |
|---|---|---|
| `background/service-worker.js` | Electron main process (storage, AI proxy, log ring, message router) | `main.js` |
| `chrome.debugger` (CDP trusted input) | `webContents.debugger` — same DevTools Protocol calls | `main.js` (cdp* fns) |
| `chrome.storage.local` | JSON file in `userData` | `main.js` (`store`) |
| `chrome.runtime` / `chrome.tabs` / `chrome.storage` | compatibility shim injected into MAIN world | `shim/chrome-shim.js` |
| content-script injection (`all_frames`) | `webContents.executeJavaScript` on every load | `main.js` (`injectContentScripts`) |
| in-page panel iframe (`panel-inject.js`) | a docked `BrowserView` loading `ui/panel.html` | `main.js` |
| toolbar action | shell address bar + Panel toggle | `shell.html` |

The content scripts, engines, `ui/panel.*`, and `rules/*` are loaded **from the
parent repo unchanged** (`..`), so edits to the engine apply to both the
extension and this app.

## Verified working (headless smoke test: `MAXLOAD_SMOKE=1 npm start`)

- App boots; `maxload://` protocol + `loadFile` serve the UI.
- Content scripts inject into the Maximo view (`window.MaxLoad` engine present).
- `chrome` shim present in **both** the Maximo view and the panel.
- Full command round-trip: panel → main → frame-bridge `ml:cmd:ping` → response.

## Known limitations / next steps (prototype)

- **Sub-frame injection.** Content scripts are injected into the **main frame**
  only. The DOM analyzer already recurses same-origin iframes from the top frame
  (so most Maximo forms are reachable), but the always-on error-watcher does not
  yet run inside each child frame. Next step: iterate `webContents.mainFrame.frames`
  and inject per-frame.
- **Isolated world.** Scripts run in the page's MAIN world (not a separate
  isolated world as in the extension). Low collision risk with Maximo/Dojo, but
  worth hardening.
- **CDP + DevTools conflict.** Only one debugger can attach per view. The auto-
  opened panel DevTools is fine (different view), but opening DevTools on the
  **Maximo** view will block CDP trusted input.
- **Security / distribution (not done here):** code signing, auto-update, and
  moving the AI key + license check server-side. See the standalone discussion.
- **Cert handling** is permissive (accepts self-signed) for prototype ease —
  tighten before shipping.
