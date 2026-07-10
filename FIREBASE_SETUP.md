# MaxLoad — Firebase login gate (setup)

Email/password login only. Accounts are **created by you** in the Firebase console
(public sign-up stays disabled), so *having an account = being authorized*. No cloud
functions, no app data in Firestore.

> **Until you paste a real API key, the gate is OFF** and the app works as before —
> so you can set this up without breaking anything.

## 1. Create the Firebase project + Web app
1. https://console.firebase.google.com → **Add project**.
2. In the project, **Project settings → Your apps → Web (`</>`)** → register an app.
3. Copy the **`apiKey`** and **`projectId`** from the shown config.

## 2. Paste the config
Open [`ui/firebase-config.js`](ui/firebase-config.js) and set:
```js
window.MAXLOAD_FIREBASE = {
  apiKey: "AIza…your-key…",
  projectId: "your-project-id"
};
```
(The Web API key is a **public identifier, not a secret** — committing it is expected.
Access is controlled by Auth + disabled sign-up below, not by hiding it.)

## 3. Turn on Email/Password, turn OFF sign-up
1. **Authentication → Get started → Sign-in method → Email/Password → Enable** (leave
   "Email link" off).
2. **Authentication → Settings → User actions → uncheck "Enable create (sign-up)"**.
   This stops anyone from self-registering via the API key. Only accounts you add work.

## 4. Add your users
**Authentication → Users → Add user** — enter each person's email + a temporary
password. They can change it later via **Forgot password?** on the login screen.

## 5. (Optional) Lock Firestore
If Firestore is enabled on the project, publish [`firestore.rules`](firestore.rules)
(deny-all) so nothing can be read/written — MaxLoad stores no data there.
```
firebase deploy --only firestore:rules      # or paste the rules in the console
```

## 6. Reload
Reload the unpacked extension (and restart the desktop app). You'll get a **Sign in**
screen; use one of the accounts you created. Sign out from **Settings**.

---

### Good to know
- **The desktop app is gated too** (it loads the same panel). If you want the desktop
  ungated, say so and we'll add a host bypass.
- **Scope of protection:** this is a real login wall enforced by Firebase (only valid
  accounts get a session). It is *not* a cryptographic lock on the local code — a
  technical user could edit the local extension to skip the gate. Truly preventing
  that needs a server dependency (i.e. the cloud functions/back end you ruled out).
  For access control + a login wall, this is the standard approach.
- **Manager dashboard (later):** when you build it, it just calls the same Firebase
  Auth "create user" (Admin SDK on your side / or the console) — no change here.
