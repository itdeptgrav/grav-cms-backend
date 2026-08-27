"use strict";
/**
 * services/taxIdentity.service.js
 * ───────────────────────────────────────────────────────────────────────────
 * ARE THESE TAX IDENTIFIERS REALLY THIS COMPANY'S?
 *
 * GSTIN, PAN, CIN and TAN are not four unrelated strings. They are four views
 * of one entity, and they OVERLAP — a GSTIN contains its PAN, a CIN contains
 * its state and year of incorporation, a TAN and a PAN both encode the first
 * letter of the name. Checked one at a time, all four can be individually
 * well-formed and still describe different companies. Checked together, a
 * typo has nowhere to hide.
 *
 * That is what this file is for. Every function here is OFFLINE — arithmetic
 * and pattern-matching on the identifiers themselves. It never asks a
 * government API whether a registration exists, and it must not be read as
 * saying so; see `verifyCompanyIdentity`'s return contract, which is careful
 * to claim only what it checked.
 *
 * ── ERRORS AND WARNINGS ARE DIFFERENT CLAIMS ───────────────────────────────
 * An ERROR means the value cannot be correct: a checksum that does not
 * compute, a GSTIN whose embedded PAN is not the PAN typed beside it. Those
 * are arithmetic, and arithmetic does not have exceptions.
 *
 * A WARNING means it is probably wrong: a PAN whose name-letter does not
 * match the company name, a CIN whose state disagrees with the address. Those
 * are heuristics with real, legitimate exceptions — a company that renamed
 * after incorporation keeps its old PAN letter, a company registered in one
 * state can have its office in another. Presenting those as failures teaches
 * people to click past the ones that matter.
 *
 * Nothing here blocks a save. It reports.
 */

const { GST_STATE_CODES, codeFromStateName } = require("./gstState.util");

/* ── shapes ────────────────────────────────────────────────────────────────
 * Each of these is the OFFICIAL layout, and each field is here because
 * something downstream cross-checks it.
 */
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;
const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
/* An LLP has an LLPIN, not a CIN, and people paste it into the CIN box
   constantly. Recognised so the message can say which box it belongs in. */
const LLPIN_RE = /^[A-Z]{3}-?[0-9]{4}$/;

/** PAN's 4th character — the holder's type. */
const PAN_ENTITY = {
  P: "Individual",
  C: "Company",
  H: "Hindu Undivided Family",
  F: "Firm or LLP",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
};

/** CIN's 13th–15th characters — how the company is owned. */
const CIN_OWNERSHIP = {
  PTC: "Private Limited Company",
  PLC: "Public Limited Company",
  OPC: "One Person Company",
  FTC: "Subsidiary of a Foreign Company",
  GOI: "Union Government Company",
  SGC: "State Government Company",
  NPL: "Not-for-Profit (Section 8)",
  ULL: "Unlimited Liability, Public",
  ULT: "Unlimited Liability, Private",
  GAP: "General Association, Public",
  GAT: "General Association, Private",
  FLC: "Financial Lease Company",
};

/* MCA writes the state as two LETTERS inside a CIN, where GST writes it as
   two DIGITS. The same fact in two alphabets, so comparing a CIN to a GSTIN
   or to an address needs this bridge. `OR` is Odisha's pre-2011 spelling and
   still appears in older CINs. */
const CIN_STATE_TO_GST_CODE = {
  AP: "37", AR: "12", AS: "18", BR: "10", CH: "04", CT: "22", CG: "22",
  DL: "07", GA: "30", GJ: "24", HR: "06", HP: "02", JK: "01", JH: "20",
  KA: "29", KL: "32", LD: "31", MP: "23", MH: "27", MN: "14", ML: "17",
  MZ: "15", NL: "13", OD: "21", OR: "21", PY: "34", PB: "03", RJ: "08",
  SK: "11", TN: "33", TG: "36", TS: "36", TR: "16", UP: "09", UK: "05",
  UT: "05", WB: "19", AN: "35", DN: "26", DD: "25", LA: "38",
};

