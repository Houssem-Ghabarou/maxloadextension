/* MaxLoad Desktop — preload (runs in every view: shell, Maximo, panel, editor).
 *
 * Two jobs:
 *   1. Expose a minimal, serializable IPC bridge to the MAIN world so the chrome
 *      shim can talk to the main process (window.__maxload).
 *   2. Expose the shell control bridge (window.__shell) for the address bar.
 *   3. Install the chrome.* shim into the MAIN world BEFORE page scripts run, so
 *      panel.js / content scripts see `chrome` immediately.
 *
 * contextIsolation stays ON (secure); we bridge across with contextBridge and
 * seed the MAIN-world shim with webFrame.executeJavaScript.
 */
const { contextBridge, ipcRenderer, webFrame } = require("electron");
const fs = require("fs");
const path = require("path");

const roleArg = process.argv.find((a) => a.startsWith("--maxload-role="));
const role = roleArg ? roleArg.split("=")[1] : "unknown";

// ---- IPC bridge for the chrome shim ----------------------------------------
contextBridge.exposeInMainWorld("__maxload", {
  role: role,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: (channel, cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

// ---- shell control bridge (only meaningful in the shell window) -------------
contextBridge.exposeInMainWorld("__shell", {
  navigate: (url) => ipcRenderer.send("shell:navigate", url),
  back: () => ipcRenderer.send("shell:back"),
  forward: () => ipcRenderer.send("shell:forward"),
  reload: () => ipcRenderer.send("shell:reload"),
  togglePanel: () => ipcRenderer.send("shell:toggle-panel"),
  onStatus: (cb) => ipcRenderer.on("shell:status", (_e, p) => cb(p))
});

// ---- seed the chrome shim into MAIN world, before page scripts --------------
try {
  const shimSrc = fs.readFileSync(path.join(__dirname, "shim", "chrome-shim.js"), "utf8");
  webFrame.executeJavaScript(shimSrc);
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[MaxLoad preload] failed to inject chrome shim:", e);
}
