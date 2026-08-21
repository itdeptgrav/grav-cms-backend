/**
 * Is Brevo willing to accept mail from this server right now?
 *
 * Run after changing anything in the Brevo security settings, instead of
 * creating a test employee to find out:
 *
 *     node scripts/checkBrevo.js
 *
 * Read-only. It calls GET /v3/account, which sends no email, spends no credit
 * and changes nothing — it only asks whether this server's credentials and IP
 * address are accepted. That is exactly the check every send performs first, so
 * a pass here means welcome emails and Send mail will work.
 *
 * The IP it reports on failure is the one BREVO SEES, which is the address to
 * allowlist. It is not necessarily the one this machine believes it has: a VPN,
 * a mobile hotspot or an ISP that hands out rotating IPv6 all change it, and on
 * a connection like that an allowlist entry stops working on its own after a
 * while. If this keeps failing with a DIFFERENT address each time, allowlisting
 * is the wrong fix — either switch the IP restriction off in Brevo or run the
 * backend somewhere with a fixed address.
 */

require("dotenv").config();
const axios = require("axios");
// The SAME outbound connection the real sends use. Without this the check
// could report an address the application never actually leaves from, and send
// somebody off to allowlist the wrong one.
const { brevoAgent, FORCE_IPV4 } = require("../config/brevoAgent");

(async () => {
  const key = process.env.BREVO_API_KEY;

  if (process.env.ENABLE_EMAILS !== "true") {
    console.log("⚠  ENABLE_EMAILS is not \"true\" — this server skips every email before it reaches Brevo.");
    console.log("   Set ENABLE_EMAILS=true in .env, then run this again.\n");
  }
  if (!key) {
    console.log("✗  BREVO_API_KEY is not set in .env. Nothing can send.");
    process.exit(1);
  }

  try {
    const { data } = await axios.get("https://api.brevo.com/v3/account", {
      headers: { "api-key": key, Accept: "application/json" },
      timeout: 15000,
      ...(brevoAgent ? { httpsAgent: brevoAgent } : {}),
    });

    console.log("✓  Brevo accepts this server.\n");
    console.log("   account :", data.email || "—");
    console.log("   company :", data.companyName || "—");

    const email = (data.plan || []).find((p) => p.type !== "sms");
    if (email) {
      const left = email.credits ?? "unlimited";
      console.log("   credits :", left, `(${email.type})`);
      if (typeof left === "number" && left < 20)
        console.log("\n⚠  Very few sending credits left — mail will start failing shortly.");
    }
    console.log("\n   Welcome emails and Send mail will work. Restart the backend if it was running before you fixed this.");
  } catch (e) {
    const status = e.response?.status;
    const message = e.response?.data?.message || e.message;
    console.log("✗  Brevo refused this server.\n");
    console.log("   status  :", status ?? "no response");
    console.log("   message :", message, "\n");

    const ip = String(message).match(
      /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})/i,
    )?.[1];

    if (ip) {
      console.log("   → Brevo sees this server as:", ip);
      console.log("   → Allow THIS address at https://app.brevo.com/security/authorised_ips");
      console.log("     Adding an IP needs a confirmation link emailed to the account owner.");
      console.log("     It does nothing until that link is opened — check spam.");
      if (FORCE_IPV4) {
        console.log("\n     Outbound connections are pinned to IPv4, so this address is stable");
        console.log("     and one entry is enough. Run this again after allowing it.");
      } else {
        console.log("\n     ⚠  BREVO_FORCE_IPV4=false, so this machine may reach Brevo from a");
        console.log("        DIFFERENT address next time and be refused again. Remove that");
        console.log("        setting to pin it, or switch the IP restriction off in Brevo.");
      }
    } else if (status === 401) {
      console.log("   → The key in BREVO_API_KEY was rejected. Reissue it in Brevo under SMTP & API.");
    }
    process.exit(1);
  }
})();
