// scripts/migrations/return-cancelled-samples-to-rnd.js
//
// STYLES LEFT AT "submitted" BEHIND A WORK ORDER THAT WAS ALREADY CANCELLED.
//
// ── THE STATE THIS EXISTS FOR ───────────────────────────────────────────────
// Cancelling an unrouted sample work order is two changes: the order goes to
// `cancelled`, and the style it belongs to goes back to route editing. For a
// while it was only the first. Anything cancelled in that window — and
// anything whose replay hit the old early return — is stuck: the work order
// reads `cancelled`, `SampleStyle.production.status` still reads `submitted`,
// and R&D's page correctly shows the cancelled attempt while hiding the
// operation-route panel it tells the reader to use.
//
// The route now reconciles the style on a replay, so nothing NEW can land in
// this state. This is for the records already in it.
//
// ── WHAT IT CHANGES, AND WHAT IT REFUSES TO ─────────────────────────────────
// One field and one log entry per style: `production.status` back to the step
// whose product is registered, and one `attempt_cancelled` entry carrying the
// ORIGINAL reason, actor and timestamp read off the work order's own
// `cancellation`. Nothing else. It does not delete anything, does not create a
// replacement work order, does not invent an operation route, and does not
// touch a style that any live work order still governs.
//
// It reuses services/manufacturing/sampleStyleReturn.service.js — the same
// code the route runs — rather than reimplementing the rule, so the repair and
// the endpoint cannot drift apart.
//
// ── AND IT IS IDEMPOTENT ────────────────────────────────────────────────────
// A style already reconciled is not a candidate; a log entry already written
// is recognised by its `workOrderId` and never duplicated. Running it twice
// changes nothing the second time.
//
// Dry run by default; `--apply` is required to write.
//
//   node scripts/migrations/return-cancelled-samples-to-rnd.js
//   node scripts/migrations/return-cancelled-samples-to-rnd.js --apply
//
// Narrow it to one record with `--work-order=<id>` or `--style=<SS-… or id>`.

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ONLY_WORK_ORDER = argOf("work-order");
const ONLY_STYLE = argOf("style");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const svc = require("../../services/manufacturing/sampleStyleReturn.service");

  /* ── 1. THE CANDIDATES ─────────────────────────────────────────────
     Styles still claiming to be in production that have at least one work
     order recorded against them. Narrowed further, one at a time, below —
     "has a cancelled order" is not a query this shape can express. */
  const filter = { "production.status": "submitted" };
  if (ONLY_STYLE) {
    filter.$or = [
      { sampleStyleId: ONLY_STYLE },
      ...(mongoose.Types.ObjectId.isValid(ONLY_STYLE) ? [{ _id: ONLY_STYLE }] : []),
    ];
  }
  if (ONLY_WORK_ORDER) filter["production.workOrderIds"] = ONLY_WORK_ORDER;

  const styles = await SampleStyle.find(filter);
  console.log(`${styles.length} style(s) at production.status "submitted"${ONLY_STYLE || ONLY_WORK_ORDER ? " (narrowed)" : ""}.\n`);

  const repairable = [];
  const skipped = [];

  for (const style of styles) {
    const ids = (style.production?.workOrderIds || []).filter(Boolean);
    if (!ids.length) {
      skipped.push({ style, why: "no work orders recorded on the style" });
      continue;
    }
    const orders = await WorkOrder.find({ _id: { $in: ids } })
      .select("workOrderNumber status operations cancellation").lean();

    const live = orders.filter((w) => w.status !== "cancelled");
    if (live.length) {
      /* Something still governs it. Not this script's business — reopening
         would invite a second attempt beside a running one. */
      skipped.push({
        style, why: `still governed by ${live.map((w) => `${w.workOrderNumber || w._id} (${w.status})`).join(", ")}`,
      });
      continue;
    }

    /* ── AND IT MUST BE THE UNROUTED CASE ────────────────────────────
       A cancelled order that HAD a route was cancelled for some other
       reason, by somebody making a production decision. Returning its style
       to route editing is not a repair of this bug. */
    const cancelled = orders.filter((w) => w.status === "cancelled");
    const routed = cancelled.filter((w) => (w.operations || []).length);
    if (routed.length) {
      skipped.push({
        style, why: `cancelled order ${routed[0].workOrderNumber || routed[0]._id} had ${routed[0].operations.length} operations — not the unrouted case`,
      });
      continue;
    }

    /* The account is read off the work order's own record. The one cancelled
       most recently is the attempt that stranded the style. */
    const latest = [...cancelled].sort(
      (a, b) => new Date(b.cancellation?.at || 0) - new Date(a.cancellation?.at || 0),
    )[0];
    repairable.push({ style, workOrder: latest, cancelledCount: cancelled.length });
  }

  /* ── 2. SAY WHAT WOULD HAPPEN, ALWAYS ──────────────────────────────── */
  for (const s of skipped) {
    console.log(`SKIP  ${s.style.sampleStyleId || s.style._id} — ${s.why}`);
  }
  if (skipped.length) console.log("");

  if (!repairable.length) {
    console.log("Nothing to repair.");
    await mongoose.disconnect();
    return;
  }

  for (const r of repairable) {
    const c = r.workOrder.cancellation || {};
    const target = svc.reopenedStatusFor(r.style);
    const dupe = svc.existingEntryFor(r.style, r.workOrder._id);
    console.log(`REPAIR ${r.style.sampleStyleId || r.style._id}`);
    console.log(`       work order   ${r.workOrder.workOrderNumber || r.workOrder._id} (cancelled, ${(r.workOrder.operations || []).length} operations)`);
    console.log(`       reason       ${c.reason || "(none recorded)"}`);
    console.log(`       cancelled by ${c.byName || "(unnamed)"}${c.at ? ` on ${new Date(c.at).toISOString()}` : ""}`);
    console.log(`       cutting      ${c.cuttingRecorded ? "RECORDED — cut pieces are not carried into a replacement" : "none recorded"}`);
    console.log(`       status       submitted -> ${target}`);
    console.log(`       log entry    ${dupe ? "already present, will NOT be duplicated" : "one attempt_cancelled entry, with the original actor and date"}`);
    console.log("");
  }

  if (!APPLY) {
    console.log(`Dry run. ${repairable.length} style(s) would be repaired. Re-run with --apply to write.`);
    await mongoose.disconnect();
    return;
  }

  /* ── 3. APPLY, THROUGH THE SAME SERVICE THE ROUTE USES ─────────────── */
  let changed = 0;
  for (const r of repairable) {
    const c = r.workOrder.cancellation || {};
    const out = await svc.returnStyleToRouteEditing({
      style: r.style,
      workOrder: r.workOrder,
      /* The person who cancelled it, not whoever is running this. */
      actor: { id: c.byActorId || undefined, name: c.byName || "" },
      reason: c.reason || "",
      at: c.at || undefined,
    });
    if (out.wrote) changed += 1;
    console.log(
      `${out.wrote ? "WROTE " : "NOOP  "} ${r.style.sampleStyleId || r.style._id} — `
      + `status now "${out.status}"${out.wrote ? "" : " (already reconciled)"}`,
    );
  }
  console.log(`\n${changed} style(s) changed. ${repairable.length - changed} were already correct.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
