// services/barcodeScanner/announce.js
//
// Publishes this server on the LAN under a NAME, so scanners stop depending on
// the PC's IP address.
//
// ─── Why this exists ──────────────────────────────────────────────────────────
// Every scanner stores the server address in its own flash. That address was a
// raw IP, so each time this PC moved network the stored value went stale and
// every device on the floor showed a red cross — which reads as a device fault,
// not a network one. It happened five times:
//
//   10.1.0.29 -> 10.192.75.179 -> 172.26.59.179 -> 192.168.1.80 -> 10.99.21.119
//
// Each change meant walking the floor with a barcode sheet to re-point 50
// devices. A name is resolved fresh on every connection, so the same devices
// follow the PC automatically wherever it lands.
//
// ─── Why this works on firmware that predates it ──────────────────────────────
// The device builds its URL from whatever string is in NVS:
//
//   "http://" + serverHost + ":" + serverPort + "/api/..."
//
// serverHost is just text — it has never had to be an IP. The ESP32's lwIP
// resolver has mDNS query support compiled in by default, so a ".local" name
// resolves without any firmware change. Scanning SRV:gravserver.local:5001
// therefore works on the 5.5.5 units already in the field.
//
// If the resolver on a given unit turns out not to support it, nothing is lost:
// scan the plain IP barcode again and it is back to where it was.

const os = require("os");

const SERVICE_NAME = process.env.MDNS_NAME || "gravserver";

// OPT-IN, where the standalone server had this opt-OUT.
//
// That server only ever ran on the factory PC, so announcing itself on the LAN
// was always the right thing. This backend also runs on a cloud host, where
// broadcasting mDNS is at best noise on a segment full of other tenants. So it
// stays off unless someone says otherwise — set MDNS_ENABLED=true in the .env
// on the machine the scanners actually talk to.
const ENABLED = process.env.MDNS_ENABLED === "true";

let bonjour = null;
let published = null;
let lastError = null;

/** The LAN address this machine is actually reachable on right now. */
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family !== "IPv4" || i.internal) continue;
      // 169.254.x is a link-local address Windows assigns when DHCP failed —
      // reachable by nothing useful, so never advertise it.
      if (i.address.startsWith("169.254.")) continue;
      return { address: i.address, iface: name };
    }
  }
  return { address: null, iface: null };
}

// How often to check whether this PC's address has changed under us.
const WATCH_MS = Number(process.env.MDNS_WATCH_MS || 10000);

let watcher = null;
let announcedAddress = null;
let activePort = null;

function publish(port) {
  const { Bonjour } = require("bonjour-service");
  if (!bonjour) bonjour = new Bonjour();

  // Advertised as an HTTP service AND, implicitly, as the host record
  // "<name>.local" that the scanners resolve.
  published = bonjour.publish({
    name: SERVICE_NAME,
    type: "http",
    port,
    host: `${SERVICE_NAME}.local`,
    txt: { role: "grav-barcode-server" },
  });
  announcedAddress = lanAddress().address;
}

/**
 * Re-announce when this PC's IP changes.
 *
 * The first version published once at startup and never again — so after the
 * laptop moved network, the name still resolved to the address it had when the
 * server booted. A scanner would look up gravserver.local, get a dead address,
 * and show a red cross: exactly the failure this module was written to remove,
 * just with an extra step.
 *
 * mDNS records are cached by every resolver on the segment, so the old entry has
 * to be withdrawn before the new one is published, or both linger and clients
 * pick whichever they cached first.
 */
function rewatch(port) {
  clearInterval(watcher);
  watcher = setInterval(() => {
    const { address, iface } = lanAddress();
    if (!address || address === announcedAddress) return;

    console.log(
      `[mDNS] address changed ${announcedAddress || "none"} -> ${address} (${iface}) — re-announcing`
    );
    try {
      if (published) published.stop();
      if (bonjour) {
        bonjour.unpublishAll(() => {});
        bonjour.destroy();
      }
    } catch {
      /* the old record is going away regardless */
    }
    bonjour = null;
    published = null;
    try {
      publish(port);
      lastError = null;
      console.log(`[mDNS] ${SERVICE_NAME}.local now points at ${address}`);
    } catch (err) {
      lastError = err.message;
      console.error("[mDNS] re-announce failed:", err.message);
    }
  }, WATCH_MS);
  if (watcher.unref) watcher.unref();
}

function start(port) {
  if (!ENABLED) {
    console.log("[mDNS] disabled (MDNS_ENABLED=false)");
    return;
  }
  activePort = port;
  try {
    publish(port);
    const { address, iface } = lanAddress();
    console.log(
      `[mDNS] announcing ${SERVICE_NAME}.local:${port}` +
        (address ? ` (currently ${address} on ${iface})` : "")
    );
    console.log(`[mDNS] scanners can use  SRV:${SERVICE_NAME}.local:${port}`);
    rewatch(port);
  } catch (err) {
    // Never fatal. An announcement failing must not stop the floor: devices
    // pointed at the raw IP keep working exactly as before.
    lastError = err.message;
    console.error("[mDNS] could not announce:", err.message);
  }
}

function stop() {
  clearInterval(watcher);
  watcher = null;
  try {
    if (published) published.stop();
    if (bonjour) bonjour.destroy();
  } catch {
    /* shutting down anyway */
  }
  published = null;
  bonjour = null;
}

function health() {
  const { address, iface } = lanAddress();
  return {
    enabled: ENABLED,
    name: `${SERVICE_NAME}.local`,
    announcing: !!published,
    currentAddress: address,
    announcedAddress,
    inSync: address === announcedAddress,
    iface,
    lastError,
  };
}

module.exports = { start, stop, health, lanAddress, SERVICE_NAME };
