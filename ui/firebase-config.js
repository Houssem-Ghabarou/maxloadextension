/* MaxLoad — Firebase config.
 *
 * From Firebase console → Project settings → "Your apps" → Web app.
 *
 * NOTE: a Firebase Web API key is a PUBLIC identifier, not a secret. Access is
 * controlled by Firebase Authentication + disabling public sign-up (see
 * FIREBASE_SETUP.md), NOT by hiding this value. Committing it is expected and safe.
 *
 * MaxLoad's login gate uses the Auth REST API and only needs `apiKey`; the rest are
 * kept for reference / future use. Once a real apiKey is set here the gate is ACTIVE.
 */
window.MAXLOAD_FIREBASE = {
  apiKey: "AIzaSyAh_q2agSuS9_JTClvFYhJWNYhLOwBo24o",
  authDomain: "imxdep.firebaseapp.com",
  projectId: "imxdep",
  storageBucket: "imxdep.firebasestorage.app",
  messagingSenderId: "420666729017",
  appId: "1:420666729017:web:12796354508772c0da63e8",
  measurementId: "G-XKBTE1GK5T",
};
