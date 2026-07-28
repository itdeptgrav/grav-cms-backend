// services/mrfContext.service.js
//
// The single source of truth for "what is happening with this MRF right now".
//
// Every screen (cowork requester, cowork TL approvals, CMS store) and every
// notification body is derived from here, so the three frontends never drift
// into telling the same user three different stories. API responses carry the
// result as `context`; frontends render it verbatim rather than re-deriving.
//
//   buildContext(mrf, "requester" | "tl" | "store")

const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const fmtQty = (qty, unit) => `${round(qty)}${unit ? ` ${unit}` : ""}`;

// Lines that still matter — cancelled/rejected/unfulfillable lines are noise
// once the decision has been made.
const liveItems = (mrf) =>
  (mrf.items || []).filter(i => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus));

/**
 * Roll the per-item numbers up to request level. All figures are in each
 * line's own requester-chosen unit; `lines` keeps the per-item breakdown so
 * the UI can show "20 pieces requested, 13 available" verbatim.
 */
function summariseQuantities(mrf) {
  const lines = (mrf.items || []).map(i => {
    const requested = round(i.requestedQty);
    const issued = round(i.issuedQty);
    const returned = round(i.returnedQty);
    const dead = ["REJECTED", "UNFULFILLED"].includes(i.itemStatus);
    const remaining = dead ? 0 : Math.max(0, round(requested - issued));
    // availableQty is what the store reported, in the same unit. null = not
    // yet reviewed, which is different from "reported as zero".
    const available = i.availableQty === null || i.availableQty === undefined
      ? null
      : round(i.availableQty);
    return {
      itemId: String(i._id),
      name: i.rawItemName,
      unit: i.unit,
      variant: (i.variantCombination || []).join(" · "),
      availability: i.availability || "UNREVIEWED",
      availabilityNote: i.availabilityNote || "",
      alternativeItem: i.alternativeItem?.name ? i.alternativeItem : null,
      itemStatus: i.itemStatus,
      requested, issued, returned, remaining, available,
    };
  });

  const live = lines.filter(l => !["REJECTED", "UNFULFILLED"].includes(l.itemStatus));
  return {
    lines,
    totalItems: lines.length,
    liveItems: live.length,
    fullyIssued: live.filter(l => l.requested > 0 && l.issued >= l.requested - 0.001).length,
    partiallyIssued: live.filter(l => l.issued > 0 && l.issued < l.requested - 0.001).length,
    notIssued: live.filter(l => l.issued <= 0).length,
    anyRemaining: live.some(l => l.remaining > 0),
  };
}

/** One-line human summary of a partial situation, e.g. the spec's 20/13/7. */
function partialSentence(lines, verb) {
  const parts = lines.map(l => {
    if (verb === "available") {
      return `${l.name}: requested ${fmtQty(l.requested, l.unit)}, only ${fmtQty(l.available, l.unit)} available — ${fmtQty(l.available, l.unit)} can be issued, with ${fmtQty(l.requested - l.available, l.unit)} still pending`;
    }
    return `${l.name}: ${fmtQty(l.issued, l.unit)} issued of ${fmtQty(l.requested, l.unit)}, ${fmtQty(l.remaining, l.unit)} still pending`;
  });
  return parts.join(". ") + ".";
}

/** The most recent meaningful action, for "who did what, when". */
function lastAction(mrf) {
  const h = mrf.statusHistory || [];
  if (!h.length) return null;
  const e = [...h].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0];
  return { action: e.action, actorName: e.actorName, actorRole: e.actorRole, at: e.at, detail: e.detail };
}

