/**
 * Universal link previews — fetch a public URL and pull out whatever
 * metadata it publishes (Open Graph, Twitter Card, plain `<title>`/
 * `<meta name="description">`, an icon), so a chat can unfurl ANY public
 * page without knowing anything about the specific site.
 *
 * This is the classic SSRF surface: "fetch a URL the user gives you" is
 * exactly the shape of request that can be pointed at an internal service
 * (a metadata endpoint, an admin panel on localhost, another container on
 * the same host) instead of the public internet. Every hop — the first
 * request AND every redirect it follows — is re-validated against the
 * private/reserved IP ranges before it is made; nothing here trusts axios's
 * own redirect-following, because a redirect is exactly how a first,
 * innocent-looking public URL can hand back a private address.
 *
 * No site-specific parsing. The same extractor runs for every URL; what
 * differs is only which tags a given page happens to publish.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const dns = require("dns").promises;
const net = require("net");

const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000; // 2 MB — plenty for a page's <head>, cheap to parse
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for a successful unfurl
const CACHE_ERROR_TTL_MS = 5 * 60 * 1000; // 5 minutes for a failure — a flaky site gets retried, not hammered
const CACHE_MAX_ENTRIES = 500;

const USER_AGENT =
  "Mozilla/5.0 (compatible; CoworkLinkPreview/1.0; +https://grav.in) LinkPreviewBot";

class LinkPreviewError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/* ── SSRF guard ────────────────────────────────────────────────────────── */

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

const PRIVATE_V4_RANGES = [
  ["0.0.0.0", "0.255.255.255"], // "this" network
  ["10.0.0.0", "10.255.255.255"], // RFC1918
  ["100.64.0.0", "100.127.255.255"], // carrier-grade NAT
  ["127.0.0.0", "127.255.255.255"], // loopback
  ["169.254.0.0", "169.254.255.255"], // link-local (also the cloud metadata address)
  ["172.16.0.0", "172.31.255.255"], // RFC1918
  ["192.0.0.0", "192.0.0.255"], // IETF protocol assignments
  ["192.0.2.0", "192.0.2.255"], // TEST-NET
  ["192.88.99.0", "192.88.99.255"], // 6to4 relay
  ["192.168.0.0", "192.168.255.255"], // RFC1918
  ["198.18.0.0", "198.19.255.255"], // benchmarking
  ["198.51.100.0", "198.51.100.255"], // TEST-NET-2
  ["203.0.113.0", "203.0.113.255"], // TEST-NET-3
  ["224.0.0.0", "255.255.255.255"], // multicast + reserved
];

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4_RANGES.some(
    ([lo, hi]) => value >= ipv4ToInt(lo) && value <= ipv4ToInt(hi),
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local, fc00::/7
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a recognisable IP at all — refuse rather than guess
}

/**
 * Refuses a hostname that resolves anywhere private — checked by DNS lookup
 * (both address families), not by string-matching the hostname, so a public
 * name that happens to resolve to a private address (DNS rebinding, a
 * misconfigured record, `localtest.me`-style tricks) is still caught.
 */
async function assertPublicHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new LinkPreviewError("blocked_host");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new LinkPreviewError("blocked_host");
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new LinkPreviewError("dns_failed");
  }
  if (!records.length) throw new LinkPreviewError("dns_failed");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new LinkPreviewError("blocked_host");
  }
}

/**
 * Fetch a URL, following redirects by hand — each hop re-validated against
 * the SSRF guard before it is requested, which is the part `axios`'s own
 * `maxRedirects` cannot do for us. `validateStatus` accepts 2xx and 3xx so a
 * redirect comes back as an ordinary response (with `maxRedirects: 0`, axios
 * does not follow it itself) instead of throwing.
 */
async function safeFetch(startUrl) {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new LinkPreviewError("bad_scheme");
    }
    await assertPublicHost(current.hostname);

    let response;
    try {
      response = await axios.get(current.href, {
        timeout: FETCH_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
        responseType: "text",
        decompress: true,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,image/*,video/*,*/*;q=0.7",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      if (e.code === "ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED" || e.code === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED") {
        throw new LinkPreviewError("too_large");
      }
      if (e.code === "ECONNABORTED") throw new LinkPreviewError("timeout");
      throw new LinkPreviewError("fetch_failed");
    }

    if (response.status >= 300) {
      const location = response.headers.location;
      if (!location) throw new LinkPreviewError("bad_redirect");
      try {
        current = new URL(location, current);
      } catch {
        throw new LinkPreviewError("bad_redirect");
      }
      continue;
    }

    return { finalUrl: current.href, response };
  }
  throw new LinkPreviewError("too_many_redirects");
}

/* ── Extraction ────────────────────────────────────────────────────────── */