const clean = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");

/** The first letter a PAN or TAN would encode for this name. */
function nameInitial(companyName = "") {
  const first = String(companyName).trim().toUpperCase().replace(/[^A-Z ]/g, "").trim();
  return first ? first[0] : null;
}

/* ══ GSTIN ═════════════════════════════════════════════════════════════════ */

/**
 * The official GSTN check digit: base-36 over the first 14 characters,
 * weighted 1, 2, 1, 2, …, folded, and taken mod 36.
 *
 * This lived inside routes/Accountant_Routes/Acc_chartOfAccounts.js, four
 * thousand lines into a route file, where nothing else could reach it — so
 * the company form validated nothing while the ledger screen validated
 * properly. Moved here so there is ONE implementation; that route now imports
 * it rather than keeping a second copy to drift.
 */
function gstinChecksumValid(gstin) {
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return false;
  const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let v = charset.indexOf(gstin[i]);
    if (v < 0) return false;
    v = v * (i % 2 === 0 ? 1 : 2);
    v = Math.floor(v / 36) + (v % 36);
    sum += v;
  }
  return charset[(36 - (sum % 36)) % 36] === gstin[14];
}

function validateGstin(raw) {
  const value = clean(raw);
  if (!value) return { field: "gstin", value: "", status: "empty" };

  if (value.length !== 15) {
    return {
      field: "gstin",
      value,
      status: "error",
      message: `A GSTIN is 15 characters; this is ${value.length}.`,
    };
  }
  if (!GSTIN_RE.test(value)) {
    return {
      field: "gstin",
      value,
      status: "error",
      message:
        "Not a GSTIN shape: 2 digits (state) + 10-character PAN + 1 entity character + 'Z' + 1 check character.",
    };
  }
  if (!gstinChecksumValid(value)) {
    return {
      field: "gstin",
      value,
      status: "error",
      /* The single most useful message in this file. A GSTIN that is the
         right shape and fails the check digit is almost always one mistyped
         character, and this is the only signal that says so. */
      message: "The check digit does not match — one character is mistyped.",
    };
  }

  const stateCode = value.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode] || null;
  if (!stateName) {
    return {
      field: "gstin",
      value,
      status: "error",
      message: `${stateCode} is not a GST state code.`,
    };
  }

  return {
    field: "gstin",
    value,
    status: "ok",
    stateCode,
    stateName,
    embeddedPan: value.slice(2, 12),
    entityNumber: value[12],
    message: `Valid GSTIN — ${stateName}, registration ${value[12]} under this PAN.`,
  };
}

/* ══ PAN ═══════════════════════════════════════════════════════════════════ */

function validatePan(raw, { companyName } = {}) {
  const value = clean(raw);
  if (!value) return { field: "pan", value: "", status: "empty" };

  if (!PAN_RE.test(value)) {
    return {
      field: "pan",
      value,
      status: "error",
      message: "Not a PAN shape: 5 letters + 4 digits + 1 letter.",
    };
  }

  const entity = PAN_ENTITY[value[3]];
  if (!entity) {
    return {
      field: "pan",
      value,
      status: "error",
      message: `'${value[3]}' is not a PAN holder type. The 4th character says what kind of taxpayer this is.`,
    };
  }

  const notes = [];
  /* The 5th character is the first letter of the holder's name. A real check
     with a real exception rate — a company that renamed keeps the letter from
     the name it had when the PAN was issued — so it is a note, never an
     error. */
  const initial = nameInitial(companyName);
  if (initial && value[4] !== initial) {
    notes.push(
      `The 5th character is '${value[4]}', which usually matches the first letter of the registered name — here '${initial}'. Worth confirming if the company has not been renamed.`,
    );
  }

  return {
    field: "pan",
    value,
    status: notes.length ? "warn" : "ok",
    entityType: entity,
    entityCode: value[3],
    message: notes.length ? notes.join(" ") : `Valid PAN — ${entity}.`,
  };
}

