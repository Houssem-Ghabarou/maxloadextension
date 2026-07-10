<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyAh_q2agSuS9_JTClvFYhJWNYhLOwBo24o",
    authDomain: "imxdep.firebaseapp.com",
    projectId: "imxdep",
    storageBucket: "imxdep.firebasestorage.app",
    messagingSenderId: "420666729017",
    appId: "1:420666729017:web:12796354508772c0da63e8",
    measurementId: "G-XKBTE1GK5T"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
</script>