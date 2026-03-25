// GRAV-CMS-BACKEND/config/firebaseAdmin.js
const admin = require("firebase-admin");

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("❌ FIREBASE_SERVICE_ACCOUNT not set in .env");
  }

  let sa;
  try {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    throw new Error("❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON — must be on ONE line in .env");
  }

  // Add database URL to the config
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://grav-cms-38f45-default-rtdb.firebaseio.com" // Add this line
  });
}

const db = admin.firestore();
const auth = admin.auth();
const messaging = admin.messaging();
const rtdb = admin.database(); // Add this for Realtime Database

module.exports = { admin, db, auth, messaging, rtdb };