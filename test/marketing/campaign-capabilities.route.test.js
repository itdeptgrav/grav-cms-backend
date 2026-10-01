// test/marketing/campaign-capabilities.route.test.js
//
// THE CAPABILITY MATRIX.
//
// ── WHAT THIS IS PROTECTING ────────────────────────────────────────────────
// Two failures, and the second is the one that costs money.
//
//   A builder that shows the same form for every channel. A marketer types a
//   job title into a Google Search campaign, GRAV accepts it, and the campaign
//   runs against nothing. The field existed, so it looked like a setting.
//
//   A declaration that quietly becomes permission. This file declares campaign
//   types GRAV cannot create and lifecycle states nothing can reach. If
//   declaring them ever enabled them, a contract written to describe the
//   future would have shipped the future — including the parts that spend
//   money. Most of the second half of this file is that boundary.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const caps = require("../../constants/marketingCampaignCapabilities");
const readiness = require("../../constants/marketingDeploymentReadiness");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };

let app; let server; let base;

beforeAll(async () => {
  app = express();
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignCapabilities"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = async (p, { user = MARKETER } = {}) => {
  const res = await fetch(`${base}${p}`, {
    headers: user ? { "x-test-user": JSON.stringify(user) } : {},
  });
  return { status: res.status, body: await res.json() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE MATRIX IS COMPLETE AND HONEST
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the matrix", () => {
  test("1. every deployable type answers for every setting, with a reason where it is limited", async () => {
    const { status, body } = await call("/campaign-capabilities");
    expect(status).toBe(200);

    const deployable = body.campaignTypes.filter((t) => t.deployable);
    expect(deployable.length).toBeGreaterThan(0);

    for (const type of deployable) {
      /* ── NO SILENT GAPS ──────────────────────────────────────────────────
         A setting missing from a column is a question the builder has to
         answer by guessing, and guessing is the whole failure. */
      expect(type.settings.map((s) => s.code).sort()).toEqual([...caps.SETTING_CODES].sort());

      for (const s of type.settings) {
        expect(s.label).toBeTruthy();
        expect(s.means).toBeTruthy();
        expect(caps.SUPPORT_CODES).toContain(s.support);
        expect(typeof s.settable).toBe("boolean");

        /* Anything not plainly supported must say why. A disabled field with
           no reason is the thing a marketer escalates. */
        if (!["required", "supported"].includes(s.support)) {
          expect({ code: s.code, why: String(s.why || "") }).toMatchObject({
            code: s.code, why: expect.stringMatching(/.{20,}/),
          });
        }
      }
    }
  });

  test("2. the two channels are never described as having the same settings", async () => {
    const { body } = await call("/campaign-capabilities");
    const google = body.campaignTypes.find((t) => t.campaignType === "google_search");
    const meta = body.campaignTypes.find((t) => t.campaignType === "meta_traffic_single_image");

    const supportOf = (type, code) => type.settings.find((s) => s.code === code).support;

    /* ── THE DIFFERENCES THAT MATTER, EACH ASSERTED ──────────────────────
       Keywords are how a search campaign is aimed and Meta has none of them.
       Age and gender aim a Meta campaign and do not aim a search one. An
       interface that offered all four to both would be lying twice. */
    expect(supportOf(google, "keyword_themes")).toBe("required");
    expect(supportOf(meta, "keyword_themes")).toBe("unavailable");
    expect(supportOf(meta, "negative_keywords")).toBe("unavailable");

    expect(supportOf(meta, "age_range")).toBe("supported");
    expect(supportOf(google, "age_range")).toBe("unavailable");

    expect(supportOf(meta, "image")).toBe("required");
    expect(supportOf(google, "image")).toBe("unavailable");
    expect(supportOf(google, "headlines")).toBe("required");
    expect(supportOf(meta, "primary_text")).toBe("required");

    /* Audience expansion is a required decision on Meta and has no equivalent
       on Search — "broad" must be a choice, not an omission. */
    expect(supportOf(meta, "audience_expansion")).toBe("required");

    /* And the columns genuinely differ. */
    const differing = caps.SETTING_CODES.filter((c) => supportOf(google, c) !== supportOf(meta, c));
    expect(differing.length).toBeGreaterThan(8);
  });

  test("3. firmographics are never offered as a targeting field on either channel", async () => {
    const { body } = await call("/campaign-capabilities");

    for (const type of body.campaignTypes.filter((t) => t.deployable)) {
      for (const code of ["job_role", "job_seniority", "industry", "company_size"]) {
        const s = type.settings.find((x) => x.code === code);

        /* ── THE SETTING A B2B MARKETER REACHES FOR FIRST ────────────────
           No channel verifies where somebody works. What they offer under
           these names is self-reported profile data, so a campaign aimed at
           procurement managers reaches people who once showed an interest in
           procurement. It is reachable — by supplying a list — and that is a
           different answer from "no". */
        expect({ type: type.campaignType, code, support: s.support })
          .toEqual({ type: type.campaignType, code, support: "requires_external_audience" });
        expect(s.settable).toBe(false);
        expect(s.why).toMatch(/verifies|self-reported|list you supply/i);
      }
    }
  });

  test("4. a setting GRAV has not built is distinguished from one a channel cannot do", async () => {
    const { body } = await call("/campaign-capabilities/google_search");

    /* ── THREE DIFFERENT "NO"s ───────────────────────────────────────────
       Telling a marketer that radius targeting is "unavailable" makes them
       stop asking for something Google does and GRAV could add. Telling them
       placements are "not modelled" implies work that will never happen. */
    const radius = body.settings.find((s) => s.code === "geo_radius");
    expect(radius.support).toBe("not_modelled");

    const placements = body.settings.find((s) => s.code === "placement_control");
    expect(placements.support).toBe("unavailable");
    expect(placements.why).toMatch(/search results/i);

    const frequency = body.settings.find((s) => s.code === "frequency_cap");
    expect(frequency.support).toBe("unavailable");

    const currency = body.settings.find((s) => s.code === "currency");
    expect(currency.support).toBe("externally_verified");

    /* Each has a distinct meaning a screen can render. */
    const states = Object.fromEntries(body.supportStates.map((s) => [s.code, s.means]));
    expect(new Set(Object.values(states)).size).toBe(body.supportStates.length);
  });

  test("5. the builder's steps are ordered and every setting belongs to one", async () => {
    const { body } = await call("/campaign-capabilities");

    expect(body.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.steps.map((s) => s.code)).toEqual([
      "goal", "channel", "audience", "budget", "creative", "tracking", "review", "approval",
    ]);

    const stepCodes = body.steps.map((s) => s.code);
    for (const type of body.campaignTypes.filter((t) => t.deployable)) {
      for (const s of type.settings) expect(stepCodes).toContain(s.section);
      /* Grouped, so a step can be rendered without filtering client-side. */
      const grouped = type.sections.flatMap((sec) => sec.settings);
      expect(grouped.sort()).toEqual(type.settings.map((s) => s.code).sort());
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. DECLARING IS NOT PERMITTING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the boundary", () => {
  test("6. declaring lead-form campaign types does not make one creatable", async () => {
    const { body } = await call("/campaign-capabilities");

    for (const code of ["google_lead_form", "meta_lead_form"]) {
      const type = body.campaignTypes.find((t) => t.campaignType === code);
      expect(type).toBeTruthy();
      expect(type.deployable).toBe(false);

      /* ── THE EXISTING SCOPE, PRESERVED ───────────────────────────────────
         GRAV models no channel-hosted lead form. Enquiries would be collected
         by the provider and reach nobody, because there is nothing to deliver
         them into. Declaring the type records what is missing; it does not
         create it. */
      expect(type.blockedBy).toMatch(/lead form|reach nobody|nowhere to go/i);
      expect(type.needs.length).toBeGreaterThan(0);

      /* No settings column: publishing one would describe a form that leads
         nowhere. */
      expect(type.settings).toEqual([]);
      expect(type.sections).toEqual([]);
    }

    expect(body.deployableCampaignTypes).toEqual(["google_search", "meta_traffic_single_image"]);
  });

  test("7. the deployable set is exactly what the existing creation contract already allowed", async () => {
    /* ── THIS FILE ENABLED NOTHING ───────────────────────────────────────
       The capability matrix is a declaration. If it ever disagreed with the
       contract that actually creates campaigns, the disagreement would be
       resolved in whichever direction somebody noticed last. */
    expect([...caps.DEPLOYABLE_CAMPAIGN_TYPES].sort())
      .toEqual([...readiness.SUPPORTED_CAMPAIGN_TYPE_CODES].sort());

    /* And a declared-but-blocked type is not in the creation contract. */
    for (const code of ["google_lead_form", "meta_lead_form"]) {
      expect(readiness.SUPPORTED_CAMPAIGN_TYPE_CODES).not.toContain(code);
    }
  });

  test("8. no lifecycle state that spends money offers a control", async () => {
    const { body } = await call("/campaign-capabilities");
    const byCode = Object.fromEntries(body.lifecycle.map((l) => [l.code, l]));

    /* Every state is declared, so the read contract needs no redesign when
       activation arrives. */
    for (const code of ["draft", "ready_for_review", "awaiting_approval", "approved",
      "scheduled", "active", "paused", "completed", "cancelled", "archived"]) {
      expect(byCode[code]).toBeTruthy();
      expect(byCode[code].means).toBeTruthy();
    }

    /* ── AND NONE OF THE SPENDING ONES IS REACHABLE ──────────────────────
       `scheduled` is the one people miss: a campaign that starts by itself is
       a campaign that begins spending with nobody present. */
    for (const code of ["scheduled", "active", "paused", "completed", "archived"]) {
      expect({ code, reachable: byCode[code].reachable }).toEqual({ code, reachable: false });
      expect({ code, offersControl: byCode[code].offersControl }).toEqual({ code, offersControl: false });
      expect(byCode[code].blockedBy).toBeTruthy();
    }

    expect(byCode.active.blockedBy).toMatch(/activation|spends money/i);
    expect(byCode.scheduled.blockedBy).toMatch(/without anybody present|activation/i);

    /* The ones that exist today do offer controls. */
    for (const code of ["draft", "awaiting_approval", "approved"]) {
      expect(byCode[code].reachable).toBe(true);
    }
  });

  test("9. every response says GRAV creates campaigns stopped", async () => {
    for (const p of ["/campaign-capabilities", "/campaign-capabilities/google_search"]) {
      const { body } = await call(p);
      expect(body.deliveryBoundary).toMatchObject({
        createsDelivering: false,
        offersActivation: false,
      });
      expect(body.deliveryBoundary.means).toMatch(/creates every campaign stopped/i);
    }
  });

  test("10. approved is never described as running or spending", async () => {
    const { body } = await call("/campaign-capabilities");
    const approved = body.lifecycle.find((l) => l.code === "approved");

    /* The sentence that has to survive every future screen. */
    expect(approved.means).toMatch(/Nothing has been created/i);
    expect(approved.means).toMatch(/no money can be spent/i);

    const flat = JSON.stringify(body.lifecycle);
    expect(flat).not.toMatch(/\blaunch\b/i);
    expect(flat).not.toMatch(/\bpublish\b/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE CONTRACT ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the contract", () => {
  test("11. the reads a campaign manager needs are declared, available or not", async () => {
    const { body } = await call("/campaign-capabilities");

    const byCode = Object.fromEntries(body.managementReads.map((r) => [r.code, r]));
    for (const code of ["inventory", "status_schedule", "core_metrics", "cost_per_outcome",
      "daily_trend", "readiness", "approval_history", "change_history", "sales_outcomes",
      "channel_connection", "breakdowns", "budget_pacing", "lead_volume"]) {
      expect(byCode[code]).toBeTruthy();
    }

    /* Available ones name the route that serves them. */
    for (const r of body.managementReads.filter((x) => x.available)) {
      expect(r.servedBy).toMatch(/^GET /);
    }

    /* ── AND THE UNAVAILABLE ONES SAY WHY, HONESTLY ──────────────────────
       "Lead volume" is the one worth reading: GRAV counts prospects handed to
       Sales, not leads attributed to a campaign, and joining the two needs an
       attribution contract nobody has written. Publishing a number here would
       be inventing attribution. */
    for (const r of body.managementReads.filter((x) => !x.available)) {
      expect(r.servedBy).toBeNull();
      expect(String(r.blockedBy).length).toBeGreaterThan(30);
    }
    expect(byCode.lead_volume.blockedBy).toMatch(/attribution/i);
    expect(byCode.breakdowns.blockedBy).toMatch(/do not add up|counted in both/i);
  });

  test("12. the intelligence layer is declared, unimplemented, and never autonomous", async () => {
    const { body } = await call("/campaign-capabilities");

    for (const code of ["targeting_refinement", "negative_keywords", "creative_fatigue",
      "lead_quality", "variant_comparison", "spend_anomaly", "budget_reallocation"]) {
      const item = body.intelligenceReadiness.find((i) => i.code === code);
      expect(item).toBeTruthy();
      expect(item.needsEvidence.length).toBeGreaterThan(0);
      /* ── EVERY ONE REQUIRES A PERSON ──────────────────────────────────
         The existing Campaign Health rule, carried forward: the assistant may
         suggest that somebody looks at something. It may not act. */
      expect({ code, human: item.requiresHumanApproval }).toEqual({ code, human: true });
    }

    expect(body.intelligenceRules).toMatchObject({ callsAModel: false, mayAct: false });

    /* Negative-keyword suggestions are honestly blocked: GRAV does not read
       search terms, so a suggestion would be a guess. */
    expect(body.intelligenceReadiness.find((i) => i.code === "negative_keywords").blockedBy)
      .toMatch(/search terms/i);
  });

  test("13. an unknown campaign type is refused by name, and the known ones listed", async () => {
    const res = await call("/campaign-capabilities/google_performance_max");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/google_performance_max/);
    expect(res.body.message).toMatch(/google_search/);

    const params = await call("/campaign-capabilities?channel=google_ads");
    expect(params.status).toBe(400);
  });

  test("14. it is readable by Marketing and by nobody else", async () => {
    const anon = await fetch(`${base}/campaign-capabilities`);
    expect(anon.status).toBe(401);

    for (const role of ["store_manager", "accountant", ""]) {
      const res = await call("/campaign-capabilities", {
        user: { id: new mongoose.Types.ObjectId().toString(), name: "Outsider", role },
      });
      expect(res.status).toBe(403);
    }
    expect((await call("/campaign-capabilities")).status).toBe(200);
  });

  test("15. it describes only — it imports no provider, writer, model or database", async () => {
    const root = path.join(__dirname, "../..");
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const rel of [
      "routes/CMS_Routes/Marketing/campaignCapabilities.js",
      "constants/marketingCampaignCapabilities.js",
    ]) {
      const src = strip(fs.readFileSync(path.join(root, rel), "utf8"));

      expect({ rel, m: /AdsClient|AdsWriteClient|mauticClient/.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /pausedCreation|observationSync|deployment.*\.service/i.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /gravAiGateway|@google\/genai|GEMINI/.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /mongoose|require\(["'].*models\//.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /\.(create|updateOne|deleteOne|save|insertMany)\(/.test(src) }).toEqual({ rel, m: false });
    }
  });

  test("16. two identical reads are identical, and the matrix is frozen", async () => {
    const first = await call("/campaign-capabilities");
    const second = await call("/campaign-capabilities");
    expect(second.body).toEqual(first.body);

    /* A declaration a caller could mutate is not a declaration. */
    expect(Object.isFrozen(caps.MATRIX)).toBe(true);
    expect(Object.isFrozen(caps.MATRIX.google_search)).toBe(true);
    expect(() => { caps.MATRIX.google_search.keyword_themes = { support: "unavailable" }; })
      .toThrow();
  });
});
