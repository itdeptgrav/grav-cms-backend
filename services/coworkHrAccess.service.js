// services/coworkHrAccess.service.js
//
// AN EMPLOYEE WHO IS INACTIVE IN HR HAS NO COWORK ACCESS  (12 Oct 2026, owner)
//
// HR's Inactive (`Employee.isActive === false` or `status === "inactive"`) is
// the company saying this person no longer works here. The CMS already refused
// them; CoWork did not — its accounts live in Firestore (`cowork_employees`)
// behind Firebase Auth, and nothing in the token check ever looked at HR. So a
// person HR had let go could still sign in to CoWork, and stayed on every
// picker as somebody work could be given to.
//
// The owner's rules:
//   · only ACCESS changes — nothing is deleted. The CoWork record, its tasks,
//     messages and history all stay; the record is marked, never removed;
//   · inactive in HR → cannot sign in, cannot use CoWork, and is off the
//     active employee lists;
//   · (implied) active again in HR → access returns.
//
// Three places enforce it, so no single one has to be perfect:
//   1. When HR changes the status (Employee-Section routes → `syncEmployee`),
//      the linked CoWork record(s) are marked inactive and the Firebase login
//      is DISABLED with its refresh tokens revoked — so the password stops
//      working and open sessions end. Reactivating reverses exactly what this
//      did and nothing else.
//   2. Every CoWork request (Middlewear/coworkAuth.js → `refusalFor`) refuses
//      a record marked inactive, and also asks HR directly — which is what
//      covers people who were already inactive before this existed. Finding
//      one starts the same sync, so the next sign-in fails at Firebase.
//   3. The directory (`markDirectory`) carries `status: "inactive"` for them,
//      which the CoWork app reads as "exited": off every picker, still named
//      on the work they did.
//
// WHICH HR RECORD IS A COWORK ACCOUNT? The same rule the admin panel uses
// (routes/task_routes/cowork.js /admin/hr-employees): HR's explicit
// `coworkEmployeeId` link, else the CoWork document id (or its `employeeId`)
// equal to HR's `biometricId`, else the account email equal to HR's work or
// personal address. Somebody can match more than one HR record (a re-hire
// keeps the old record); access is refused only when EVERY linked HR record
// is inactive — one active record means the person works here. An account
// with no HR record at all (the seeded CEO, an outside collaborator) is not
// HR's to govern and is left alone.
"use strict";

const HR_REASON = "Marked inactive in HR";
const HR_FIELDS = "firstName middleName lastName biometricId email personalEmail coworkEmployeeId isActive status";
const CODE = "EMPLOYEE_INACTIVE";
const MESSAGE = "Your account is inactive in HR, so it can no longer use Cowork. Your work and history are kept. If this is a mistake, contact HR.";

const str = (v) => String(v ?? "").trim();
const lc = (v) => str(v).toLowerCase();
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The HR rule — the same one `services/employeeDeparture.js` uses. */
function hasLeft(e) {
  return Boolean(e) && (e.isActive === false || lc(e.status) === "inactive");
}

/** A CoWork record this module (or anything) has marked inactive. */
function flaggedInactive(data) {
  return Boolean(data) && (data.isActive === false || lc(data.status) === "inactive");
}

/* ── MATCHING ──────────────────────────────────────────────────────────── */

/** HR records, indexed the three ways a CoWork account can point at one. */
function buildHrIndex(hrEmployees) {
  const byCowork = new Map(), byBio = new Map(), byEmail = new Map();
  const push = (m, k, e) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
  for (const e of hrEmployees || []) {
    push(byCowork, str(e.coworkEmployeeId), e);
    push(byBio, str(e.biometricId), e);
    push(byEmail, lc(e.email), e);
    if (lc(e.personalEmail) !== lc(e.email)) push(byEmail, lc(e.personalEmail), e);
  }
  return { byCowork, byBio, byEmail };
}

/** Every HR record linked to one CoWork account, once each. */
function linkedHrFor(index, docId, data = {}) {
  const found = new Map();
  const add = (list) => { for (const e of list || []) found.set(String(e._id), e); };
  add(index.byCowork.get(str(docId)));
  add(index.byBio.get(str(docId)));
  if (str(data.employeeId) && str(data.employeeId) !== str(docId)) add(index.byBio.get(str(data.employeeId)));
  add(index.byEmail.get(lc(data.email)));
  return [...found.values()];
}

