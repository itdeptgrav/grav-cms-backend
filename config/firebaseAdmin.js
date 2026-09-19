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

/**
 * Where the Cowork data comes from.
 *
 * ## The one switch
 *
 * `COWORK_DB=mongo` makes `db` a MongoDB-backed object that answers the
 * Firestore admin API — the same `.collection().doc().get()`, the same
 * `FieldValue`, the same snapshots. Every one of the ~504 call sites in this
 * backend keeps its code; this line is the whole cutover.
 *
 * Anything other than `mongo` — including the variable being unset, which is
 * the default — leaves Firestore exactly as it was. That is deliberate: the
 * migration has to be reversible by an environment variable and a restart, not
 * by a deploy, because the moment to undo it is the moment nobody wants to be
 * waiting for a build.
 *
 * ## What does NOT move
 *
 * `auth`, `messaging` and `admin` stay on Firebase. Authentication is not part
 * of this migration — every `/cowork/**` request is still a verified Firebase
 * ID token, `Middlewear/coworkAuth.js` is untouched, and the browser still
 * signs in exactly as it does today.
 *
 * `rtdb` is the Firebase Realtime **Database**, a different product from
 * Firestore and a different migration. It is left connected so nothing that
 * uses it breaks; if it turns out to hold Cowork data, that is a second piece
 * of work with its own cutover.
 *
 * ## Why this connects without awaiting
 *
 * This module is required synchronously by ~87 files, so it cannot await
 * anything. It does not need to: the MongoDB driver connects lazily on the
 * first operation, so `client.db(name)` is valid immediately and the first
 * query pays the handshake. A failure surfaces there, on a request, rather
 * than crashing the process at import — which is the same shape Firestore had.
 */
const { coworkDbChoice } = require("../services/mongo/coworkDbChoice");

/* Throws with something a person can act on if COWORK_DB=mongo is set without
   a usable URI — see `coworkDbChoice`, where the rules live and are tested. */
const choice = coworkDbChoice(process.env);
const useMongo = choice.useMongo;

let db;
if (useMongo) {
  const { MongoClient } = require("mongodb");
  const { createFirestoreCompat } = require("../services/mongo/firestoreCompat");
  const { mongoStore } = require("../services/mongo/mongoStore");

  const client = new MongoClient(choice.uri);
  const mongo = client.db(choice.dbName);
  db = createFirestoreCompat(mongoStore(mongo, { client }));
  db.__mongo = { client, mongo };
  console.log(`🍃 Cowork data: MongoDB (${choice.dbName}), Firestore-compatible facade`);
} else {
  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
}

const auth = admin.auth();
const messaging = admin.messaging();
const rtdb = admin.database(); // Add this for Realtime Database

module.exports = { admin, db, auth, messaging, rtdb, useMongo };