function buildContext(mrf, audience = "requester") {
  const q = summariseQuantities(mrf);
  const isRequester = audience === "requester";
  const isTl = audience === "tl";
  const isStore = audience === "store";

  // "your request" / "this request" / "<name>'s request"
  const subject = isRequester ? "Your material request" : `${mrf.requestedForName || "This"}'s material request`;
  const shortSubject = isRequester ? "Your request" : `${mrf.mrfNumber}`;

  const base = {
    status: mrf.status,
    mrfNumber: mrf.mrfNumber,
    quantities: q,
    lastAction: lastAction(mrf),
    approverName: mrf.approverName || "",
    autoForwarded: !!mrf.autoForwarded,
  };

  // ── Terminal / decision states ────────────────────────────────────────
  if (mrf.status === "REJECTED") {
    const by = mrf.tlRejectedByName || mrf.approverName || "your Primary Manager/TL";
    const note = mrf.tlRejectionNote || mrf.rejectionNote || "";
    return {
      ...base,
      statusLabel: "Rejected",
      tone: "danger",
      headline: isRequester ? "Request rejected" : "Rejected by TL",
      message: isRequester
        ? `Your material request has been rejected by your Primary Manager/TL${by ? ` (${by})` : ""}.${note ? ` Reason: "${note}"` : " Please check the rejection reason for more details."}`
        : `${mrf.mrfNumber} was rejected by ${by}.${note ? ` Reason: "${note}"` : ""}`,
      nextActionBy: "none",
      nextAction: isRequester
        ? "No further action — raise a new request if the material is still needed."
        : "No action required.",
    };
  }

  if (mrf.status === "CANCELLED") {
    return {
      ...base,
      statusLabel: "Cancelled",
      tone: "muted",
      headline: "Request cancelled",
      message: isRequester
        ? `You cancelled this material request.${mrf.cancellationNote ? ` Note: "${mrf.cancellationNote}"` : ""}`
        : `${mrf.mrfNumber} was cancelled${mrf.cancellationNote ? ` — "${mrf.cancellationNote}"` : ""}.`,
      nextActionBy: "none",
      nextAction: "No action required.",
    };
  }

  if (mrf.status === "UNFULFILLED") {
    const reason = mrf.unfulfilledReason || "";
    return {
      ...base,
      statusLabel: "Cannot be fulfilled",
      tone: "danger",
      headline: "Store cannot supply this",
      message: isRequester
        ? `Your request was approved, but the Store cannot supply the requested material.${reason ? ` Reason: "${reason}"` : ""} Please check the MRF chat for alternatives, or raise a new request for a different product.`
        : `${mrf.mrfNumber} was closed as unfulfillable by the Store.${reason ? ` Reason: "${reason}"` : ""}`,
      nextActionBy: isRequester ? "requester" : "none",
      nextAction: isRequester
        ? "Discuss an alternative in the MRF chat, or raise a new request."
        : "No action required.",
    };
  }

  if (mrf.status === "COMPLETED") {
    return {
      ...base,
      statusLabel: "Completed",
      tone: "success",
      headline: "Completed",
      message: isRequester
        ? "Completed — everything issued to you has been returned to the Store."
        : `${mrf.mrfNumber} is complete — all issued material has been returned.`,
      nextActionBy: "none",
      nextAction: "No action required.",
    };
  }

  // ── Awaiting TL approval ──────────────────────────────────────────────
  if (mrf.status === "PENDING") {
    const who = mrf.approverName || "your Primary Manager/TL";
    return {
      ...base,
      statusLabel: "Pending TL Approval",
      tone: "warning",
      headline: isTl ? "Waiting for your approval" : "Waiting for TL approval",
      message: isRequester
        ? `Your material request has been submitted successfully and is waiting for approval from your Primary Manager/TL${mrf.approverName ? ` (${mrf.approverName})` : ""}.`
        : isTl
          ? `${mrf.requestedForName || "An employee"} has raised ${mrf.mrfNumber} and is waiting for your approval. Review the requested items, quantities and product images, then approve or reject.`
          : `${mrf.mrfNumber} is still awaiting approval from ${who} — it has not reached the Store yet.`,
      nextActionBy: "tl",
      nextAction: isTl
        ? "Approve or reject this request."
        : `Waiting on ${who} to approve or reject.`,
    };
  }

  // ── With the store: APPROVED / PARTIALLY_ISSUED / ISSUED / PARTIALLY_RETURNED ──
  const reviewed = !!mrf.storeReviewedAt;
  const live = q.lines.filter(l => !["REJECTED", "UNFULFILLED"].includes(l.itemStatus));
  const notAvailable = live.filter(l => l.availability === "NOT_AVAILABLE");
  const partial = live.filter(l => l.availability === "PARTIAL");
  const alternative = live.filter(l => l.availability === "ALTERNATIVE");
  const allAvailable = live.length > 0 && live.every(l => l.availability === "AVAILABLE");

  if (mrf.status === "ISSUED") {
    return {
      ...base,
      statusLabel: "Fully Issued",
      tone: "success",
      headline: "Material issued",
      message: isRequester
        ? "Your requested material has been fully issued by the Store."
        : `${mrf.mrfNumber} has been fully issued to ${mrf.requestedForName || "the requester"}.`,
      nextActionBy: mrf.requestType === "TIME_BASED" ? "requester" : "none",
      nextAction: mrf.requestType === "TIME_BASED"
        ? (isRequester
          ? `Return the material by ${mrf.deadline ? new Date(mrf.deadline).toDateString() : "the agreed deadline"}.`
          : "Awaiting return from the requester.")
        : "No action required.",
    };
  }

  if (mrf.status === "PARTIALLY_RETURNED") {
    return {
      ...base,
      statusLabel: "Partly Returned",
      tone: "info",
      headline: "Partly returned",
      message: isRequester
        ? "Some of the issued material has been returned; the rest is still with you."
        : `${mrf.mrfNumber} — some issued material has been returned, the rest is still out.`,
      nextActionBy: "requester",
      nextAction: isRequester ? "Return the remaining material." : "Awaiting the remaining return.",
    };
  }

  if (mrf.status === "PARTIALLY_ISSUED") {
    const pendingLines = live.filter(l => l.remaining > 0);
    return {
      ...base,
      statusLabel: "Partially Issued",
      tone: "warning",
      headline: "Partly issued — quantity still pending",
      message: isRequester
        ? `Your material request has been partially fulfilled. Some quantity has been issued, and the remaining quantity is still pending. ${partialSentence(pendingLines, "issued")}`
        : `${mrf.mrfNumber} is partially issued. ${partialSentence(pendingLines, "issued")}`,
      nextActionBy: "store",
      nextAction: isStore
        ? "Issue the remaining quantity when stock allows, or mark it unavailable and tell the requester in the chat."
        : "The Store is arranging the remaining quantity.",
    };
  }

  // status === "APPROVED" from here — with the store, nothing issued yet.
  const approvedPrefix = mrf.autoForwarded
    ? (isRequester
      ? `${mrf.autoForwardReason || "No Primary Manager/TL could be identified for you, so your request was sent directly to the Store."}`
      : `${mrf.mrfNumber} was auto-forwarded to the Store (${mrf.autoForwardReason || "no TL could be resolved"}).`)
    : null;

  if (!reviewed) {
    return {
      ...base,
      statusLabel: "Approved — With Store",
      tone: "info",
      headline: mrf.autoForwarded ? "Sent to the Store (no TL found)" : "Approved — sent to the Store",
      message: approvedPrefix || (isRequester
        ? `Your material request has been approved by your Primary Manager/TL${mrf.tlApprovedByName ? ` (${mrf.tlApprovedByName})` : ""} and has been sent to the Store for processing.`
        : `${mrf.mrfNumber} was approved${mrf.tlApprovedByName ? ` by ${mrf.tlApprovedByName}` : ""} and is now with the Store.`),
      nextActionBy: "store",
      nextAction: isStore
        ? "Check availability for each item and record it, then issue what you can."
        : "Waiting for the Store to check availability.",
    };
  }

  if (notAvailable.length && notAvailable.length === live.length) {
    return {
      ...base,
      statusLabel: "Not Available",
      tone: "danger",
      headline: "Product not available",
      message: isRequester
        ? `The requested product is currently unavailable in the Store. Please check the MRF chat for further information or an alternative product.${notAvailable[0].availabilityNote ? ` Store note: "${notAvailable[0].availabilityNote}"` : ""}`
        : `${mrf.mrfNumber} — the Store has reported the requested product as unavailable.`,
      nextActionBy: isStore ? "store" : "requester",
      nextAction: isStore
        ? "Suggest an alternative in the chat, or close the request as unfulfillable with a reason."
        : "Check the MRF chat — the Store may propose an alternative.",
    };
  }

  if (alternative.length) {
    const alt = alternative[0];
    return {
      ...base,
      statusLabel: "Alternative Offered",
      tone: "warning",
      headline: "Store has suggested an alternative",
      message: isRequester
        ? `The requested product is not available, but the Store has suggested an alternative${alt.alternativeItem?.name ? `: "${alt.alternativeItem.name}"` : ""}. Discuss it in the MRF chat and confirm whether it works for you.`
        : `${mrf.mrfNumber} — an alternative product has been offered${alt.alternativeItem?.name ? `: "${alt.alternativeItem.name}"` : ""}, awaiting the requester's confirmation.`,
      nextActionBy: "requester",
      nextAction: isRequester
        ? "Confirm or decline the alternative in the MRF chat."
        : "Waiting for the requester to confirm the alternative.",
    };
  }

  if (partial.length) {
    return {
      ...base,
      statusLabel: "Partially Available",
      tone: "warning",
      headline: "Only part of the quantity is available",
      message: isRequester
        ? `${partialSentence(partial, "available")} The Store will issue what is available; the remaining quantity stays pending.`
        : `${mrf.mrfNumber} — ${partialSentence(partial, "available")}`,
      nextActionBy: "store",
      nextAction: isStore
        ? "Issue the available quantity — the shortfall stays pending on this request."
        : "The Store will issue the available quantity.",
    };
  }

  if (allAvailable) {
    return {
      ...base,
      statusLabel: "Available — Store Processing",
      tone: "info",
      headline: "Product available",
      message: isRequester
        ? "The requested product is available. The Store is processing the requested quantity."
        : `${mrf.mrfNumber} — all items are available and ready to issue.`,
      nextActionBy: "store",
      nextAction: isStore ? "Issue the material to the requester." : "The Store is preparing the material.",
    };
  }

  // Store has started reviewing but hasn't classified every line yet.
  return {
    ...base,
    statusLabel: "Store Processing",
    tone: "info",
    headline: "Store is processing this request",
    message: isRequester
      ? "Your approved material request is currently being processed by the Store."
      : `${mrf.mrfNumber} is being processed by the Store.`,
    nextActionBy: "store",
    nextAction: isStore
      ? "Finish recording availability for every item."
      : "Waiting on the Store.",
  };
}

module.exports = { buildContext, summariseQuantities, partialSentence, fmtQty };
