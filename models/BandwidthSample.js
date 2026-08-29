// models/BandwidthSample.js
//
// One row per (hour, scope, key). The tracker folds its live counters into
// these with $inc once a minute.
//
// Hourly rather than per-request on purpose. A per-request log of this service
// would be ~40 million documents a month and would itself become a meaningful
// Atlas egress cost - which would be a comical way to instrument a bandwidth
// problem. An hour is fine-grained enough to see the shape of a working day and
// to catch a runaway poller, and it keeps the collection at roughly
// (routes x 24 x 30) documents a month.
//
// `expiresAt` gives each row a 90-day life. Long enough to compare this month
// with the last two; short enough that the collection never becomes the thing
// somebody has to clean up.

const mongoose = require("mongoose");

const BandwidthSampleSchema = new mongoose.Schema(
  {
    hour: { type: Date, required: true },

    // route    - "GET /api/cms/store/items"  (an HTTP endpoint)
    // outbound - "www.googleapis.com"        (a host we fetch from)
    // consumer - "role:sales"                (who is calling us)
    // socket   - "/"                         (a socket.io namespace)
    scope: { type: String, required: true, enum: ["route", "outbound", "consumer", "socket"] },
    key: { type: String, required: true },

    calls: { type: Number, default: 0 },
    bytesOut: { type: Number, default: 0 },   // billed: HTTP Responses
    bytesRaw: { type: Number, default: 0 },   // pre-gzip, to show what compression saves
    bytesIn: { type: Number, default: 0 },    // uploads to us (not billed)
    outBytesDown: { type: Number, default: 0 }, // billed: Service-Initiated
    outBytesUp: { type: Number, default: 0 },
    outCalls: { type: Number, default: 0 },
    totalMs: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    fsReads: { type: Number, default: 0 },
    fsDocsRead: { type: Number, default: 0 },
    fsWrites: { type: Number, default: 0 },
    mongoOps: { type: Number, default: 0 },
    mongoDocs: { type: Number, default: 0 },
    mongoBytesEst: { type: Number, default: 0 },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { collection: "bandwidth_samples", versionKey: false },
);

// The upsert filter. Unique so two Render instances flushing the same second
// contend on one document and $inc both their counts into it, rather than
// racing to create two rows that each tell half the story.
BandwidthSampleSchema.index({ hour: 1, scope: 1, key: 1 }, { unique: true });

// Supports the dashboard's "top keys in this window" query.
BandwidthSampleSchema.index({ scope: 1, hour: -1 });

BandwidthSampleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.BandwidthSample ||
  mongoose.model("BandwidthSample", BandwidthSampleSchema);