/**
 * What HR says about one CoWork account: "none" (no HR record — not HR's to
 * govern), "active" (at least one linked record is active) or "inactive"
 * (every linked record has left).
 */
function hrStanding(linked) {
  if (!linked || !linked.length) return "none";
  return linked.every(hasLeft) ? "inactive" : "active";
}

/** The Mongo query for the HR records that could link to these accounts. */
function hrQueryFor(accounts) {
  const ids = new Set(), emails = new Set();
  for (const a of accounts) {
    if (str(a.id)) ids.add(str(a.id));
    if (str(a.data?.employeeId)) ids.add(str(a.data.employeeId));
    if (lc(a.data?.email)) emails.add(lc(a.data.email));
  }
  const or = [];
  if (ids.size) {
    or.push({ coworkEmployeeId: { $in: [...ids] } }, { biometricId: { $in: [...ids] } });
  }
  for (const e of emails) {
    const rx = new RegExp(`^${escapeRx(e)}$`, "i");
    or.push({ email: rx }, { personalEmail: rx });
  }
  return or.length ? { $or: or } : null;
}

/* ── THE SERVICE ───────────────────────────────────────────────────────── */

/**
 * @param deps.db        Firestore
 * @param deps.auth      Firebase Auth (admin)
 * @param deps.Employee  the HR Employee model
 * @param deps.now       () => Date
 * @param deps.onAccessChanged  (authUid|null) => void — cache invalidation
 */