/* ══ TAN ═══════════════════════════════════════════════════════════════════ */

function validateTan(raw, { companyName } = {}) {
  const value = clean(raw);
  if (!value) return { field: "tan", value: "", status: "empty" };

  if (!TAN_RE.test(value)) {
    return {
      field: "tan",
      value,
      status: "error",
      message: "Not a TAN shape: 4 letters + 5 digits + 1 letter.",
    };
  }

  const initial = nameInitial(companyName);
  if (initial && value[3] !== initial) {
    return {
      field: "tan",
      value,
      status: "warn",
      jurisdiction: value.slice(0, 3),
      message: `The 4th character is '${value[3]}', which usually matches the first letter of the deductor's name — here '${initial}'.`,
    };
  }

  return {
    field: "tan",
    value,
    status: "ok",
    jurisdiction: value.slice(0, 3),
    message: `Valid TAN — jurisdiction ${value.slice(0, 3)}.`,
  };
}

/* ══ CIN ═══════════════════════════════════════════════════════════════════ */

function validateCin(raw, { companyName } = {}) {
  const value = clean(raw).replace(/-/g, "");
  if (!value) return { field: "cin", value: "", status: "empty" };

  if (LLPIN_RE.test(clean(raw))) {
    return {
      field: "cin",
      value: clean(raw),
      status: "error",
      /* Says which box it belongs in rather than only that this one is
         wrong — the difference between a message and a help. */
      message: "That looks like an LLPIN. An LLP has no CIN; leave this blank.",
    };
  }
  if (value.length !== 21) {
    return {
      field: "cin",
      value,
      status: "error",
      message: `A CIN is 21 characters; this is ${value.length}.`,
    };
  }
  if (!CIN_RE.test(value)) {
    return {
      field: "cin",
      value,
      status: "error",
      message:
        "Not a CIN shape: L or U + 5-digit industry code + 2-letter state + 4-digit year + 3-letter ownership + 6-digit registration number.",
    };
  }

  const listing = value[0] === "L" ? "Listed" : "Unlisted";
  const stateLetters = value.slice(6, 8);
  const year = Number(value.slice(8, 12));
  const ownershipCode = value.slice(12, 15);
  const ownership = CIN_OWNERSHIP[ownershipCode];

  if (!CIN_STATE_TO_GST_CODE[stateLetters]) {
    return {
      field: "cin",
      value,
      status: "error",
      message: `'${stateLetters}' is not a registrar-of-companies state code.`,
    };
  }
  if (!ownership) {
    return {
      field: "cin",
      value,
      status: "error",
      message: `'${ownershipCode}' is not a company-class code.`,
    };
  }

  const notes = [];
  const thisYear = new Date().getFullYear();
  if (year < 1857 || year > thisYear) {
    /* 1857 is the first Indian companies act. A year outside the range is a
       transposed digit, not a very old company. */
    notes.push(`The year of incorporation reads ${year}.`);
  }

  /* Class against the name suffix. "(OPC) Private Limited" is the legal style
     of a One Person Company, so OPC and PTC are BOTH consistent with a name
     ending in Private Limited — a check that flagged OPC here would fire on
     every one-person company in the country. */
  const name = String(companyName || "").toUpperCase();
  const saysPrivate = /\bPVT\.?\s*LTD|\bPRIVATE\s+LIMITED/.test(name);
  const saysPublicLtd = /\bLIMITED\b|\bLTD\b/.test(name) && !saysPrivate;

  if (saysPrivate && !["PTC", "OPC", "ULT", "GAT"].includes(ownershipCode)) {
    notes.push(
      `The name says Private Limited but the CIN class is ${ownershipCode} (${ownership}).`,
    );
  }
  if (saysPublicLtd && ["PTC", "OPC"].includes(ownershipCode)) {
    notes.push(
      `The CIN class is ${ownershipCode} (${ownership}) but the name is not styled Private Limited.`,
    );
  }
  if (value[0] === "L" && saysPrivate) {
    notes.push("The CIN begins with L (listed), which a private company would not.");
  }

  return {
    field: "cin",
    value,
    status: notes.length ? "warn" : "ok",
    listing,
    stateLetters,
    gstStateCode: CIN_STATE_TO_GST_CODE[stateLetters],
    stateName: GST_STATE_CODES[CIN_STATE_TO_GST_CODE[stateLetters]] || null,
    year,
    ownershipCode,
    ownership,
    message: notes.length
      ? notes.join(" ")
      : `Valid CIN — ${ownership}, ${listing.toLowerCase()}, registered in ${
          GST_STATE_CODES[CIN_STATE_TO_GST_CODE[stateLetters]] || stateLetters
        } in ${year}.`,
  };
}

