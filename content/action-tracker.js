/* MaxLoad — action-channel tracker (MAIN world).
 *
 * Counts in-flight Maximo action requests (the webclient's async XHR/fetch to
 * /ui/maximo.jsp, /webclient/…, servlet polls) and PUBLISHES the live count plus
 * a last-activity timestamp onto the <html> element's data-attributes. The
 * isolated-world settle detector reads those (MAIN + isolated worlds share the
 * same DOM per frame) so it can wait on Maximo's REAL round-trips — event-driven,
 * like iAMXLS's whenIdle — instead of guessing a fixed timeout.
 *
 * Purely observational: it wraps XHR.send / fetch to count, never blocks or
 * alters the request. Runs in every frame; each frame tracks its own document.
 * Kept independent of the native status bridge (maximo-native.js) on purpose.
 */
(function () {
  "use strict";
  if (window.__MAXLOAD_ACTRACK__) return;
  window.__MAXLOAD_ACTRACK__ = true;

  var inflight = 0;
  var root = document.documentElement;

  // Maximo's action channel: webclient async POSTs (…/ui/maximo.jsp), the servlet
  // endpoints, OSLC, and *.jsp polls. Over-counting is harmless (settle just waits
  // a touch longer), so we match broadly rather than risk missing a round-trip.
  var RE = /\/ui\/|maximo\.jsp|\/webclient\/|\/oslc\/|servlet|async|\.jsp(\?|$)/i;

  function publish() {
    try {
      if (!root) root = document.documentElement;
      root.setAttribute("data-ml-inflight", String(inflight));
      root.setAttribute("data-ml-lastaction", String(Date.now()));
    } catch (e) {}
  }
  function match(url) {
    try { return RE.test(String(url || "")); } catch (e) { return true; }
  }
  function inc(url) { if (!match(url)) return false; inflight++; publish(); return true; }
  function dec() { inflight = inflight > 0 ? inflight - 1 : 0; publish(); }

  publish();

  // ---- XMLHttpRequest (Maximo's primary channel) ----------------------------
  try {
    var XO = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XO && XO.open && XO.send) {
      var _open = XO.open;
      var _send = XO.send;
      XO.open = function (method, url) {
        try { this.__mlUrl = url; } catch (e) {}
        return _open.apply(this, arguments);
      };
      XO.send = function () {
        var self = this;
        if (inc(self.__mlUrl)) {
          var settled = false;
          var done = function () { if (settled) return; settled = true; dec(); };
          try { self.addEventListener("loadend", done); } catch (e) {}
          // belt-and-suspenders: loadend covers success/error/abort, readystate 4
          // catches XHRs whose loadend a page shim may have suppressed.
          try {
            self.addEventListener("readystatechange", function () {
              if (self.readyState === 4) done();
            });
          } catch (e) {}
        }
        return _send.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ---- fetch (some MAS builds use it) ---------------------------------------
  try {
    if (typeof window.fetch === "function") {
      var _fetch = window.fetch;
      window.fetch = function (input) {
        var url = (input && typeof input === "object" && input.url) || input;
        if (!inc(url)) return _fetch.apply(this, arguments);
        var p = _fetch.apply(this, arguments);
        return p.then(
          function (r) { dec(); return r; },
          function (e) { dec(); throw e; }
        );
      };
    }
  } catch (e) {}
})();
