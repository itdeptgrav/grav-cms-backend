"use strict";

const { transcribeUtterance, getReadiness } = require("../ai/gravSpeechClient");

const SERVICE = "hr-interview";

/**
 * HR has no browser-trusted tenant selector. Use the actor's active company
 * grant, resolved by hrContract from server-side access records. This legacy
 * deployment has one organisation and no company-scoped HR grants yet, so its
 * safe fallback is the one active Acc_Company row. More than one active
 * company without an actor grant is ambiguous and therefore refused.
 */
async function trustedCompanyId(req, { companyModel } = {}) {
  const grants = req?.hrAuth?.actor?.departmentRole?.companyGrants || [];
  const active = grants.filter((grant) => grant?.isActive !== false && grant?.companyId);
  if (active.length === 1) return String(active[0].companyId);
  if (active.length > 1) {
    const error = new Error("A single active company grant is required to transcribe interview audio.");
    error.code = "HR_COMPANY_CONTEXT_REQUIRED";
    error.status = 409;
    throw error;
  }

  const Company = companyModel || require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;
  const companies = await Company.find({ isActive: { $ne: false } }).select("_id").limit(2).lean();
  if (companies.length === 1) return String(companies[0]._id);

  const error = new Error("A single active company is required to transcribe interview audio.");
  error.code = "HR_COMPANY_CONTEXT_REQUIRED";
  error.status = 409;
  throw error;
}

async function transcribeAnswer({ req, file, client = transcribeUtterance }) {
  if (!file?.buffer?.length) {
    const error = new Error("A recorded answer is required.");
    error.code = "INVALID_INPUT";
    error.status = 400;
    throw error;
  }
  const companyId = await trustedCompanyId(req);
  return client({
    service: SERVICE,
    companyId,
    audio: file.buffer,
    filename: String(file.originalname || "interview-answer.webm").replace(/[\r\n]/g, "").slice(0, 180),
  });
}

function configured() {
  return Boolean(process.env.GRAV_SPEECH_API_URL && process.env.GRAV_SPEECH_SHARED_SECRET);
}

async function health() {
  return getReadiness();
}

module.exports = { transcribeAnswer, trustedCompanyId, configured, health, SERVICE };