/* ══ THE PART THAT ONLY WORKS TOGETHER ═════════════════════════════════════ */

/**
 * Checks that need two fields at once.
 *
 * This is where the value is. Each identifier above can be perfectly valid on
 * its own and still belong to a different company than the one beside it, and
 * only a comparison catches that.
 */
function crossCheck({ gstin, pan, cin, tan, address, companyName } = {}) {
  const findings = [];
  const g = validateGstin(gstin);
  const p = validatePan(pan, { companyName });
  const c = validateCin(cin, { companyName });

  /* Arithmetic, not a heuristic: characters 3–12 of a GSTIN ARE the PAN. If
     they differ, one of the two boxes is describing another company. */
  if (g.status === "ok" && p.status !== "empty" && p.status !== "error") {
    if (g.embeddedPan !== p.value) {
      findings.push({
        severity: "error",
        fields: ["gstin", "pan"],
        message: `The GSTIN contains PAN ${g.embeddedPan}, but the PAN field says ${p.value}. One of them is wrong.`,
      });
    }
  }

  /* A GSTIN with no PAN beside it can fill the PAN in — it is carrying it. */
  if (g.status === "ok" && p.status === "empty") {
    findings.push({
      severity: "info",
      fields: ["pan"],
      suggestion: { pan: g.embeddedPan },
      message: `The GSTIN contains PAN ${g.embeddedPan}. The PAN field is empty.`,
    });
  }

  const addrCode = clean(address?.stateCode) || null;
  const addrState = String(address?.state || "").trim();

  /* ── COMPARE CODES, NEVER SPELLINGS ─────────────────────────────────────
   * The first version of this compared state NAMES with a prefix heuristic
   * and decided Orissa was not Odisha — a validator failing on the very data
   * it exists to check, since both spellings sit in real address fields and
   * "Orissa" is what half of them say.
   *
   * gstState.util already resolves that: it maps every state name AND the
   * alternate spellings accountants actually type onto the one GST code. So
   * the name is turned into a code first and only codes are compared. Two
   * facts, one alphabet. */
  const addrStateCode = addrCode || codeFromStateName(addrState);

  if (g.status === "ok") {
    if (addrStateCode && addrStateCode !== g.stateCode) {
      findings.push({
        severity: "warn",
        fields: ["gstin", addrCode ? "address.stateCode" : "address.state"],
        message: `The GSTIN is registered in ${g.stateName} (${g.stateCode}) but the address is in ${
          GST_STATE_CODES[addrStateCode] || addrState || addrCode
        }.`,
      });
    }

    /* Offered whenever the code box is empty — including when the state NAME
       is present and already agrees. The previous shape only suggested when
       there was no name either, so the commonest case in the data (a typed
       state, no code) was silently left unfilled. */
    if (!addrCode && g.stateCode) {
      findings.push({
        severity: "info",
        fields: ["address.stateCode"],
        suggestion: { "address.stateCode": g.stateCode },
        message: `The GSTIN gives the state code ${g.stateCode} (${g.stateName}). The address has none.`,
      });
    }
  }

  /* A state nobody can resolve is worth saying out loud rather than silently
     skipping every check that depends on it. */
  if (addrState && !addrStateCode) {
    findings.push({
      severity: "info",
      fields: ["address.state"],
      message: `"${addrState}" is not a state name this system recognises, so state checks were skipped.`,
    });
  }

  /* The registrar's state and the GST state can legitimately differ — a
     company registered in Delhi can operate from Odisha — so this is a note
     even though both values are exact. */
  if (c.status !== "empty" && c.status !== "error" && g.status === "ok") {
    if (c.gstStateCode !== g.stateCode) {
      findings.push({
        severity: "warn",
        fields: ["cin", "gstin"],
        message: `The CIN was registered in ${c.stateName || c.stateLetters} but the GSTIN is in ${g.stateName}. That is legitimate for a company operating outside its state of incorporation — confirm it is intended.`,
      });
    }
  }

  /* A company with a CIN is a company, so its PAN's 4th character should say
     so. This one has no honest exception. */
  if (c.status !== "empty" && c.status !== "error" && p.status !== "empty" && p.status !== "error") {
    if (p.entityCode !== "C") {
      findings.push({
        severity: "error",
        fields: ["pan", "cin"],
        message: `The CIN says this is a registered company, but the PAN's 4th character '${p.entityCode}' means ${p.entityType}.`,
      });
    }
  }

  return { findings, gstin: g, pan: p, cin: c, tan: validateTan(tan, { companyName }) };
}

