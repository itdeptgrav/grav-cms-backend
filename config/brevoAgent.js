/**
 * The connection every Brevo call goes out on.
 *
 * ## Why this exists: IPv4, deliberately
 *
 * Brevo can restrict an account to a list of authorised IP addresses, and a
 * dual-stack machine does not have one address — it has two, and picks between
 * them per connection. On the machine this was written for, the same request
 * repeated reached Brevo as `2001:df0:2d00:cf9b:…` most times and `45.114.49.178`
 * on others, so an allowlist entry for either one left a share of every send
 * being refused with:
 *
 *     We have detected you are using an unrecognised IP address …
 *
 * Worse, the IPv6 half is an ISP-assigned residential prefix: it rotates on its
 * own schedule, so allowlisting it works for a few days and then quietly stops.
 *
 * Pinning the family to 4 makes the address **one thing, and a stable thing**.
 * Measured on that machine: three consecutive calls, same IPv4 address, while
 * the unpinned calls alternated. One allowlist entry then holds.
 *
 * ## When to turn it off
 *
 * `BREVO_FORCE_IPV4=false` restores the default dual-stack behaviour. Set that
 * on a host with no IPv4 route to the internet — rare, and it would fail loudly
 * with ENETUNREACH rather than silently. It is also unnecessary (but harmless)
 * on any host with a static address, or where the Brevo IP restriction is off.
 *
 * This changes nothing about what is sent, only which of this machine's own
 * addresses the connection leaves from.
 */

const https = require("https");

/** Whether outbound Brevo connections are pinned to IPv4. */
const FORCE_IPV4 = process.env.BREVO_FORCE_IPV4 !== "false";

/**
 * Shared agent, so connections are pooled rather than one per email.
 *
 * `null` when unpinned — axios then uses its own default agent, which is the
 * behaviour every caller had before this module existed.
 */
const brevoAgent = FORCE_IPV4
  ? new https.Agent({ family: 4, keepAlive: true })
  : null;

module.exports = { brevoAgent, FORCE_IPV4 };