/**
 * Resolve a possibly-relative URL against the page it came from, http(s)
 * only. A page is free to publish an icon or an image as a `data:` URI (or,
 * as `example.com` itself does, the empty `data:,`) — those are refused
 * rather than handed to the frontend as an `<img src>`, since a `data:` URI
 * that size-limited extraction truncated mid-string would render broken.
 */
function absolutize(href, baseUrl) {
  if (!href) return null;
  try {
    const u = new URL(href, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function clip(text, max) {
  if (!text) return null;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Every field is read from whichever tag publishes it, in the order sites
 * most commonly agree on (Open Graph first — it's the de facto standard for
 * link unfurling — then Twitter's own card tags, then the plain HTML a page
 * has regardless of whether it was built to be shared). Nothing here is
 * conditioned on the domain; a news article, a product page, a repo and a
 * job listing all go through the exact same four lookups per field.
 */
function extractMetadata(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (name) =>
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    null;

  const title = meta("og:title") || meta("twitter:title") || $("title").first().text() || null;
  const description = meta("og:description") || meta("twitter:description") || meta("description") || null;
  const image =
    meta("og:image:secure_url") || meta("og:image") || meta("twitter:image") || meta("twitter:image:src") || null;
  const siteName = meta("og:site_name");

  const iconRels = new Set(["icon", "shortcut icon", "apple-touch-icon", "apple-touch-icon-precomposed"]);
  let favicon = null;
  let bestSize = -1;
  $("link").each((_, el) => {
    const rel = ($(el).attr("rel") || "").toLowerCase().trim();
    if (!iconRels.has(rel)) return;
    const href = $(el).attr("href");
    if (!href) return;
    const sizesAttr = $(el).attr("sizes") || "";
    const match = /(\d+)x\d+/.exec(sizesAttr);
    const size = match ? Number(match[1]) : 0;
    if (size >= bestSize) {
      bestSize = size;
      favicon = href;
    }
  });

  return {
    title: clip(title, 300),
    description: clip(description, 500),
    image: absolutize(image, baseUrl),
    favicon: absolutize(favicon, baseUrl) || absolutize("/favicon.ico", baseUrl),
    siteName: clip(siteName, 120),
  };
}

function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ── Cache ─────────────────────────────────────────────────────────────── */

const cache = new Map(); // url -> { at, ttl, data }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // recency bump — cheap LRU
  return hit.data;
}

function cacheSet(key, data, ttl) {
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttl, data });
}

/* ── Entry point ───────────────────────────────────────────────────────── */

function normalizeInputUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Unfurl one URL. Never throws — every failure (invalid input, a blocked
 * host, a timeout, a broken site, a page with nothing to show) comes back as
 * `{ ok: false }` so a caller's logic is one `if`, and a chat message that
 * links somewhere unreachable still sends as a plain link rather than
 * failing to send at all.
 */
async function getLinkPreview(rawUrl) {
  const url = normalizeInputUrl(rawUrl);
  if (!url) return { ok: false, url: typeof rawUrl === "string" ? rawUrl : "", domain: null, reason: "invalid_url" };

  const cached = cacheGet(url);
  if (cached) return cached;

  const domain = domainOf(url);
  let result;
  try {
    const { finalUrl, response } = await safeFetch(url);
    const finalDomain = domainOf(finalUrl) || domain;
    const contentType = String(response.headers["content-type"] || "").toLowerCase();

    if (contentType.startsWith("image/")) {
      result = {
        ok: true,
        url,
        finalUrl,
        domain: finalDomain,
        title: filenameFromUrl(finalUrl),
        description: null,
        image: finalUrl,
        favicon: null,
        siteName: finalDomain,
      };
    } else if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
      result = {
        ok: true,
        url,
        finalUrl,
        domain: finalDomain,
        title: filenameFromUrl(finalUrl),
        description: null,
        image: null,
        favicon: null,
        siteName: finalDomain,
      };
    } else if (contentType.includes("html")) {
      const meta = extractMetadata(String(response.data), finalUrl);
      result = { ok: true, url, finalUrl, domain: finalDomain, ...meta, siteName: meta.siteName || finalDomain };
    } else {
      result = {
        ok: true,
        url,
        finalUrl,
        domain: finalDomain,
        title: null,
        description: null,
        image: null,
        favicon: null,
        siteName: finalDomain,
      };
    }
    cacheSet(url, result, CACHE_TTL_MS);
  } catch (e) {
    result = { ok: false, url, domain, reason: e instanceof LinkPreviewError ? e.code : "fetch_failed" };
    cacheSet(url, result, CACHE_ERROR_TTL_MS);
  }
  return result;
}

module.exports = {
  getLinkPreview,
  // Exported for tests only.
  _internal: { isPrivateIp, isPrivateIPv4, isPrivateIPv6, normalizeInputUrl, extractMetadata, domainOf },
};
