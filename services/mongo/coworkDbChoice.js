/**
 * Which database Cowork reads, decided from the environment.
 *
 * Pulled out of `config/firebaseAdmin.js` so it can be tested. That module
 * throws on import without `FIREBASE_SERVICE_ACCOUNT`, which is right for a
 * server and means the cutover rules inside it could not be exercised on any
 * machine without production credentials — a boot guard nobody can test is a
 * boot guard nobody should trust.
 */

"use strict";

/**
 * Does this URI point at something that can serve change streams?
 *
 * Both of the things this migration depends on — change streams for realtime,
 * and multi-document transactions — exist ONLY on a replica set. A standalone
 * `mongod` accepts the connection, serves reads and writes perfectly well, and
 * then fails at the first `watch()`. By then the realtime layer is silently
 * dead: no error reaches a user, screens simply stop updating, and the symptom
 * looks like a frontend bug.
 *
 * A single-node replica set is enough and is one flag on one process, so the
 * cost of getting this right is much smaller than the cost of finding out late.
 *
 * `mongodb+srv://` is Atlas, which is always a replica set. Anything else has
 * to say `replicaSet=` for itself, and `directConnection=true` is refused
 * outright because it pins the driver to one node and disables the topology
 * discovery change streams need — a URI that names a replica set AND asks for
 * a direct connection is asking for two incompatible things.
 */
function servesChangeStreams(uri) {
  const text = String(uri || "");
  if (/[?&]directConnection=true/i.test(text)) return false;
  if (/^mongodb\+srv:\/\//i.test(text)) return true;
  return /[?&]replicaSet=[^&]+/i.test(text);
}

const REPLICA_SET_HELP =
  "COWORK_DB=mongo needs a replica set: change streams (realtime) and " +
  "transactions do not exist on a standalone mongod. Start it with " +
  "`mongod --replSet rs0`, run `rs.initiate()` once, and use a URI ending " +
  "`?replicaSet=rs0`. A single node is fine.";

/**
 * Read the cutover decision.
 *
 * Returns `{ useMongo, uri, dbName }`, or throws with something a person can
 * act on. Anything other than `mongo` — including the variable being unset,
 * which is the default — means Firestore, unchanged. The migration has to be
 * reversible by an environment variable and a restart rather than a deploy,
 * because the moment somebody wants to undo it is the worst moment to be
 * waiting for a build.
 */
function coworkDbChoice(env = process.env) {
  const useMongo = String(env.COWORK_DB || "").toLowerCase() === "mongo";
  if (!useMongo) return { useMongo: false, uri: null, dbName: null };

  const uri = env.COWORK_MONGODB_URI || env.MONGODB_URI || null;
  if (!uri) {
    throw new Error(
      "COWORK_DB=mongo but neither COWORK_MONGODB_URI nor MONGODB_URI is set.",
    );
  }
  if (!servesChangeStreams(uri)) throw new Error(REPLICA_SET_HELP);

  return {
    useMongo: true,
    uri,
    dbName: env.COWORK_MONGODB_DB || "cowork",
  };
}

module.exports = { REPLICA_SET_HELP, coworkDbChoice, servesChangeStreams };
