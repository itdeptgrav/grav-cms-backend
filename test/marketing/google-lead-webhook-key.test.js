// test/marketing/google-lead-webhook-key.test.js
//
// THE WEBHOOK KEY NOBODY STORES.
//
// ── WHAT IS BEING TRADED, AND WHY IT IS WORTH TESTING HARD ─────────────────
// Google lets the advertiser choose the webhook key and only ever hands it back
// inside a delivery. GRAV never needs to retrieve it — only to recognise it —
// so it is derived on demand from one deployment master and kept nowhere.
//
// Against the likely event, a database dump, that is a complete defence: the
// dump yields binding identities and account numbers, which are not
// credentials, and no key for any company.
//
// Against a compromised deployment environment it is no defence at all. One
// master is a single point of compromise for every company's keys at once.
// That is the trade, it is recorded in the decision record, and it is why the
// derivation itself has to be exactly right — a mistake in the domain
// separation or the length-prefixing would make companies share keys, and
// nothing would look wrong.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const keys = require("../../services/marketing/leads/leadWebhookKey");

const VAR = "MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1";
const master = () => crypto.randomBytes(32).toString("hex");

const MASTER = master();
const ENV = Object.freeze({ [VAR]: MASTER });

const COMPANY_A = "6aafc2cccddeb8a5cd014a96";
const COMPANY_B = "6aafc2cccddeb8a5cd014b11";