function createCoworkHrAccess({ db, auth, Employee, now = () => new Date(), onAccessChanged = () => {} }) {
  const col = () => db.collection("cowork_employees");

  async function hrRecordsFor(accounts) {
    const q = hrQueryFor(accounts);
    if (!q) return [];
    return Employee.find(q).select(HR_FIELDS).lean();
  }

  /** The Firebase uid behind an account, read from the record or by email. */
  async function uidOf(data) {
    if (str(data?.authUid)) return str(data.authUid);
    if (!lc(data?.email)) return null;
    try { return (await auth.getUserByEmail(lc(data.email))).uid; } catch { return null; }
  }

  /** Mark inactive and switch the login off. Deletes nothing. */
  async function deactivate(account, { by = "" } = {}) {
    const uid = await uidOf(account.data);
    let disabledHere = false;
    if (uid) {
      try {
        const user = await auth.getUser(uid);
        if (!user.disabled) { await auth.updateUser(uid, { disabled: true }); disabledHere = true; }
        /* Ends every open session: a revoked refresh token cannot mint the next
           ID token, so a signed-in tab falls out within the hour at most — and
           the token check below refuses it on its next request anyway. */
        await auth.revokeRefreshTokens(uid);
      } catch (err) {
        if (err?.code !== "auth/user-not-found") throw err;
      }
    }
    await col().doc(account.id).set({
      status: "inactive",
      isActive: false,
      hrInactive: true,
      deactivatedAt: now().toISOString(),
      deactivatedBy: str(by),
      deactivatedReason: HR_REASON,
      /* Only what THIS switched off is switched back on: a login somebody had
         already disabled for another reason stays disabled on reactivation. */
      firebaseDisabledByHr: disabledHere || Boolean(account.data?.firebaseDisabledByHr),
      updatedAt: now().toISOString(),
    }, { merge: true });
    onAccessChanged(uid);
    return { id: account.id, uid, loginDisabled: disabledHere };
  }

  /** Undo `deactivate` — and only what it did. */
  async function reactivate(account, { by = "" } = {}) {
    const uid = await uidOf(account.data);
    let enabled = false;
    if (uid && account.data?.firebaseDisabledByHr) {
      try { await auth.updateUser(uid, { disabled: false }); enabled = true; } catch (err) {
        if (err?.code !== "auth/user-not-found") throw err;
      }
    }
    await col().doc(account.id).set({
      status: "active",
      isActive: true,
      hrInactive: false,
      firebaseDisabledByHr: false,
      reactivatedAt: now().toISOString(),
      reactivatedBy: str(by),
      updatedAt: now().toISOString(),
    }, { merge: true });
    onAccessChanged(uid);
    return { id: account.id, uid, loginEnabled: enabled };
  }

  /** The CoWork accounts one HR record links to. */
  async function accountsFor(emp) {
    const found = new Map();
    for (const id of new Set([str(emp.coworkEmployeeId), str(emp.biometricId)].filter(Boolean))) {
      const snap = await col().doc(id).get();
      if (snap.exists) found.set(snap.id, { id: snap.id, data: snap.data() });
    }
    const emails = new Set();
    for (const e of [emp.email, emp.personalEmail]) { if (str(e)) { emails.add(str(e)); emails.add(lc(e)); } }
    for (const e of emails) {
      const snap = await col().where("email", "==", e).get();
      for (const d of snap.docs) found.set(d.id, { id: d.id, data: d.data() });
    }
    return [...found.values()];
  }

  /**
   * Bring CoWork into line with HR for one employee — called whenever HR turns
   * a record inactive or active again. Each linked account is judged on ALL
   * the HR records linked to it, so reactivating a stale duplicate never
   * opens an account whose current HR record has left, and vice versa.
   */
  async function syncEmployee(emp, { by = "" } = {}) {
    const out = { deactivated: [], reactivated: [], unchanged: [] };
    if (!emp) return out;
    const accounts = await accountsFor(emp);
    if (!accounts.length) return out;
    const index = buildHrIndex(await hrRecordsFor(accounts));
    for (const a of accounts) {
      const standing = hrStanding(linkedHrFor(index, a.id, a.data));
      if (standing === "inactive" && !(a.data?.hrInactive && flaggedInactive(a.data))) {
        out.deactivated.push(await deactivate(a, { by }));
      } else if (standing === "active" && a.data?.hrInactive) {
        out.reactivated.push(await reactivate(a, { by }));
      } else {
        out.unchanged.push(a.id);
      }
    }
    return out;
  }

  /**
   * Why this CoWork account may not be used, or null. The record's own mark
   * first (no HR read needed); then HR itself, so someone made inactive before
   * this existed — or on another server process — is refused all the same, and
   * their record and login are brought into line in the background.
   */
  async function refusalFor(docId, data) {
    if (flaggedInactive(data)) return { code: CODE, message: MESSAGE };
    let standing = "none";
    try {
      const account = { id: docId, data };
      standing = hrStanding(linkedHrFor(buildHrIndex(await hrRecordsFor([account])), docId, data));
    } catch (err) {
      /* HR unreachable is not "inactive": the record's own mark above still
         holds, and the next request asks HR again. */
      console.warn(`[cowork-hr] could not read HR for ${docId}: ${err.message}`);
      return null;
    }
    if (standing !== "inactive") return null;
    deactivate({ id: docId, data }, { by: "Cowork sign-in check" })
      .catch((err) => console.error(`[cowork-hr] could not switch off ${docId}: ${err.message}`));
    return { code: CODE, message: MESSAGE };
  }

  /**
   * The directory with HR's standing applied: an account HR has let go reads
   * `status: "inactive"` even before its record was synced. Nothing is
   * removed — a person stays named on the work they did.
   */
  async function markDirectory(entries) {
    const list = entries || [];
    const accounts = list.map((e) => ({ id: e.id || e.employeeId, data: e }));
    let index;
    try { index = buildHrIndex(await hrRecordsFor(accounts)); } catch (err) {
      console.warn(`[cowork-hr] directory HR read failed: ${err.message}`);
      return list;
    }
    return list.map((e, i) => {
      if (flaggedInactive(e)) return { ...e, status: "inactive", isActive: false };
      return hrStanding(linkedHrFor(index, accounts[i].id, e)) === "inactive"
        ? { ...e, status: "inactive", isActive: false }
        : e;
    });
  }

  return { syncEmployee, refusalFor, markDirectory, deactivate, reactivate, accountsFor };
}

/* The live instance, built on first use so requiring this module never
   initialises Firebase (tests and scripts that only want the rules). */
let live = null;
function service() {
  if (!live) {
    const { db, auth } = require("../config/firebaseAdmin");
    const Employee = require("../models/Employee");
    live = createCoworkHrAccess({
      db, auth, Employee,
      onAccessChanged: (uid) => {
        try { require("../Middlewear/coworkAuth").invalidateEmployeeCache(uid || undefined); } catch { /* not loaded */ }
        try { require("./cowork.service").invalidateEmpListCache(); } catch { /* not loaded */ }
      },
    });
  }
  return live;
}

module.exports = {
  CODE,
  MESSAGE,
  HR_REASON,
  hasLeft,
  flaggedInactive,
  buildHrIndex,
  linkedHrFor,
  hrStanding,
  hrQueryFor,
  createCoworkHrAccess,
  syncEmployee: (...a) => service().syncEmployee(...a),
  refusalFor: (...a) => service().refusalFor(...a),
  markDirectory: (...a) => service().markDirectory(...a),
};
