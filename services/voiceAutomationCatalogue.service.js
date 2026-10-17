"use strict";

const PLATFORM_VERSION = 1;

const MODES = Object.freeze([
  {
    key: "decision",
    name: "Decision calls",
    description: "One authorised record, a proposed action, read-back and a separate confirmation before commit.",
  },
  {
    key: "briefing",
    name: "Briefings",
    description: "Read-only, prioritised summaries with repeat, skip, next and open-in-app controls.",
  },
  {
    key: "reminder",
    name: "Reminders",
    description: "A due item or live queue with open, snooze, dismiss and per-type opt-out.",
  },
]);

const POLICIES = Object.freeze({
  routineOptIn: true,
  quietHoursRequired: true,
  dailyCallCapRequired: true,
  perWorkflowCooldownRequired: true,
  separateDecisionConfirmation: true,
  rawAudioRecordedByDefault: false,
  fallback: "Normal notification and application queue",
  webClosedTabDelivery: "Best effort",
  forceQuitDelivery: "Requires native iOS/Android delivery adapter",
});

function mrfState(health) {
  if (health?.ready) return { status: "live", label: "Live", nextGate: "Preserve parity while extracting the shared foundation." };
  if (health?.enabled) return {
    status: "needs_attention",
    label: "Needs attention",
    nextGate: health.missing?.length ? `Missing: ${health.missing.join(", ")}` : "Complete the current MRF voice setup.",
  };
  return { status: "disabled", label: "Disabled", nextGate: "Enable only after the worker and delivery path are ready." };
}

function catalogue({ voiceHealth = { enabled: false, ready: false, missing: [] } } = {}) {
  const currentMrf = mrfState(voiceHealth);
  return [
    {
      key: "mrf_approval",
      name: "MRF approval",
      mode: "decision",
      owner: "Requests",
      trigger: "Assigned material request reaches its approver",
      dataSource: "MRF item approval service",
      ...currentMrf,
      testable: Boolean(voiceHealth.ready),
    },
    {
      key: "morning_brief",
      name: "Morning brief",
      mode: "briefing",
      owner: "Employee Home",
      trigger: "User-selected local time on working days",
      dataSource: "employeeHome.service.homeFor(actor)",
      status: voiceHealth.ready ? "pilot" : "needs_attention",
      label: voiceHealth.ready ? "Pilot ready" : "Voice runtime needed",
      nextGate: voiceHealth.ready
        ? "Enable a personal schedule or run a call-now test; delivery is read-only and once per local date."
        : "Restore the shared LiveKit voice runtime before enabling a schedule.",
      testable: Boolean(voiceHealth.ready),
    },
    {
      key: "work_reminders",
      name: "Work reminders",
      mode: "reminder",
      owner: "Notifications",
      trigger: "Opted-in unresolved queue or personal reminder",
      dataSource: "pendingReminders live counters",
      status: "ready_for_build",
      label: "Ready for build",
      nextGate: "Add durable snooze, cooldown and daily-cap enforcement.",
      testable: false,
    },
    {
      key: "manager_leave",
      name: "Manager leave decision",
      mode: "decision",
      owner: "HR · Manager queue",
      trigger: "Leave reaches the assigned primary or secondary manager",
      dataSource: "Manager leave assignment boundary",
      status: "domain_gate",
      label: "Domain gate",
      nextGate: "Extract a tested manager decision service without flattening primary and secondary stages.",
      testable: false,
    },
    {
      key: "hr_leave",
      name: "HR final leave decision",
      mode: "decision",
      owner: "HR",
      trigger: "Leave is eligible for final HR action",
      dataSource: "LEAVE_DECIDE_HR boundary",
      status: "domain_gate",
      label: "Domain gate",
      nextGate: "Extract a separate final-decision service and preserve the manager-first rule.",
      testable: false,
    },
    {
      key: "controlled_expansion",
      name: "Later approval workflows",
      mode: "decision",
      owner: "Regularisation · Overtime · Departments · Accounting",
      trigger: "Only after each domain adapter is reviewed",
      dataSource: "Existing source-domain queues",
      status: "later",
      label: "Later",
      nextGate: "Each workflow needs its own authority, privacy, confirmation and concurrency tests.",
      testable: false,
    },
  ];
}

function snapshot({ voiceHealth, recentAttempts = [] } = {}) {
  const workflows = catalogue({ voiceHealth });
  const installedLanguages = new Set(voiceHealth?.languages || ["en"]);
  return {
    schemaVersion: PLATFORM_VERSION,
    platform: {
      name: "GRAV Voice Automation",
      stage: "foundation",
      liveWorkflows: workflows.filter((row) => row.status === "live").length,
      plannedWorkflows: workflows.filter((row) => row.status !== "live").length,
      languages: [
        { code: "en", name: "English", available: installedLanguages.has("en") },
        { code: "hi", name: "Hindi", available: installedLanguages.has("hi"), ...(!installedLanguages.has("hi") ? { reason: "IndicF5 Hindi is not enabled." } : {}) },
        { code: "or", name: "Odia", available: installedLanguages.has("or"), ...(!installedLanguages.has("or") ? { reason: "IndicF5 Odia is not enabled." } : {}) },
      ],
    },
    modes: MODES,
    policies: POLICIES,
    health: { mrf: voiceHealth },
    workflows,
    recentAttempts,
  };
}

module.exports = { MODES, POLICIES, catalogue, snapshot };