/* ══ COMPARING WHAT THE PORTAL SAYS ════════════════════════════════════════ */

/* A company writes its own name a dozen ways and the register holds exactly
   one of them. "GRAV CLOTHING PVT LTD" and "GRAV CLOTHING PRIVATE LIMITED"
   are the same company; a comparison that called those different would fire
   on nearly every record and be switched off within a week.

   So both sides are reduced to the same skeleton first: abbreviations
   expanded, punctuation dropped, spacing collapsed. What survives is the part
   that actually identifies the company. */
const NAME_EXPANSIONS = [
  [/\bPVT\b/g, "PRIVATE"],
  [/\bLTD\b/g, "LIMITED"],
  [/\bLMTD\b/g, "LIMITED"],
  [/\bCO\b/g, "COMPANY"],
  [/\bCORP\b/g, "CORPORATION"],
  [/\bINDS\b/g, "INDUSTRIES"],
  [/\bENT\b/g, "ENTERPRISES"],
  [/&/g, " AND "],
  /* An OPC's registered name carries "(OPC)" and the typed name almost never
     does. It is a class marker, not part of the identity. */
  [/\bOPC\b/g, " "],
];

function normaliseCompanyName(raw) {
  let v = String(raw || "").toUpperCase();
  v = v.replace(/[.,'"`\-_/\\()\[\]]/g, " ");
  for (const [re, to] of NAME_EXPANSIONS) v = v.replace(re, to);
  return v.replace(/\s+/g, " ").trim();
}

/** Statuses that mean this registration must not be invoiced against. */
const DEAD_STATUSES = /CANCELL?ED|SUSPEND|INACTIVE|INVALID/i;

/**
 * What the register says, against what was typed.
 *
 * This is the only function in this file that can produce a finding about
 * the OUTSIDE WORLD rather than about arithmetic, which is why it is kept
 * separate from `crossCheck` and why its findings are labelled `source:
 * "portal"` — a reader should always be able to tell which claims came from
 * a third party and which this system worked out for itself.
 */
function comparePortal({ companyName, gstin, address } = {}, lookup) {
  const findings = [];
  if (!lookup || !lookup.ok) return findings;

  if (lookup.found === false) {
    findings.push({
      severity: "error",
      source: "portal",
      fields: ["gstin"],
      message:
        "The GST Network has no registration with this GSTIN. The number is well-formed, so this is not a typo the check digit could catch.",
    });
    return findings;
  }

  const d = lookup.data || {};

  /* The most consequential thing a lookup can tell you, and the one the
     offline checks can never know: a cancelled GSTIN stays well-formed
     forever, and invoicing against one is a live compliance problem. */
  if (d.status && DEAD_STATUSES.test(String(d.status))) {
    findings.push({
      severity: "error",
      source: "portal",
      fields: ["gstin"],
      message: `The GST Network reports this registration as ${d.status}${
        d.cancelledDate ? ` since ${d.cancelledDate}` : ""
      }. Do not raise invoices against it.`,
    });
  }

  const registered = d.legalName || d.tradeName;
  if (registered && companyName) {
    const a = normaliseCompanyName(companyName);
    const b = normaliseCompanyName(registered);
    /* Containment counts as a match: a trade name is often the legal name
       with a suffix trimmed, and neither direction is wrong. */
    const same = a === b || (a && b && (a.includes(b) || b.includes(a)));
    if (!same) {
      findings.push({
        severity: "warn",
        source: "portal",
        fields: ["companyName", "gstin"],
        suggestion: { companyName: registered },
        message: `This GSTIN is registered to "${registered}". The company name here is "${companyName}".`,
      });
    }
  }

  const typedCode = clean(address?.stateCode) || codeFromStateName(address?.state);
  if (d.stateCode && typedCode && String(d.stateCode) !== String(typedCode)) {
    findings.push({
      severity: "warn",
      source: "portal",
      fields: ["gstin", "address.stateCode"],
      message: `The register places this registration in state ${d.stateCode}; the address says ${typedCode}.`,
    });
  }

  return findings;
}

/**
 * The whole answer for one company, in the shape the form renders.
 *
 * `verified` is deliberately NOT a field. Nothing here proves a registration
 * exists — only that these identifiers are internally consistent and could
 * exist. `checkedOffline: true` is the honest claim, and it is what the UI
 * repeats to the user.
 */
function verifyCompanyIdentity(company = {}, lookup = null) {
  const { findings: own, gstin, pan, cin, tan } = crossCheck(company);
  /* Portal findings first: a cancelled registration outranks a name-letter
     hunch, and the list is read top-down. */
  const findings = [...comparePortal(company, lookup), ...own];

  const fields = { gstin, pan, cin, tan };
  const errorCount =
    Object.values(fields).filter((f) => f.status === "error").length +
    findings.filter((f) => f.severity === "error").length;
  const warnCount =
    Object.values(fields).filter((f) => f.status === "warn").length +
    findings.filter((f) => f.severity === "warn").length;

  return {
    checkedOffline: true,
    /* Only true when a register actually answered. The UI hangs its "checked
       against the GST Network" line on this and must never show it because a
       lookup was ATTEMPTED. */
    checkedPortal: !!(lookup && lookup.ok),
    portal:
      lookup && lookup.ok && lookup.found
        ? { ...lookup.data, provider: lookup.provider, cached: !!lookup.cached }
        : null,
    portalError: lookup && !lookup.ok ? { reason: lookup.reason, hint: lookup.hint } : null,
    fields,
    findings,
    errorCount,
    warnCount,
    /* "clean" rather than "valid": every check that could be run passed. */
    clean: errorCount === 0 && warnCount === 0,
  };
}

module.exports = {
  comparePortal,
  normaliseCompanyName,
  validateGstin,
  validatePan,
  validateTan,
  validateCin,
  crossCheck,
  verifyCompanyIdentity,
  gstinChecksumValid,
  PAN_ENTITY,
  CIN_OWNERSHIP,
  CIN_STATE_TO_GST_CODE,
};