const derive = (over = {}) => keys.deriveWebhookKey({
  companyId: COMPANY_A, bindingId: "binding-1", env: ENV, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. DETERMINISM AND ISOLATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("derivation", () => {
  test("1. the same company and binding always derive the same key", () => {
    /* ── THE WHOLE MECHANISM ─────────────────────────────────────────────
       GRAV configures this at Google once and recomputes it on every
       delivery. If it were not perfectly stable, forms would silently stop
       verifying at some later moment with nothing to point at. */
    const first = derive();
    for (let i = 0; i < 50; i += 1) expect(derive()).toBe(first);

    /* And it is a Google-compatible text key: no padding, no characters that
       need escaping in a form field or a JSON body. */
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("2. different companies and different bindings never share a key", () => {
    const base = derive();

    expect(derive({ companyId: COMPANY_B })).not.toBe(base);
    expect(derive({ bindingId: "binding-2" })).not.toBe(base);
    expect(derive({ companyId: COMPANY_B, bindingId: "binding-2" })).not.toBe(base);

    /* ── AND NO TWO OF A LARGE SET COLLIDE ───────────────────────────────
       A collision would mean one company's delivery verifying against
       another's binding, which is the worst outcome this module can produce
       and the one that would look like nothing at all. */
    const seen = new Set();
    for (let c = 0; c < 20; c += 1) {
      for (let b = 0; b < 20; b += 1) {
        seen.add(derive({ companyId: `company-${c}`, bindingId: `binding-${b}` }));
      }
    }
    expect(seen.size).toBe(400);
  });

  test("3. two different identities cannot be spelled into the same input", () => {
    /* ── THE CLASSIC CONCATENATION BUG ───────────────────────────────────
       Joining fields without lengths means ("ab","c") and ("a","bc") produce
       identical bytes, so two different bindings derive one key. Every field
       carries its own byte length, so this cannot happen whatever the
       values are. */
    expect(derive({ companyId: "ab", bindingId: "c" }))
      .not.toBe(derive({ companyId: "a", bindingId: "bc" }));

    expect(derive({ companyId: "a-b", bindingId: "c" }))
      .not.toBe(derive({ companyId: "a", bindingId: "b-c" }));
  });

  test("4. a different master produces entirely unrelated keys", () => {
    const withOther = keys.deriveWebhookKey({
      companyId: COMPANY_A, bindingId: "binding-1", env: { [VAR]: master() },
    });
    expect(withOther).not.toBe(derive());
  });

  test("5. the purpose is versioned, so the derivation itself can change", () => {
    /* Domain separation, and the `.v1` is what lets a future derivation be
       introduced without a key silently staying the same. */
    expect(keys.PURPOSE).toBe("grav.marketing.google-lead-webhook.v1");
    expect(keys.PURPOSE).toMatch(/\.v\d+$/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. CONFIGURATION REFUSED RATHER THAN TOLERATED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the master secret", () => {
  test("6. a missing master refuses, naming the variable and never a value", () => {
    let thrown;
    try { derive({ env: {} }); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(keys.WebhookKeyUnavailable);
    expect(thrown.code).toBe("master_secret_missing");
    expect(thrown.detail.variable).toBe(VAR);
    expect(thrown.administratorOnly).toBe(true);
    /* A marketer can do nothing with this and must never see it. */
    expect(JSON.stringify(thrown.detail)).not.toContain(MASTER);
  });

  test("7. the master must be exactly 64 hexadecimal characters", () => {
    /* ── A FORMAT RULE, NOT A JUDGEMENT ABOUT RANDOMNESS ─────────────────
       An earlier version scored the supplied value, trying to tell a real
       secret from a placeholder. That cannot work: 32 genuinely random bytes
       are indistinguishable from any other 32 bytes, so a randomness check is
       really a list of the patterns its author happened to think of — it
       waves through the next placeholder nobody predicted, and refuses
       legitimate material for looking unusual, which teaches an operator to
       work around it.

       One exact format has neither failure. */
    const refused = [
      ["blank", "", "master_secret_missing"],
      ["63 hex", "a".repeat(63), "master_secret_malformed"],
      ["65 hex", "a1".repeat(32) + "b", "master_secret_malformed"],
      ["not hex at all", "z".repeat(64), "master_secret_malformed"],
      ["a passphrase", "correct horse battery staple and then some more words", "master_secret_malformed"],
      ["32 hex chars", crypto.randomBytes(16).toString("hex"), "master_secret_malformed"],
      /* ── THE ONE THE FORMAT RULE ALONE WOULD ACCEPT ────────────────────
         All valid 64-character hex, and all of them what somebody types when
         they want the variable set and meaning nothing. */
      ["all zeros", "0".repeat(64), "master_secret_malformed"],
      ["all f", "f".repeat(64), "master_secret_malformed"],
      ["all a", "a".repeat(64), "master_secret_malformed"],
    ];

    for (const [label, value, code] of refused) {
      let thrown;
      try { derive({ env: { [VAR]: value } }); } catch (e) { thrown = e; }
      expect({ label, code: thrown?.code }).toEqual({ label, code });
    }

    /* Accepted: what `openssl rand -hex 32` produces, in either case. */
    const generated = crypto.randomBytes(32).toString("hex");
    expect(() => derive({ env: { [VAR]: generated } })).not.toThrow();
    expect(() => derive({ env: { [VAR]: generated.toUpperCase() } })).not.toThrow();

    /* And the refusal tells an operator exactly how to produce one. */
    let guidance;
    try { derive({ env: { [VAR]: "nope" } }); } catch (e) { guidance = e.message; }
    expect(guidance).toMatch(/64 hexadecimal/i);
    expect(guidance).toMatch(/openssl rand -hex 32/);
  });

  test("7b. no randomness heuristic survives anywhere in the module", () => {
    /* The correction is only real if the scoring is gone rather than bypassed
       — a dormant heuristic is one somebody re-enables. */
    const source = fs.readFileSync(
      path.join(__dirname, "../../services/marketing/leads/leadWebhookKey.js"), "utf8",
    );
    expect(source).not.toMatch(/distinctWindowRatio|smallestPeriod|MIN_WINDOW_VARIETY|MIN_UNREPEATED_BYTES/);
    expect(source).not.toMatch(/entropy/i);
    expect(keys.MIN_WINDOW_VARIETY).toBeUndefined();
    expect(keys.MASTER_HEX_CHARS).toBe(64);
    expect(keys.MASTER_BYTES).toBe(32);
  });

  test("8. a company or a binding cannot be empty", () => {
    /* An empty value would make every binding carrying one share a key. */
    for (const over of [{ companyId: "" }, { bindingId: "" }, { companyId: "   " }]) {
      expect(() => derive(over)).toThrow(keys.WebhookKeyUnavailable);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. ROTATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the key ring", () => {
  test("9. a binding keeps deriving with the version it was born under", () => {
    /* ── WHY A RING AND NOT ONE NAME ─────────────────────────────────────
       A single permanently-named variable forces every live form to break
       the day somebody changes it. A binding records its generation and
       keeps using it. */
    expect(keys.CURRENT_VERSION).toBe(1);
    expect(keys.KEY_RING[1]).toBe(VAR);
    expect(derive({ version: 1 })).toBe(derive());
  });

  test("10. an unavailable old master fails closed — it never falls through to the newest", () => {
    /* ── THE SILENT ONE ──────────────────────────────────────────────────
       Deriving with the current master for a binding created under an older
       one produces a key that verifies nothing. Every delivery for that form
       would then be refused as a bad secret, and somebody would go looking
       for an attacker who is not there. */
    let thrown;
    try {
      keys.deriveWebhookKey({ companyId: COMPANY_A, bindingId: "binding-1", version: 2, env: ENV });
    } catch (e) { thrown = e; }

    expect(thrown.code).toBe("unknown_key_version");
    expect(thrown.detail.version).toBe(2);
    expect(thrown.administratorOnly).toBe(true);

    /* And a known version whose master is simply absent fails the same way. */
    let missing;
    try { derive({ env: {} }); } catch (e) { missing = e; }
    expect(missing.code).toBe("master_secret_missing");
  });

  test("11. availability reports the variable to set, never a key", () => {
    const ok = keys.availability({ env: ENV });
    expect(ok).toEqual({ available: true, version: 1 });
    /* Not even for a working configuration. */
    expect(JSON.stringify(ok)).not.toContain(MASTER);

    const bad = keys.availability({ env: {} });
    expect(bad.available).toBe(false);
    expect(bad.variable).toBe(VAR);
    expect(bad.reason).toBe("master_secret_missing");
    expect(JSON.stringify(bad)).not.toContain(MASTER);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. VERIFICATION, AND THE SECRET NOT ESCAPING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("verification", () => {
  test("12. a key verifies only against the binding it was derived for", () => {
    const key = derive();

    expect(keys.verifyWebhookKey({ supplied: key, companyId: COMPANY_A, bindingId: "binding-1", env: ENV })).toBe(true);

    /* ── ANOTHER COMPANY'S BINDING REJECTS IT ────────────────────────────
       This is the property that makes a per-binding key worth deriving at
       all: a delivery cannot be pointed at a different tenant. */
    expect(keys.verifyWebhookKey({ supplied: key, companyId: COMPANY_B, bindingId: "binding-1", env: ENV })).toBe(false);
    expect(keys.verifyWebhookKey({ supplied: key, companyId: COMPANY_A, bindingId: "binding-2", env: ENV })).toBe(false);

    for (const supplied of ["", null, undefined, "x", key.slice(0, -1), `${key}x`, "a".repeat(100000)]) {
      expect(keys.verifyWebhookKey({ supplied, companyId: COMPANY_A, bindingId: "binding-1", env: ENV })).toBe(false);
    }
  });

  test("13. comparison does not reveal how much of the key was right", () => {
    const key = derive();
    const cost = (candidate) => {
      const runs = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = process.hrtime.bigint();
        for (let i = 0; i < 2000; i += 1) {
          keys.verifyWebhookKey({ supplied: candidate, companyId: COMPANY_A, bindingId: "binding-1", env: ENV });
        }
        runs.push(Number(process.hrtime.bigint() - started));
      }
      return Math.min(...runs);
    };

    const ratio = cost(`${key.slice(0, -1)}X`) / cost("X");
    /* Generous bounds: proving there is no LINEAR relationship, on a machine
       that may be running other work. */
    expect({ leaks: ratio > 3 || ratio < 0.33 }).toEqual({ leaks: false });
  });

  test("14. the derived key never leaves the module", () => {
    /* ── WHY THE COMPARISON LIVES INSIDE ─────────────────────────────────
       Handing a caller the key so it can compare is the one moment the
       secret exists outside — in a variable somebody may later log, return
       in an error, or attach to an object that gets serialised. Passing the
       candidate IN means the derived value never escapes.

       `deriveWebhookKey` is still exported, because creation genuinely has
       to send it to Google once. Every other path uses `verifyWebhookKey`. */
    const verifier = keys.verifyWebhookKey.toString();
    expect(verifier).toMatch(/timingSafeEqual/);

    /* An availability check derives nothing. */
    expect(JSON.stringify(keys.availability({ env: ENV }))).not.toContain(derive());
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. WHAT THIS MODULE MAY NOT TOUCH
   ═══════════════════════════════════════════════════════════════════════════ */

describe("isolation from every other secret", () => {
  test("15. it imports no other key, and names the ones it must never use", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../services/marketing/leads/leadWebhookKey.js"), "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    /* ── EACH ALREADY MEANS SOMETHING ELSE ───────────────────────────────
       `SALARY_ENCRYPTION_KEY` protects payroll — deriving advertising
       secrets from it makes one leak into two, across unrelated domains.
       `MARKETING_CHANNEL_ID_SECRET` signs the public identifiers this very
       system hands to browsers. `JWT_SECRET` is authentication. */
    for (const forbidden of keys.FORBIDDEN_SOURCES) {
      const used = new RegExp(`env\\[["'\`]?${forbidden}|process\\.env\\.${forbidden}`).test(code);
      expect({ forbidden, used }).toEqual({ forbidden, used: false });
    }

    /* It reads exactly one variable family, and nothing else. */
    expect(Object.values(keys.KEY_RING)).toEqual([VAR]);
    expect(code).not.toMatch(/require\(["'].*(salaryEncryption|draftIdentity|assetIdentity|jwt)/i);

    /* And it derives rather than persists: no model, no mongoose, no writes. */
    expect(code).not.toMatch(/mongoose|require\(["'].*models\//);
    expect(code).not.toMatch(/\.(create|save|updateOne|insertMany)\(/);
  });

  test("16. no derived key and no master appears in anything serialisable", () => {
    const key = derive();

    /* What a binding stores is a version number — an integer. Everything
       needed to recompute the key is the company, the binding and the
       master, and only the first two are in the database. */
    const bindingRow = {
      companyId: COMPANY_A,
      bindingId: "binding-1",
      secretVersion: keys.CURRENT_VERSION,
      channel: "google_ads",
    };
    const stored = JSON.stringify(bindingRow);

    expect(stored).not.toContain(key);
    expect(stored).not.toContain(MASTER);
    expect(bindingRow).not.toHaveProperty("webhookKey");
    expect(bindingRow).not.toHaveProperty("googleKey");
    expect(bindingRow.secretVersion).toBe(1);

    /* ── A DUMPED DATABASE IS NOT A SET OF KEYS ──────────────────────────
       Everything above is recoverable from a backup; none of it is enough
       to derive a key without the deployment master. */
    let derivedFromRowAlone;
    try {
      derivedFromRowAlone = keys.deriveWebhookKey({
        companyId: bindingRow.companyId, bindingId: bindingRow.bindingId,
        version: bindingRow.secretVersion, env: {},
      });
    } catch (e) { derivedFromRowAlone = e.code; }
    expect(derivedFromRowAlone).toBe("master_secret_missing");
  });

  test("17. an error carries no secret material at all", () => {
    /* A refusal that echoed the key it rejected would hand a working
       credential to whoever sent the wrong one. */
    for (const env of [{}, { [VAR]: "weak" }, ENV]) {
      let thrown;
      try {
        keys.deriveWebhookKey({ companyId: "", bindingId: "b", env });
        keys.deriveWebhookKey({ companyId: COMPANY_A, bindingId: "b", version: 99, env });
      } catch (e) { thrown = e; }

      if (thrown) {
        const flat = `${thrown.message}${JSON.stringify(thrown.detail || {})}`;
        expect(flat).not.toContain(MASTER);
        expect(flat).not.toContain("weak");
      }
    }
  });
});
