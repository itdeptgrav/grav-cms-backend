"use strict";
/*
 * scripts/ie/ieDemoIntegrity.js
 *
 * IS THE RECORDED SCENARIO ACTUALLY STILL THERE, WHOLE?
 *
 * ── WHY EXISTENCE OF ONE RECORD IS NOT ENOUGH ───────────────────────────────
 * The seeder used to decide "already built" by reading back the first
 * engineering file. That is a check on one document out of roughly ninety. A
 * deleted release, capacity standard, layout, bulletin version, operation or
 * identity left the seeder reporting "records reused" and returning success
 * over a scenario with a hole in it — which is worse than an empty database,
 * because the screens look populated and one journey dead-ends.
 *
 * So every member of the manifest is verified, and the LINKS and LIFECYCLE
 * STATES are verified too. A layout that exists but is no longer APPROVED, or
 * a standard that no longer names its layout, is not a scenario somebody can
 * demonstrate.
 *
 * ── AND A FAILED CHECK NAMES WHAT IS WRONG ──────────────────────────────────
 * Not a boolean. The seeder prints the reasons, because "rebuilt" with no
 * explanation is indistinguishable from "rebuilt every single run".
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const IeAllowancePolicy = require("../../models/CMS_Models/IndustrialEngineering/IeAllowancePolicy");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
const IeRampProfile = require("../../models/CMS_Models/IndustrialEngineering/IeRampProfile");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");

const { IDENTITIES } = require("./ieDemoScenario");

const ids = (a) => (a || []).filter((v) => mongoose.Types.ObjectId.isValid(String(v)));

/** How many of these ids still exist in this collection? */
async function present(Model, list) {
  const wanted = ids(list);
  if (!wanted.length) return { wanted: 0, found: 0 };
  const found = await Model.countDocuments({ _id: { $in: wanted } });
  return { wanted: wanted.length, found };
}

/**
 * Every check, with the reason it failed.
 *
 * @returns {Promise<{complete: boolean, reasons: string[]}>}
 */
