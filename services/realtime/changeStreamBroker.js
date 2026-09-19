/**
 * MongoDB change streams → Socket.IO. The replacement for Firestore listeners.
 *
 * ## What this has to be as good as
 *
 * Firestore's `onSnapshot` gives the browser a live view with no server in the
 * middle, and it survives a dropped connection by replaying what was missed.
 * Anything less than that is a visible downgrade, so this has to match it on
 * three counts: changes arrive without polling, nothing is missed across a
 * reconnect, and a client that has fallen too far behind is TOLD rather than
 * left quietly stale.
 *
 * ## Why one stream and not forty-one
 *
 * There are 41 `cowork_*` collections. Watching each would open 41 cursors,
 * each holding a connection and its own oplog position. `db.watch()` opens ONE
 * cursor over the database and filters server-side, which is both cheaper and —
 * more importantly — gives a single resume token covering everything, so there
 * is one position to remember rather than forty-one that can drift apart.
 *
 * ## The resume token, and the one case it cannot cover
 *
 * Every change carries a token naming its place in the oplog. Persisting it
 * means a restart resumes exactly where it stopped instead of silently skipping
 * whatever happened while the process was down.
 *
 * The oplog is finite. A process down long enough for its token to age out gets
 * `ChangeStreamHistoryLost`, and no amount of retrying will recover those
 * events — they are gone. The honest response is not to pretend: the broker
 * restarts from NOW and emits `realtime:resync`, which the client turns into a
 * full refetch. A visible half-second of reloading beats a screen that is
 * quietly wrong.
 *
 * ## What it must never do
 *
 * Emit to a room a client asked for. The audience comes from the document, via
 * `rooms.js` — see the note at the top of that file for why that distinction is
 * the whole security model now that Firestore's rules are gone.
 */

const { audienceFor, isWatched, watchedCollections } = require("./rooms");

/** Where the oplog position is kept between restarts. */
const STATE_COLLECTION = "cowork_realtime_state";
const STATE_ID = "changeStreamResumeToken";

/** How long to wait before reopening a stream that failed, and the ceiling. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * The event a client receives. One shape for every collection, because the
 * client's job is to invalidate and refetch, not to apply a diff — applying a
 * diff on the client is how two copies of the truth come to disagree.
 */
function toEvent(change) {
  /* `ns.coll`, which is what MongoDB actually calls it — the namespace is
     `{ db, coll }`. Spelling it `collection` here read perfectly well and was
     silently `undefined`, so every change looked like an unwatched collection
     and nothing was ever delivered. The `$match` above had it right, which is
     what made the two disagree. */
  const collection = change?.ns?.coll;
  const documentKey = change?.documentKey?._id;
  return {
    collection,
    id: documentKey == null ? null : String(documentKey),
    /* `insert` / `update` / `replace` / `delete`. Passed through rather than
       collapsed, because a delete has to remove a row that an update would
       only redraw. */
    operation: change?.operationType ?? "unknown",
    at: new Date().toISOString(),
  };
}

class ChangeStreamBroker {
  /**
   * @param {object} deps
   * @param {import("mongodb").Db} deps.db     the Cowork database
   * @param {import("socket.io").Server} deps.io
   * @param {(msg: string, extra?: unknown) => void} [deps.log]
   */
  constructor({ db, io, log }) {
    this.db = db;
    this.io = io;
    this.log = log ?? ((m, e) => console.log(`[realtime] ${m}`, e ?? ""));
    this.stream = null;
    this.stopped = false;
    this.retryMs = RETRY_BASE_MS;
    /* Counters, so `/cowork/admin/realtime-stats` can answer "is it actually
       delivering?" without anyone reading logs. */
    this.stats = { events: 0, delivered: 0, dropped: 0, resyncs: 0, since: null };
  }

  /* ── Resume position ──────────────────────────────────────────────────── */

  async readResumeToken() {
    try {
      const doc = await this.db
        .collection(STATE_COLLECTION)
        .findOne({ _id: STATE_ID });
      return doc?.token ?? null;
    } catch (e) {
      this.log("could not read the resume token; starting from now", e.message);
      return null;
    }
  }

  async writeResumeToken(token) {
    if (!token) return;
    try {
      await this.db
        .collection(STATE_COLLECTION)
        .updateOne(
          { _id: STATE_ID },
          { $set: { token, at: new Date() } },
          { upsert: true },
        );
    } catch (e) {
      /* Losing the position costs a resync on the next restart, which is
         survivable. Taking the broker down over it is not. */
      this.log("could not persist the resume token", e.message);
    }
  }

