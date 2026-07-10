/* MaxLoad — auth gate (Firebase Authentication, REST — no SDK, no cloud functions).
 *
 * Login-only email/password. Accounts are created by an admin in the Firebase
 * console (public sign-up is disabled), so a successful login == authorization.
 * Tokens live in chrome.storage.local (works in the extension AND the desktop app's
 * chrome shim). The idToken isn't sent anywhere today — the gate is simply "do we
 * hold a valid, refreshable session for a real account".
 *
 * Honest scope: this gates the UI and is enforced by Firebase for real (only valid
 * accounts get a token). It does NOT cryptographically stop a technical user from
 * editing the LOCAL extension code — that would need a server dependency (ruled out
 * with "no cloud functions"). For access control + a login wall, this is standard.
 */
(function () {
  "use strict";
  const CFG = window.MAXLOAD_FIREBASE || {};
  const KEY = "ml:auth";
  const IDP = "https://identitytoolkit.googleapis.com/v1";
  const STS = "https://securetoken.googleapis.com/v1";

  function isConfigured() {
    return !!CFG.apiKey && CFG.apiKey.indexOf("PASTE_") !== 0;
  }

  async function load() {
    try { return (await chrome.storage.local.get(KEY))[KEY] || null; } catch (_) { return null; }
  }
  async function save(s) { try { await chrome.storage.local.set({ [KEY]: s }); } catch (_) {} }
  async function clear() { try { await chrome.storage.local.remove(KEY); } catch (_) {} }

  async function signIn(email, password) {
    if (!isConfigured()) throw new Error("Firebase isn't configured yet (see ui/firebase-config.js).");
    const res = await fetch(`${IDP}/accounts:signInWithPassword?key=${CFG.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim(), password: password, returnSecureToken: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(mapErr(data));
    const sess = {
      uid: data.localId,
      email: data.email,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000
    };
    await save(sess);
    return sess;
  }

  async function refresh(sess) {
    const res = await fetch(`${STS}/token?key=${CFG.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(sess.refreshToken)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("session expired");
    const next = {
      ...sess,
      idToken: data.id_token || sess.idToken,
      refreshToken: data.refresh_token || sess.refreshToken,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
    };
    await save(next);
    return next;
  }

  /** The current authorized session (refreshing if near expiry), or null. */
  async function currentUser() {
    if (!isConfigured()) return null;
    const sess = await load();
    if (!sess || !sess.refreshToken) return null;
    if (Date.now() < sess.expiresAt - 60000) return sess; // still valid (60s skew)
    try { return await refresh(sess); } catch (_) { await clear(); return null; }
  }

  async function signOut() { await clear(); }

  async function resetPassword(email) {
    if (!isConfigured()) throw new Error("Firebase isn't configured yet.");
    const res = await fetch(`${IDP}/accounts:sendOobCode?key=${CFG.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestType: "PASSWORD_RESET", email: String(email || "").trim() })
    });
    if (!res.ok) throw new Error(mapErr(await res.json().catch(() => ({}))));
    return true;
  }

  function mapErr(data) {
    const m = (data && data.error && data.error.message) || "SIGN_IN_FAILED";
    if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS/i.test(m)) return "Wrong email or password.";
    if (/USER_DISABLED/i.test(m)) return "This account has been disabled.";
    if (/TOO_MANY_ATTEMPTS/i.test(m)) return "Too many attempts — please wait and try again.";
    if (/MISSING_PASSWORD|INVALID_EMAIL|MISSING_EMAIL/i.test(m)) return "Enter a valid email and password.";
    if (/OPERATION_NOT_ALLOWED/i.test(m)) return "Email/password sign-in isn't enabled in Firebase.";
    return m.replace(/_/g, " ").toLowerCase();
  }

  window.MaxLoadAuth = { isConfigured, signIn, signOut, currentUser, resetPassword };
})();