async function verifyScenario(manifest, { skipRelease = false } = {}) {
  const reasons = [];
  const m = manifest || {};

  const all = async (label, Model, list, expected) => {
    const { wanted, found } = await present(Model, list);
    if (expected !== undefined && wanted !== expected) {
      reasons.push(`${label}: manifest records ${wanted}, expected ${expected}`);
      return false;
    }
    if (!wanted) { reasons.push(`${label}: nothing recorded`); return false; }
    if (found !== wanted) { reasons.push(`${label}: ${wanted - found} of ${wanted} missing`); return false; }
    return true;
  };

  /* ── THE TENANTS AND THE PEOPLE ───────────────────────────────────── */
  await all("companies", Acc_Company, m.companyIds, 2);

  for (const spec of IDENTITIES) {
    const user = await DeptUser.findOne({ email: spec.email }).lean();
    if (!user) { reasons.push(`identity ${spec.email}: user missing`); continue; }
    if (!user.isActive) reasons.push(`identity ${spec.email}: deactivated`);

    const grant = await DepartmentRole.findOne({
      departmentSlug: spec.dept, email: spec.email, isActive: true,
    }).lean();
    if (!grant) reasons.push(`identity ${spec.email}: no ${spec.dept} grant`);
    else if (grant.role !== spec.role) {
      reasons.push(`identity ${spec.email}: role is ${grant.role}, expected ${spec.role}`);
    }

    const memberships = await SpCompanyMembership.countDocuments({
      email: spec.email, isActive: true,
    });
    if (memberships !== spec.companies.length) {
      reasons.push(
        `identity ${spec.email}: ${memberships} memberships, expected ${spec.companies.length}`,
      );
    }
  }

  /* The departments the shells and the guards read. */
  for (const slug of ["ie", "ppc"]) {
    const dept = await AccessDepartment.findOne({ slug }).lean();
    if (!dept) reasons.push(`AccessDepartment ${slug}: missing`);
  }

  /* ── THE SOURCE CHAIN ─────────────────────────────────────────────── */
  await all("work orders", WorkOrder, m.workOrderIds);
  await all("styles", SampleStyle, m.styleIds);

  /* The canonical link, on the orders themselves. */
  for (const woId of ids(m.workOrderIds)) {
    const wo = await WorkOrder.findById(woId).select("_id sampleStyleId").lean();
    if (!wo) continue;
    if (!wo.sampleStyleId) {
      reasons.push(`work order ${woId}: no sampleStyleId (the canonical link)`);
      continue;
    }
    const style = await SampleStyle.findById(wo.sampleStyleId)
      .select("_id production.workOrderIds").lean();
    if (!style) { reasons.push(`work order ${woId}: names a style that is gone`); continue; }
    const back = (style.production?.workOrderIds || []).map(String);
    if (!back.includes(String(woId))) {
      reasons.push(`style ${style._id}: reverse list does not name order ${woId}`);
    }
  }

  /* ── THE IE RECORDS ───────────────────────────────────────────────── */
  await all("operations", IeOperation, m.operationIds);
  await all("allowance policy", IeAllowancePolicy, m.policyIds, 1);
  await all("method studies", IeMethodStudy, m.studyIds);
  await all("engineering files", IeStyleFile, m.fileIds);
  await all("ramp profile", IeRampProfile, m.rampIds, 1);

  /* Requirements are CONFIGURED, not merely present. The stored shape is
     `requirements.{configured, machine[], attachment[], labour[]}` — the
     service's own field names, read from the model rather than guessed. */
  const configured = await IeOperation.countDocuments({
    _id: { $in: ids(m.operationIds) },
    "requirements.configured": true,
    "requirements.machine.0": { $exists: true },
  });
  const wantedOps = ids(m.operationIds).length;
  if (wantedOps && configured < wantedOps) {
    reasons.push(`operations: ${wantedOps - configured} of ${wantedOps} have no configured machine requirement`);
  }

  /* And the labour and attachment evidence the release publishes separately. */
  const withLabour = await IeOperation.countDocuments({
    _id: { $in: ids(m.operationIds) }, "requirements.labour.0": { $exists: true },
  });
  if (wantedOps && withLabour < wantedOps) {
    reasons.push(`operations: ${wantedOps - withLabour} of ${wantedOps} have no labour requirement`);
  }
  const withAttachment = await IeOperation.countDocuments({
    _id: { $in: ids(m.operationIds) }, "requirements.attachment.0": { $exists: true },
  });
  if (wantedOps && withAttachment === 0) {
    reasons.push("operations: no attachment requirement anywhere");
  }

  /* ── THE APPROVED CHAIN, WITH ITS STATES AND ITS LINKS ────────────── */
  const version = await IeBulletinVersion.findById(ids(m.versionIds)[0]).lean();
  if (!version) reasons.push("bulletin version: missing");
  else if (version.state !== "APPROVED") reasons.push(`bulletin version: state is ${version.state}`);

  const layout = await IeLineLayout.findById(ids(m.layoutIds)[0]).lean();
  if (!layout) reasons.push("line layout: missing");
  else {
    if (layout.status !== "APPROVED") reasons.push(`line layout: status is ${layout.status}`);
    if (version && String(layout.ieBulletinVersionId) !== String(version._id)) {
      reasons.push("line layout: does not name the seeded bulletin version");
    }
  }

  const standard = await IeCapacityStandard.findById(ids(m.standardIds)[0]).lean();
  if (!standard) reasons.push("capacity standard: missing");
  else {
    if (standard.status !== "APPROVED") reasons.push(`capacity standard: status is ${standard.status}`);
    if (layout && String(standard.lineLayoutId) !== String(layout._id)) {
      reasons.push("capacity standard: does not name the seeded layout");
    }
    if (!standard.ramp) reasons.push("capacity standard: no ramp stage selected");
  }

  if (!skipRelease) {
    const release = await IeRelease.findById(ids(m.releaseIds)[0]).lean();
    if (!release) reasons.push("release: missing");
    else if (release.state !== "ISSUED") reasons.push(`release: state is ${release.state}`);
  }

  return { complete: reasons.length === 0, reasons };
}

module.exports = { verifyScenario, present };