  /* ── The stream ───────────────────────────────────────────────────────── */

  /**
   * The server-side filter.
   *
   * `cowork_realtime_state` is excluded explicitly: this broker WRITES to it on
   * every change, so without the exclusion each event would produce another
   * event, for ever.
   */
  pipeline() {
    return [
      {
        $match: {
          "ns.coll": { $in: watchedCollections(), $ne: STATE_COLLECTION },
          operationType: { $in: ["insert", "update", "replace", "delete"] },
        },
      },
    ];
  }

  async start() {
    this.stopped = false;
    this.stats.since = new Date().toISOString();
    await this.open();
  }

  async open() {
    if (this.stopped) return;

    const token = await this.readResumeToken();
    const options = {
      /* The whole document, because the audience is computed FROM it. Without
         this an update carries only the changed fields and there is no way to
         know who is on the task. */
      fullDocument: "updateLookup",
      ...(token ? { resumeAfter: token } : {}),
    };

    try {
      this.stream = this.db.watch(this.pipeline(), options);
      this.log(
        token
          ? "watching, resumed from the stored position"
          : "watching, starting from now",
      );
      this.retryMs = RETRY_BASE_MS;
    } catch (e) {
      return this.recover(e);
    }

    this.stream.on("change", (change) => void this.deliver(change));
    this.stream.on("error", (e) => void this.recover(e));
    this.stream.on("close", () => {
      if (!this.stopped) void this.recover(new Error("stream closed"));
    });
  }

  /**
   * One change, to the people the document names.
   *
   * A delete carries no `fullDocument` — the document is gone, so there is
   * nothing to compute an audience from. `fullDocumentBeforeChange` needs
   * pre-images enabled on the collection, which is a per-collection setting
   * this does not assume. Until a collection opts in, a delete is announced to
   * the people who were watching that ROOM by id — see `deliverDelete`.
   */
  async deliver(change) {
    this.stats.events += 1;
    const event = toEvent(change);
    if (!event.collection || !isWatched(event.collection)) return;

    if (change.operationType === "delete") return this.deliverDelete(change, event);

    const audience = audienceFor(event.collection, change.fullDocument);
    if (audience.length === 0) {
      /* Nobody to tell. Counted rather than ignored: a collection quietly
         addressing nobody is a rule that needs looking at, and the number is
         how anyone would notice. */
      this.stats.dropped += 1;
    } else {
      this.io.to(audience).emit("realtime:change", event);
      this.stats.delivered += 1;
    }

    await this.writeResumeToken(change._id);
  }

  /**
   * A delete, where the document can no longer answer who cared about it.
   *
   * Addressed to a per-document room (`doc:<collection>:<id>`) that a client
   * joins only for records it is ALREADY entitled to — the entitlement was
   * checked when it read the record. That keeps the rule intact: the server
   * still decides, it just decided earlier.
   */
  async deliverDelete(change, event) {
    this.io.to(`doc:${event.collection}:${event.id}`).emit("realtime:change", event);
    this.stats.delivered += 1;
    await this.writeResumeToken(change._id);
  }

  /* ── Failure ──────────────────────────────────────────────────────────── */

  async recover(error) {
    if (this.stopped) return;
    const code = error?.codeName ?? error?.code;
    const lost =
      code === "ChangeStreamHistoryLost" ||
      code === 286 ||
      /resume token|history lost/i.test(String(error?.message ?? ""));

    try {
      await this.stream?.close();
    } catch {
      /* Already gone. */
    }
    this.stream = null;

    if (lost) {
      /* The events are gone and no retry brings them back. Say so, start
         clean, and tell every client to refetch rather than leaving screens
         quietly stale. */
      this.log("oplog history lost — resyncing every client", error?.message);
      this.stats.resyncs += 1;
      await this.db
        .collection(STATE_COLLECTION)
        .deleteOne({ _id: STATE_ID })
        .catch(() => {});
      this.io.emit("realtime:resync", { at: new Date().toISOString() });
      return this.open();
    }

    this.log(`stream failed, retrying in ${this.retryMs}ms`, error?.message);
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    setTimeout(() => void this.open(), wait).unref?.();
  }

  async stop() {
    this.stopped = true;
    try {
      await this.stream?.close();
    } catch {
      /* Shutting down; nothing to report. */
    }
    this.stream = null;
  }
}

module.exports = {
  ChangeStreamBroker,
  STATE_COLLECTION,
  STATE_ID,
  toEvent,
};
