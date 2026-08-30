"use strict";
/**
 * Free reverse geocoding (lat/lng → human place name) via OpenStreetMap's
 * Nominatim. No API key or billing — used while the Google Maps key isn't set
 * yet. Swappable later: only this file talks to the geocoder.
 *
 * Nominatim's usage policy requires: an identifying User-Agent, at most ~1
 * request/second, and no bulk hammering. We honour that with a global throttle
 * and a rounded-coordinate cache (points within ~100 m reuse one lookup), so a
 * whole duty of pings costs only a handful of real requests.
 */
const axios = require("axios");

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "GravEmployeeTracker/1.0 (internal field-tracking)";
const MIN_INTERVAL_MS = 1100; // ≥1s between calls, per Nominatim policy
const CACHE_MAX = 5000;

const cache = new Map(); // key "lat,lng" (3dp) → { displayName, short }
let lastCallAt = 0;
let chain = Promise.resolve(); // serialises calls so the throttle actually holds

function keyFor(lat, lng) {
  // 3 decimal places ≈ 110 m — plenty for a "where is this rep" label.
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function shorten(addr, displayName) {
  if (!addr) return displayName || "";
  const parts = [
    addr.amenity || addr.building || addr.shop || addr.office,
    addr.road || addr.pedestrian || addr.footway,
    addr.neighbourhood || addr.suburb || addr.hamlet,
    addr.city_district || addr.city || addr.town || addr.village,
  ].filter(Boolean);
  // De-dupe consecutive repeats, keep it to ~3 segments.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    if (out.length >= 3) break;
  }
  return out.join(", ") || displayName || "";
}

async function callNominatim(lat, lng) {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  const res = await axios.get(NOMINATIM_URL, {
    params: { format: "jsonv2", lat, lon: lng, zoom: 18, addressdetails: 1 },
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    timeout: 8000,
  });
  const data = res.data || {};
  const displayName = data.display_name || "";
  return { displayName, short: shorten(data.address, displayName) };
}

/**
 * Resolve a place name for a coordinate. Cached + throttled. Returns
 * { displayName, short } or null on failure (callers must tolerate null).
 */
async function reverseGeocode(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
    return null;
  }
  const key = keyFor(lat, lng);
  if (cache.has(key)) return cache.get(key);

  // Serialise through `chain` so concurrent callers still respect the throttle.
  const result = await (chain = chain.then(
    () => callNominatim(lat, lng).catch(() => null),
    () => callNominatim(lat, lng).catch(() => null),
  ));

  if (result && (result.displayName || result.short)) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
  }
  return result;
}

module.exports = { reverseGeocode };
