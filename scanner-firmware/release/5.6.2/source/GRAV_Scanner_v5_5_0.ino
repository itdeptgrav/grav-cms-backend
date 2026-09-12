// ═══════════════════════════════════════════════════════════════════════════════
// GRAV Scanner Firmware v5.5.0
//
// CHANGES FROM v5.4.0 — Local-first event sourcing
//
//  Every v5.4.0 behaviour below is UNCHANGED. This release changes where scans
//  go and when, not how the device behaves at the machine.
//
//  1. PER-SCAN SEND TO THE LAN, not 5-scan / 5-minute batches to the cloud
//     · BULK_API_URL now points at the factory PC (http://192.168.x.x:5000).
//       LAN round-trip is ~20ms vs ~300-2000ms to Render, so batching stopped
//       earning its keep.
//     · Every scan signals the background sender immediately. The queue is now
//       a FALLBACK for outages, not the normal path.
//     · New SRV:<ip>:<port> config barcode + a Server field in the setup page,
//       so re-pointing 50 devices does not mean reflashing 50 devices.
//
//  2. EVENT IDs — the device now owns identity  ..................... NEW
//     · eventId = <deviceId>-<bootCount>-<seq>, deterministic across retries.
//       Network delivery is at-least-once by nature: the device cannot tell
//       "server never got it" from "server got it, reply was lost", so it must
//       retry. A device-generated id + a unique index makes retries harmless.
//     · bootCount persists in NVS; seq resets each boot.
//
//  3. REAL SCAN TIMES WHEN THE CLOCK IS UNSET  .............. FIXED (critical)
//     · v5.4.0 rewrote any 1970 timestamp to the time the BATCH WAS SENT. A
//       scan made at 09:15 and flushed at 14:00 was recorded as 14:00, which
//       makes per-operator pace impossible to compute.
//     · Now: millis() is captured at scan time. When NTP lands, the true wall
//       time is reconstructed as ntpNow - (millisNow - millisAtScan) and the
//       event is flagged timeRecovered.
//
//  4. EVENTS CARRY THEIR OWN CONTEXT  ............................... NEW
//     · operatorId and machineId are captured PER EVENT at scan time, not
//       stamped from current state at send time. v5.4.0 embedded whatever
//       machineId was current when the batch flushed.
//     · Breaks and ops toggles are now events too, so idle-vs-productive time
//       and ops changes are auditable.
//
//  5. DURABLE QUEUE ON LittleFS  .................................... FIXED
//     · v5.4.0 stored 7 NVS keys per queued scan, up to 200 scans. The default
//       20KB NVS partition cannot hold that — it was silently over-committed —
//       and the ring buffer dropped the oldest scan with no warning.
//     · Queue now mirrors to LittleFS. RAM working set is 300 events, and the
//       screen warns from 80%. See MAX_STORED_SCANS note before raising it.
//
//  6. HEARTBEAT  .................................................... NEW
//     · POST /heartbeat every 60s with RSSI, queue depth, operator and ops.
//       Without it "operator on break" and "device died an hour ago" are the
//       same observation on the dashboard: no scans.
//
//  7. TWO-PHASE SCAN FEEDBACK  ...................................... NEW
//     · "Scan #N" the instant it is queued, then a tick when the server
//       confirms the write. A growing un-acked count is the earliest warning
//       that ingest is broken.
//
//  8. FIREBASE REMOVED ENTIRELY  .................................... NEW
//     · No Firebase RTDB anywhere. Ops polling, ops push and the break-event
//       mirror are all gone, along with the opsDirtyOffline reconciliation
//       flag that only existed to arbitrate device-vs-remote conflicts.
//     · CONSEQUENCE: the CMS "assign operations to machine" modal no longer
//       reaches devices — that path wrote to Firebase and has no Mongo
//       equivalent. Operations are now set ONLY by scanning ops: / opsgp:
//       barcodes at the machine. The list persists in NVS across reboots and
//       every scan still carries its own activeOps snapshot, so per-operation
//       efficiency in the rollup is unaffected.
//     · Cases 4 and 6 below (offline ops conflict resolution) are therefore
//       moot: with no remote there is nothing to conflict with.
//
//  v5.6.0 — NO CLOUD CALLS AT ALL. The CMS backend moved onto the factory PC
//  and now shares one MongoDB with this scanner server, so the two calls that
//  used to reach https://grav-cms-backend.onrender.com are LAN calls:
//    · GET  /api/machines/<id>                — machine name, cached in NVS
//    · POST /api/barcode-devices/check-update — hourly OTA check
//  Both derive from the SAME serverHost as scans, so one SRV: barcode re-points
//  everything. Nothing this device does needs the internet.
//
//  Ports on that one PC:
//    :5001  this scanner server   — scans, heartbeats, dashboard
//    :5000  the CMS backend       — OTA, machine names
//
// ───────────────────────────────────────────────────────────────────────────────
// INHERITED FROM v5.4.0 — Operations persistence + multi-device WiFi reliability
//
//  CASE 1 — WiFi drops while running (no reboot)
//    · Was already safe: ops stay in RAM, scans keep correct ops. UNCHANGED.
//
//  CASE 2 — WiFi down AND device reboots  ......................... FIXED
//    · Ops were RAM-only; a power cut left the device with ZERO ops.
//    · NEW "scanner_opsf" NVS namespace. Ops saved on every mutation and
//      loaded in setup() BEFORE connectToWiFi() — ops survive any reboot.
//
//  CASE 3 — Scans made after an offline reboot  ................... FIXED
//    · Scans were frozen with activeOps:"" permanently (unrecoverable).
//    · Ops are now restored from NVS before the first scan can happen.
//
//  CASE 4 — Operator re-scans ops: barcode while offline  ......... FIXED
//    · Local toggle worked but the Firebase push silently failed, so the
//      next poll treated the stale remote value as truth and WIPED the ops.
//    · NEW opsDirtyOffline flag (persisted). While set, pollFirebaseOps()
//      refuses to overwrite and pushes local -> Firebase instead.
//
//  CASE 5 — Ops changed in the CMS app while device offline
//    · Was already working. Poll still wins when opsDirtyOffline is false.
//
//  CASE 6 — BOTH changed during the outage  ....................... FIXED
//    · DEVICE WINS. The operator at the machine is ground truth. Local ops
//      are pushed BEFORE the first poll on reconnect.
//
//  CASE 7 — Same firmware, some devices connect to WiFi, some don't  FIXED
//    · WiFi.setSleep(false)      — modem sleep is the #1 unit-to-unit variance
//    · WiFi.persistent(false)    — stop stale creds in the ESP system NVS
//    · Explicit TX power + unique hostname GRAV-<deviceId>
//    · Scan-then-join: picks the STRONGEST BSSID+channel for the SSID, so a
//      unit cannot latch onto a far AP on a multi-AP / mesh site
//    · Boot now makes 3 join attempts, not 1
//    · Escalating reconnect ladder (reconnect -> re-begin -> hard radio
//      reset -> best-AP pin), replacing the old bare WiFi.reconnect()
//    · Info screen shows RSSI / channel / fail + reset counters for triage
//
//  Folded in (same functions being rewritten — see notes in code):
//    · pollFirebaseOps: lastActiveOpsCache no longer cached on a parse
//      failure (that permanently discarded the ops change)
//    · pushActiveOpsToFirebase: cache only updated on HTTP 2xx
//    · toggleOperation: no longer reports success when the 8-op list is full
//    · getLocalTime(&t,0): removed the 5s-per-call block when NTP is unset
//      (required for CASE 2/3/7 — offline scanning was freezing 5s per scan)
//    · loadFirmwareVersion: compile-time build always wins over NVS, so a
//      manually flashed unit stops reporting the old version to the backend
// ═══════════════════════════════════════════════════════════════════════════════

#include <HardwareSerial.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Update.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <LittleFS.h> // v5.5.0 — durable offline queue (NVS is too small)

// THE version. Shown on the splash screen, reported to /check-update, and
// compared against the label on the server.
//
// BUMP THIS whenever you build firmware to upload, and type the SAME string
// into the CMS Version field. If they differ, the server sees the device as
// permanently out of date and offers the same update on every boot — which is
// exactly what "800.80" against a 5.5.0 binary was doing.
#define FW_VERSION "5.6.2"

// ─── Types ────────────────────────────────────────────────────────────────────
// These MUST stay above the first function definition (apiBase(), below).
// The Arduino builder auto-generates a prototype for every function in the
// sketch and inserts them all immediately before the first function body, so a
// type named in any signature has to already exist at that point. Declaring
// these further down — as this file originally did — makes every generated
// prototype that mentions them fail with "does not name a type".
enum BreakReason
{
  BREAK_NONE = 0,
  BREAK_WASHROOM = 1,
  BREAK_BREAKDOWN = 2,
  BREAK_OTHER = 3
};

// Was StoredScan in v5.4.0. Every field that used to be stamped at SEND time is
// now captured at SCAN time, because that is the only moment the values are
// true: v5.4.0 embedded whatever machineId was current when the batch flushed,
// and rewrote unset timestamps to the flush time.
struct StoredEvent
{
  String eventId;   // <deviceId>-<bootCount>-<seq>, stable across retries
  String type;      // scan | signin | signout | break_start | break_end | ops_change
  String machineId; // captured at scan time, not at send time
  String operatorId;
  String barcodeId;
  String activeOps;          // comma-joined snapshot
  String breakReason;        // break_* only
  uint32_t breakDurationSec; // break_end only
  time_t scanEpoch;          // 0 when the clock was unset at scan time
  unsigned long millisAtScan;// always set — this is what recovers scanEpoch
  bool timeRecovered;
};

// ─── WiFi Manager ─────────────────────────────────────────────────────────────
WebServer server(80);
DNSServer dnsServer;
const byte DNS_PORT = 53;
const char *AP_SSID = "Grav_Production";
const char *AP_PASSWORD = "Grav_production_2702";
String fullAP_SSID;
String wifiSSID = "";
String wifiPass = "";
String deviceId = "";
String machineId = "";
String machineName = "";
bool wifiConfigured = false;
bool machineIdConfigured = false;
bool inConfigMode = false;
unsigned long configModeStartTime = 0;
const unsigned long CONFIG_MODE_TIMEOUT = 300000;
unsigned long lastWiFiConnectionAttempt = 0;
const unsigned long WIFI_CONNECTION_RETRY_INTERVAL = 30000;
int wifiConnectionFailCount = 0;
bool lastWiFiState = false;

// ─── v5.4.0 CASE 7: WiFi robustness ───────────────────────────────────────────
const unsigned long WIFI_JOIN_TIMEOUT_MS = 20000; // per join attempt
const int WIFI_BOOT_ATTEMPTS = 3;                 // join attempts at boot
int wifiRadioResetCount = 0;

// ─── Info Mode ────────────────────────────────────────────────────────────────
const char *INFO_KEYWORD = "INFO_ADMIN_2790";

// ─── Loop watchdog ────────────────────────────────────────────────────────────
// Observed in the field on 5.5.3: the device answered ping, held a strong WiFi
// association and kept its last screen, but sent nothing for 19 minutes and its
// reported uptime never moved. Ping is served by the WiFi stack in its own
// task, so it keeps replying after the Arduino loop has stopped — the device
// looks alive on the network and is doing nothing.
//
// The stuck-task reclaim added in 5.5.2 cannot help there: it runs INSIDE the
// loop, so a stopped loop stops the thing meant to fix it.
//
// The Arduino loop task is not subscribed to the task watchdog by default, so a
// hang is permanent until someone power-cycles the device. Subscribing it turns
// "dead until a human notices" into a reboot within 30 seconds. Queued scans
// live in LittleFS and survive the restart, so nothing is lost.
//
// 30s is comfortably longer than any legitimate blocking call here: the longest
// is the REFRESH_SYSTEM check at roughly 14s worst case.
const uint32_t LOOP_WDT_TIMEOUT_S = 30;
bool wdtActive = false;

void startLoopWatchdog()
{
  // Arduino-ESP32 3.x already initialises the TWDT, so init() returns
  // INVALID_STATE and reconfigure() is the correct call. Handling both keeps
  // this working if the core is ever rolled back.
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = LOOP_WDT_TIMEOUT_S * 1000;
  cfg.idle_core_mask = 0;   // watch this task only, not the idle tasks
  cfg.trigger_panic = true; // panic handler reboots

  esp_err_t err = esp_task_wdt_init(&cfg);
  if (err == ESP_ERR_INVALID_STATE)
    err = esp_task_wdt_reconfigure(&cfg);
  if (err != ESP_OK)
  {
    Serial.println("[WDT] could not configure: " + String(esp_err_to_name(err)));
    return;
  }
  if (esp_task_wdt_add(NULL) == ESP_OK)
  {
    wdtActive = true;
    Serial.println("[WDT] loop watchdog armed (" + String(LOOP_WDT_TIMEOUT_S) + "s)");
  }
}

inline void feedWatchdog()
{
  if (wdtActive) esp_task_wdt_reset();
}

// Why the device last restarted. Reported in the heartbeat so a hang that the
// watchdog caught is distinguishable from someone switching the machine off —
// from the dashboard, without a serial cable.
String resetReasonText()
{
  switch (esp_reset_reason())
  {
    case ESP_RST_POWERON:  return "power";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "crash";
    case ESP_RST_TASK_WDT: return "loop-hang";
    case ESP_RST_INT_WDT:  return "int-wdt";
    case ESP_RST_WDT:      return "wdt";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_DEEPSLEEP:return "deepsleep";
    case ESP_RST_EXT:      return "reset-pin";
    default:               return "unknown";
  }
}

// Operator-facing recheck. Everything the header indicator is based on runs on
// a timer — the heartbeat is up to 60s away, and the anti-flap streak means a
// recovered server can take two cycles to show green again. That is correct
// behaviour for an unattended device and useless for someone standing at the
// machine wondering why it still shows a cross. This forces the whole check to
// happen now and reports each part separately, so a real fault is told apart
// from a stale indicator.
const char *REFRESH_KEYWORD = "REFRESH_SYSTEM";
bool infoModeActive = false;
unsigned long infoModeStartTime = 0;
const unsigned long INFO_MODE_DURATION = 10000;

// ─── OTA ──────────────────────────────────────────────────────────────────────
String currentFirmwareVersion = FW_VERSION;
bool updateAvailable = false;
String newFirmwareUrl = "";
String newFirmwareVersion = "";
unsigned long lastUpdateCheck = 0;
const unsigned long UPDATE_CHECK_INTERVAL = 3600000;

// ─── OTA safety ───────────────────────────────────────────────────────────────
// An application image is ~1.2MB. The build folder also contains boot_app0.bin
// (8KB), the partition table (3KB) and the bootloader (25KB), and uploading one
// of those by mistake used to be accepted — the device then sat waiting for
// bytes that were never coming.
const int MIN_FIRMWARE_BYTES = 200000;

// No data for this long means the transfer is dead. Without it the download
// loop had no exit but success, so a stalled stream hung the device until the
// watchdog rebooted it — and it then re-downloaded the same file forever.
const unsigned long OTA_STALL_TIMEOUT_MS = 20000;

// ─── OTA retry policy ─────────────────────────────────────────────────────────
// Two different failures, deliberately handled differently:
//
//   TRANSIENT (stalled transfer, connection dropped) — retry. A 1.2MB download
//     over WiFi to a cloud host genuinely does need two or three attempts in
//     the field; refusing to retry would mean the update never lands.
//
//   PERMANENT (file is too small to be firmware) — do NOT retry. Downloading
//     the same 8KB file again cannot make it bigger. Retrying is what turned
//     one wrong upload into an endless loop.
//
// Bounded either way: after OTA_MAX_ATTEMPTS the device stops until a power
// cycle or a genuinely new version. Not persisted, because a reboot is a
// reasonable way to say "try again".
const int OTA_MAX_ATTEMPTS = 4;
String otaFailedVersion = "";
int otaFailCount = 0;

// Records a failed attempt. permanent=true burns all remaining attempts at
// once, so a wrong file is rejected on sight rather than three more times.
void noteOtaFailure(const String &version, bool permanent)
{
  if (version != otaFailedVersion)
  {
    otaFailedVersion = version;
    otaFailCount = 0;
  }
  otaFailCount = permanent ? OTA_MAX_ATTEMPTS : otaFailCount + 1;
  Serial.println("[OTA] " + version + " failed (" + String(otaFailCount) + "/" +
                 String(OTA_MAX_ATTEMPTS) + (permanent ? ", permanent)" : ")"));
}
// ─── API — EVERYTHING ON THE FACTORY PC (v5.6.0) ──────────────────────────────
// Plain HTTP to the factory PC on the same LAN. NOT localhost — to an ESP32
// "localhost" means the device itself.
//
// Two services now run on that one PC, against one MongoDB:
//   :5001  this scanner server  — scans, heartbeats, supervisor dashboard
//   :5000  the CMS backend      — OTA firmware, machine names
//
// Both are derived from the SAME serverHost, which lives in NVS and is set in
// the field by the SRV: barcode. That is deliberate: previously the CMS URL was
// a hardcoded Render address while only the scanner host was configurable, so a
// change of address fixed scanning but left OTA pointing at the cloud. One
// SRV: scan now re-points everything.
const char *SERVER_NAMESPACE = "scanner_srv";
const char *DEFAULT_SERVER_HOST = "192.168.1.80"; // factory PC — MUST be DHCP-reserved
const int DEFAULT_SERVER_PORT = 5001;             // scanner server
const int DEFAULT_CMS_PORT = 5000;                // CMS backend, same machine
// v5.6.2 — the scheme is configurable instead of compiled in.
//
// Plain HTTP stays the DEFAULT and stays fully supported. The LAN server has
// no certificate and never will: a public CA cannot issue one for a private
// IP, and a self-signed cert spread over 50 devices is worse than none. A TLS
// handshake also costs this chip 1-3 seconds and tens of KB of heap, against
// ~20 ms for a plain LAN POST — so for a server on the same network, HTTP is
// the better engineering choice, not a compromise.
//
// What is new is that a self-hosted deployment behind a real domain can be
// reached over TLS by scanning SRV:https://host. Same firmware, same code
// path: HTTPClient::begin() builds a TLS client by itself when the URL starts
// with https://, which is how 5.5.5 reached Render with no TLS code here.
//
// Deliberately ONE target at a time, with NO automatic failover between a LAN
// server and a hosted one. A device that silently switched backends would
// write its scans into two different databases — the exact split this whole
// change exists to remove. An outage is already handled correctly by the
// LittleFS queue: hold the scans, deliver them to the SAME server it returns.
const char *DEFAULT_SERVER_SCHEME = "http";
String serverScheme = DEFAULT_SERVER_SCHEME;
String serverHost = DEFAULT_SERVER_HOST;
int serverPort = DEFAULT_SERVER_PORT;
int cmsPort = DEFAULT_CMS_PORT;

// Omit the port when it is the scheme's own default, so a reverse proxy sees
// the Host header it expects. "https://host:443/api" is technically valid, but
// a vhost matching on the literal host string will not match it.
String hostPort(int port)
{
  bool isDefault = (serverScheme == "https" && port == 443) ||
                   (serverScheme == "http" && port == 80);
  return isDefault ? serverHost : serverHost + ":" + String(port);
}

String apiBase()
{
  return serverScheme + "://" + hostPort(serverPort) +
         "/api/cms/production/barcode_punchings";
}
String eventsUrl() { return apiBase() + "/events"; }
String heartbeatUrl() { return apiBase() + "/heartbeat"; }

// The CMS backend, on the same PC. Was https://grav-cms-backend.onrender.com.
// Moving OTA onto the LAN also cures the downloads that used to stall around
// 50%: a 1.2MB TLS transfer from a free-tier cloud host to an ESP32 is the
// fragile part, and over the LAN it is about a second.
String cmsBase() { return serverScheme + "://" + hostPort(cmsPort) + "/api"; }
String deviceRegisterUrl() { return cmsBase() + "/barcode-devices/check-update"; }
String machineNameUrl() { return cmsBase() + "/machines/"; }

void saveServerConfig()
{
  Preferences p;
  p.begin(SERVER_NAMESPACE, false);
  p.putString("scheme", serverScheme);
  p.putString("host", serverHost);
  p.putInt("port", serverPort);
  p.putInt("cmsport", cmsPort);
  p.end();
}
void loadServerConfig()
{
  Preferences p;
  p.begin(SERVER_NAMESPACE, true);
  // Absent on every unit upgrading from 5.5.x / 5.6.0, which is why the
  // default is "http": those devices come back on exactly the address and
  // protocol they were already using.
  serverScheme = p.getString("scheme", DEFAULT_SERVER_SCHEME);
  serverHost = p.getString("host", DEFAULT_SERVER_HOST);
  serverPort = p.getInt("port", DEFAULT_SERVER_PORT);
  cmsPort = p.getInt("cmsport", DEFAULT_CMS_PORT);
  p.end();
  if (serverScheme != "http" && serverScheme != "https")
    serverScheme = DEFAULT_SERVER_SCHEME;
  if (serverHost.length() == 0)
    serverHost = DEFAULT_SERVER_HOST;
  if (serverPort <= 0 || serverPort > 65535)
    serverPort = DEFAULT_SERVER_PORT;
  if (cmsPort <= 0 || cmsPort > 65535)
    cmsPort = DEFAULT_CMS_PORT;

  // A unit upgrading from 5.5.x has "port" = 5000 in NVS from when the scanner
  // server lived there. 5000 is now the CMS backend, so that stored value would
  // point every scan at the wrong service and the device would look dead on a
  // perfectly good network. Migrate it once, rather than making someone walk
  // the floor with the SRV: sheet for a value the firmware can work out.
  // HTTP only: on a hosted deployment 5000 may legitimately be the proxy
  // port, and silently rewriting it to 5001 would break a correct config.
  if (serverScheme == "http" && serverPort == 5000)
  {
    Serial.println("[Srv] migrating stored port 5000 -> " + String(DEFAULT_SERVER_PORT) +
                   " (5000 is the CMS backend now)");
    serverPort = DEFAULT_SERVER_PORT;
    saveServerConfig();
  }

  Serial.println("[Srv] scans " + apiBase());
  Serial.println("[Srv] cms   " + cmsBase());
}

// Format: SRV:192.168.1.80:5001   (port optional, defaults to the scanner port)
bool isServerUpdateBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.startsWith("SRV:");
}
bool parseServerUpdateBarcode(const String &s, String &outScheme, String &outHost,
                              int &outPort, int &outCmsPort)
{
  int start = s.indexOf(':');
  if (start < 0)
    return false;
  String rest = s.substring(start + 1);
  rest.trim();
  if (rest.length() == 0)
    return false;

  outScheme = DEFAULT_SERVER_SCHEME;
  bool explicitScheme = false;

  // "://" appears only as the scheme separator, so finding it is unambiguous.
  int sep = rest.indexOf("://");
  if (sep > 0)
  {
    outScheme = rest.substring(0, sep);
    outScheme.toLowerCase();
    // Reject anything else rather than defaulting: a card reading
    // "SRV:ftp://..." is a mistake, and quietly treating it as HTTP would send
    // production scans somewhere nobody intended.
    if (outScheme != "http" && outScheme != "https")
      return false;
    rest = rest.substring(sep + 3);
    rest.trim();
    explicitScheme = true;
  }
  if (rest.length() == 0)
    return false;

  // Tolerate a trailing path — people paste whole URLs off the address bar.
  int slash = rest.indexOf('/');
  if (slash >= 0)
    rest = rest.substring(0, slash);

  const int schemeDefaultPort = (outScheme == "https") ? 443 : 80;

  int colon = rest.indexOf(':');
  if (colon < 0)
  {
    outHost = rest;
    // No port given: a bare LAN host still means the scanner server on 5001,
    // but a bare hosted URL means the scheme's own port behind the proxy.
    outPort = explicitScheme ? schemeDefaultPort : DEFAULT_SERVER_PORT;
  }
  else
  {
    outHost = rest.substring(0, colon);
    outPort = rest.substring(colon + 1).toInt();
    if (outPort <= 0 || outPort > 65535)
      outPort = explicitScheme ? schemeDefaultPort : DEFAULT_SERVER_PORT;
  }
  outHost.trim();

  // Two ports exist only because the scanner server and the CMS backend are
  // two separate processes on the factory PC. A reverse-proxied deployment
  // puts both behind ONE origin, where carrying 5000 over would build
  // https://host:5000 — not where the proxy serves it.
  //
  // The marker for "proxied" is TLS, or a bare :80 — not merely writing the
  // scheme out. Someone typing the LAN address in full as
  // SRV:http://192.168.1.80:5001 still means the two-process layout, and
  // treating that as one origin would put the CMS on 5001: scans would keep
  // working while OTA and machine-name lookup quietly failed, which is the
  // worst way for this to break.
  bool singleOrigin = (outScheme == "https") || (outPort == 80);
  outCmsPort = singleOrigin ? outPort : DEFAULT_CMS_PORT;
  return outHost.length() > 0;
}
void handleServerUpdateBarcode(const String &s);

// ─── Firebase: REMOVED ────────────────────────────────────────────────────────
// The device no longer talks to Firebase at all. Operations are set ONLY by
// scanning ops: / opsgp: barcodes at the machine; the list lives in NVS and
// survives reboots, and every scan carries its own activeOps snapshot.
// Consequence: the CMS "assign operations to machine" modal no longer reaches
// devices. That path was Firebase-only and had no Mongo equivalent.

// ─── Send cadence (v5.5.0) ────────────────────────────────────────────────────
// Every scan triggers a send immediately. These timers are now the RETRY path
// for a queue that could not be delivered, not the normal send trigger.
const unsigned long QUEUE_RETRY_INTERVAL = 30UL * 1000UL; // while queue non-empty
unsigned long lastQueueRetry = 0;
bool sendBatchNow = false;

// One upload attempt, owned by the task that performs it.
//
// The payload used to be a global String that the main loop rewrote for the
// next attempt while the previous task was still inside http.POST(). Assigning
// to a String frees its old buffer, so the task was writing a socket from freed
// heap — silent corruption that shows up later as a crashed task or a reboot,
// and the crashed task is what leaves the "sending" flag stuck forever.
// Each attempt now carries its own copy and deletes it on the way out.
struct SendJob
{
  uint32_t gen;
  String payload;
};

// background send task state
volatile bool bulkTaskDone = false;
volatile int bulkTaskResult = 0; // 1 = HTTP 2xx, 2 = failed
volatile int bulkHttpCode = 0;
int bulkPendingCount = 0;
TaskHandle_t bulkTaskHandle = NULL;

// ─── Heartbeat (v5.5.0) ───────────────────────────────────────────────────────
// Without this the dashboard cannot tell an operator on a break from a device
// that died an hour ago — both look like zero scans.
const unsigned long HEARTBEAT_INTERVAL = 60UL * 1000UL;
unsigned long lastHeartbeat = 0;
volatile bool hbTaskRunning = false;

// ─── Stuck-task watchdogs ─────────────────────────────────────────────────────
// hbTaskRunning and isSendingBulk are "a task owns this right now" flags, and
// each is cleared ONLY by the task that set it. If that task ever dies — task
// watchdog, an HTTPClient fault, a failed allocation — the flag stays true and
// the guard at the top of sendHeartbeat() / startBackgroundBulkSend() refuses
// every future attempt. The device then sits on a healthy network, reachable by
// ping, sending nothing at all until someone power-cycles it. That is exactly
// the "server is on but the device says No server" case.
//
// HTTP timeouts here are 4-5s, so a task that has not finished in 30s is gone,
// not slow. These timestamps let the main loop reclaim the flag.
const unsigned long TASK_STUCK_TIMEOUT_MS = 30UL * 1000UL;
unsigned long hbStartedAt = 0;
unsigned long bulkStartedAt = 0;

// Reclaiming a flag means a NEW task can start while the old one may still be
// blocked somewhere in lwIP. Deleting that task from the outside is not safe —
// it can be holding a network mutex — so it is left to finish and its result is
// discarded instead. Each attempt takes a generation number, passed as the task
// parameter; a task only writes back its result if it is still the current one.
// Without this, an orphan waking up late would report ITS outcome against the
// send that replaced it: the wrong HTTP code, and worse, a "delivered" verdict
// that drops scans the new attempt never actually sent.
volatile uint32_t bulkGeneration = 0;
volatile uint32_t hbGeneration = 0;

// ─── Event identity (v5.5.0) ──────────────────────────────────────────────────
// eventId = <deviceId>-<bootCount>-<seq>. bootCount is monotonic in NVS, seq
// resets each boot, so the pair is unique for the life of the device and
// identical on every retry of the same event.
const char *BOOT_NAMESPACE = "scanner_boot";
uint32_t bootCount = 0;
uint32_t eventSeq = 0;

// ─── Two-phase scan feedback (v5.5.0) ─────────────────────────────────────────
// Count of events queued but not yet confirmed by the server.
int unackedCount = 0;
bool lastSendConfirmed = true;

// ─── Backend reachability ─────────────────────────────────────────────────────
// WiFi association is NOT the same thing as "the server is answering". A device
// can sit on a perfect access point all shift while the server is down, on
// another subnet, or pointed at a stale IP — which is exactly what happened in
// the field. Set from every heartbeat and every event POST, and shown in the
// header as a tick or a cross.
volatile bool backendOk = false;

// ─── The second hop is gone (v5.6.0) ──────────────────────────────────────────
// This tracked whether the factory PC was still getting data up to a hosted CMS
// over the internet — a real risk when the two were separate databases and an
// hourly job moved rows between them. The CMS now reads the SAME MongoDB this
// server writes, so a scan is visible to head office the instant it is stored.
// There is no second hop left to fall behind on.
//
// The flag is kept, pinned true, rather than ripped out: the heartbeat reply
// still carries cloudSyncOk for older units in the field, and a device that
// never hears from the server must show a normal tick, not a warning about a
// system that no longer exists.
volatile bool cloudSyncOk = true;

// ─── Why this is a streak and not a boolean ───────────────────────────────────
// Setting backendOk from a SINGLE result made the indicator flap: one dropped
// packet or one 4s timeout showed "No server" for a full minute while the
// server was fine. On a factory floor a false alarm is worse than no indicator
// — people stop trusting it, and then miss the real outage.
//
// So: FAIL SLOW, RECOVER FAST.
//   any success            -> reachable immediately, streak cleared
//   one failure            -> stays green, but re-checks in 10s instead of 60s
//   two failures in a row  -> genuinely down, show the cross
//
// A real outage still surfaces in about ten seconds, because the first failure
// pulls the next heartbeat forward.
const int BACKEND_FAIL_THRESHOLD = 2;
const unsigned long HEARTBEAT_FAST_RETRY_MS = 10UL * 1000UL;
volatile int backendFailStreak = 0;

// Called from the send and heartbeat tasks (core 0) with the HTTP outcome.
void noteBackendResult(bool ok)
{
  if (ok)
  {
    backendFailStreak = 0;
    backendOk = true;
    return;
  }
  if (backendFailStreak < 1000) backendFailStreak++;
  if (backendFailStreak >= BACKEND_FAIL_THRESHOLD) backendOk = false;
}

// Only repaint the queue line when the number actually changes. Redrawing a
// TFT strip every second costs SPI time on the same bus the scanner shares,
// and it visibly flickers.
int lastDrawnQueue = -1;
bool lastDrawnBackendOk = false;

// ─── Clock recovery (v5.5.0) ──────────────────────────────────────────────────
// Set once NTP has produced a plausible wall clock. Until then, events are
// stamped with millis() only and their true time is reconstructed later.
bool clockValid = false;

// ─── NVS Persist Timer ────────────────────────────────────────────────────────
const unsigned long NVS_PERSIST_INTERVAL = 5UL * 60UL * 1000UL;
unsigned long lastNVSPersist = 0;
bool nvsDirty = false;

// ─── Display / Message ────────────────────────────────────────────────────────
unsigned long messageShowUntil = 0;
bool messagePending = false;
String pendingReturnScreen = "";
unsigned long scanFeedbackUntil = 0;
String scanFeedbackReturn = "";

// ─── Scan Debounce ────────────────────────────────────────────────────────────
unsigned long lastAcceptedScanTime = 0;
const unsigned long SCAN_DEBOUNCE_MS = 4000;

// ─── Spinner (retained; no longer used by bulk send) ─────────────────────────
TaskHandle_t spinnerTaskHandle = NULL;
volatile bool spinnerRunning = false;
const uint16_t SPINNER_BG = 0x0A51;

// ─── Visual Feedback ──────────────────────────────────────────────────────────
unsigned long visualFeedbackUntil = 0;
bool visualFeedbackActive = false;
String visualFeedbackMessage = "";
bool visualFeedbackIsSuccess = false;

// ─── Break Mode ───────────────────────────────────────────────────────────────
// enum BreakReason is declared in the Types block at the top of the file.
const char *BREAK_CODE_WASHROOM = "BREAK_WASHROOM";
const char *BREAK_CODE_BREAKDOWN = "BREAK_BREAKDOWN";
const char *BREAK_CODE_OTHER = "BREAK_OTHER";
BreakReason currentBreakReason = BREAK_NONE;
time_t breakStartEpoch = 0;
unsigned long breakStartMillis = 0;
bool breakStartedThisSession = false;
unsigned long lastBreakScreenRefresh = 0;
const unsigned long BREAK_TIMER_REFRESH_MS = 1000;
const char *BREAK_NAMESPACE = "scanner_brk";

// ─── WO History ───────────────────────────────────────────────────────────────
const int MAX_WO_HISTORY = 40;
String woHistory[MAX_WO_HISTORY];
int woHistoryCount = 0;
const char *WO_NAMESPACE = "scanner_wo";

// ─── Forward Declarations ─────────────────────────────────────────────────────
extern bool isEmployeeSignedIn;
extern String currentEmployeeName;
extern String currentEmployeeId;
void showEmployeeScreen();
void showNoOperatorScreen();
// v5.5.0 — operator-facing errors that say what to DO, not just what broke
int drawWrapped(const String &text, int x, int y, int maxChars, int lineH, int maxLines);
void showScanError(const char *code, const String &headline,
                   const String &what, const String &action);
void showOpsOnScreen(int);
void drawHeader();
// Declared here WITHOUT the default argument, exactly as showScreen() is.
// The Arduino builder only auto-generates a prototype for functions that do
// not already have one; if it generated this one it would repeat the default
// and the definition would fail with "default argument given for parameter 2".
void drawWiFiIconSmall(bool connected, uint16_t bg);
void drawQueueLine();
bool isWiFiConnected();
void showBreakScreen();
void refreshBreakTimerArea();
void returnToHomeScreen();
void drawNameLine(int, uint16_t);
void startSpinner();
void stopSpinner();
// logBreakEventToFirebase() removed — breaks are Mongo events now, see endBreak().
String getISOTimeIST();
void startBackgroundBulkSend();
void handleBulkSendCompletion();
void reclaimStuckTasks();
void handleRefreshSystem();
String buildBulkPayload(int count);
void handleMachineUpdateBarcode(const String &s);
void saveScansData();
void saveWOHistory();
void saveEmployeeData();
void fetchMachineNameIfNeeded();
void showScreen(String title, String line1, String line2, int bgColor);
// v5.4.0
void saveOpsToNVS();
void loadOpsFromNVS();
void clearOpsNVS();
void markOpsChangedLocally();
void applyWiFiTuning();
bool joinWiFiOnce(bool useBestAP);
void wifiRadioHardReset(bool pinBestAP);
// v5.5.0
String nextEventId();
void loadBootCount();
void queueEvent(const String &type, const String &barcodeId,
                const String &operatorId, const String &ops,
                const String &breakReason = "", uint32_t breakDurationSec = 0);
void kickSender();
void recoverQueuedTimes();
void sendHeartbeat();
void initQueueFS();
void queueAppendToFS(const StoredEvent &e);
void queueRewriteFS();
void queueLoadFromFS();
void queueClearFS();
String isoFromEpoch(time_t epoch);
int drainCount();

// ─── Admin ────────────────────────────────────────────────────────────────────
const char *ADMIN_KEYWORD = "ADMIN-CONFIG-94731";
bool checkForAdminConfig(String s) { return s.indexOf(ADMIN_KEYWORD) >= 0; }

// ─── WiFi Update Barcode ──────────────────────────────────────────────────────
bool isWiFiUpdateBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.startsWith("SSID:") && u.indexOf(",PASSWORD:") > 0;
}
bool parseWiFiUpdateBarcode(const String &s, String &outSSID, String &outPass)
{
  String u = s;
  u.toUpperCase();
  int ssidStart = u.indexOf("SSID:");
  int passStart = u.indexOf(",PASSWORD:");
  if (ssidStart < 0 || passStart < 0)
    return false;
  outSSID = s.substring(ssidStart + 5, passStart);
  outPass = s.substring(passStart + 10);
  outSSID.trim();
  outPass.trim();
  return outSSID.length() > 0;
}
void handleWiFiUpdateBarcode(const String &s);

// ─── Machine Update Barcode ───────────────────────────────────────────────────
// Format:  MID:<machineId>,MNAME:<machineName>
bool isMachineUpdateBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.startsWith("MID:") && u.indexOf(",MNAME:") > 0;
}
bool parseMachineUpdateBarcode(const String &s, String &outId, String &outName)
{
  String u = s;
  u.toUpperCase();
  int idStart = u.indexOf("MID:");
  int nameStart = u.indexOf(",MNAME:");
  if (idStart < 0 || nameStart < 0)
    return false;
  outId = s.substring(idStart + 4, nameStart);
  outName = s.substring(nameStart + 7);
  outId.trim();
  outName.trim();
  return outId.length() > 0;
}

// ─── Operations ───────────────────────────────────────────────────────────────
const int MAX_ACTIVE_OPS = 8;
String activeOperations[MAX_ACTIVE_OPS];
int activeOpCount = 0;

// Ops persistence. The opsDirtyOffline flag is gone with Firebase: it existed
// only to stop a stale remote value overwriting a local change. With no remote,
// the device is always the sole authority and there is nothing to reconcile.
const char *OPS_NAMESPACE = "scanner_ops";

bool isOpsKeyword(String s) { return s.startsWith("ops:"); }
bool isOpsGroupKeyword(String s) { return s.startsWith("opsgp:"); }
String extractOpName(String s) { return s.length() > 4 ? s.substring(4) : ""; }

// ─── v5.4.0 CASE 2/3: Ops NVS persistence ─────────────────────────────────────
// The active-ops list used to live in RAM only, so a reboot with WiFi down left
// the device with zero ops and froze activeOps:"" into every queued scan.
void saveOpsToNVS()
{
  Preferences p;
  p.begin(OPS_NAMESPACE, false);
  p.putInt("count", activeOpCount);
  for (int i = 0; i < activeOpCount; i++)
  {
    String k = "o" + String(i);
    p.putString(k.c_str(), activeOperations[i]);
  }
  p.end();
}
void loadOpsFromNVS()
{
  Preferences p;
  p.begin(OPS_NAMESPACE, true);
  activeOpCount = p.getInt("count", 0);
  if (activeOpCount < 0)
    activeOpCount = 0;
  if (activeOpCount > MAX_ACTIVE_OPS)
    activeOpCount = MAX_ACTIVE_OPS;
  for (int i = 0; i < activeOpCount; i++)
  {
    String k = "o" + String(i);
    activeOperations[i] = p.getString(k.c_str(), "");
  }
  p.end();
  // drop any blank slots a partial write may have left behind
  for (int i = activeOpCount - 1; i >= 0; i--)
  {
    if (activeOperations[i].length() == 0)
    {
      for (int k = i; k < activeOpCount - 1; k++)
        activeOperations[k] = activeOperations[k + 1];
      activeOperations[activeOpCount - 1] = "";
      activeOpCount--;
    }
  }
  Serial.println("[Ops] Restored " + String(activeOpCount) + " op(s) from NVS");
}
void clearOpsNVS()
{
  Preferences p;
  p.begin(OPS_NAMESPACE, false);
  p.clear();
  p.end();
}
// Call after ANY ops change (ops: / opsgp: barcode). Persists to NVS and
// records the change as an event, so a pace drop at 11:04 can be correlated
// with whoever changed the operation at 11:03.
void markOpsChangedLocally()
{
  saveOpsToNVS();
  queueEvent("ops_change", "", currentEmployeeId, getActiveOpsString(), "local", 0);
}

int extractGroupOps(String s, String out[], int maxOps)
{
  String payload = s.substring(6);
  payload.trim();
  int count = 0, start = 0;
  for (int i = 0; i <= (int)payload.length() && count < maxOps; i++)
  {
    if (i == (int)payload.length() || payload.charAt(i) == ',')
    {
      String t = payload.substring(start, i);
      t.trim();
      if (t.length() > 0)
        out[count++] = t;
      start = i + 1;
    }
  }
  return count;
}
// v5.4.0 — returns true ONLY if the op is actually active afterwards.
// Previously returned true even when the 8-op list was full and nothing was
// added, so the screen falsely reported a sign-in.
bool toggleOperation(String opName)
{
  opName.trim();
  if (opName.length() == 0)
    return false;
  for (int i = 0; i < activeOpCount; i++)
  {
    if (activeOperations[i].equalsIgnoreCase(opName))
    {
      for (int j = i; j < activeOpCount - 1; j++)
        activeOperations[j] = activeOperations[j + 1];
      activeOperations[activeOpCount - 1] = "";
      activeOpCount--;
      return false;
    }
  }
  if (activeOpCount < MAX_ACTIVE_OPS)
  {
    activeOperations[activeOpCount++] = opName;
    return true;
  }
  Serial.println("[Ops] FULL — cannot add " + opName);
  return false;
}
void toggleGroupOps(String ops[], int count, int &si, int &so)
{
  si = 0;
  so = 0;
  for (int i = 0; i < count; i++)
  {
    if (toggleOperation(ops[i]))
      si++;
    else
      so++;
  }
}
String getActiveOpsString()
{
  String r = "";
  for (int i = 0; i < activeOpCount; i++)
  {
    if (i > 0)
      r += ",";
    r += activeOperations[i];
  }
  return r;
}
bool isOpActive(String code)
{
  code.trim();
  for (int i = 0; i < activeOpCount; i++)
    if (activeOperations[i].equalsIgnoreCase(code))
      return true;
  return false;
}
// setActiveOpsFromFirebase() removed — it applied a remote ops list, and there
// is no remote any more. Ops change only through toggleOperation() /
// toggleGroupOps() driven by an ops: or opsgp: barcode.

// ─── WO History ───────────────────────────────────────────────────────────────
bool isWOInHistory(const String &wo)
{
  for (int i = 0; i < woHistoryCount; i++)
    if (woHistory[i].equalsIgnoreCase(wo))
      return true;
  return false;
}
void saveWOHistory()
{
  Preferences p;
  p.begin(WO_NAMESPACE, false);
  p.clear();
  p.putInt("count", woHistoryCount);
  for (int i = 0; i < woHistoryCount; i++)
  {
    String k = "w" + String(i);
    p.putString(k.c_str(), woHistory[i]);
  }
  p.end();
}
void loadWOHistory()
{
  Preferences p;
  p.begin(WO_NAMESPACE, true);
  woHistoryCount = p.getInt("count", 0);
  if (woHistoryCount > MAX_WO_HISTORY)
    woHistoryCount = MAX_WO_HISTORY;
  for (int i = 0; i < woHistoryCount; i++)
  {
    String k = "w" + String(i);
    woHistory[i] = p.getString(k.c_str(), "");
  }
  p.end();
}
void clearWOHistory()
{
  woHistoryCount = 0;
  for (int i = 0; i < MAX_WO_HISTORY; i++)
    woHistory[i] = "";
  Preferences p;
  p.begin(WO_NAMESPACE, false);
  p.clear();
  p.end();
}
void addWOToHistory(const String &wo)
{
  if (isWOInHistory(wo))
    return;
  if (woHistoryCount < MAX_WO_HISTORY)
  {
    woHistory[woHistoryCount] = wo;
    woHistoryCount++;
    Preferences p;
    p.begin(WO_NAMESPACE, false);
    p.putInt("count", woHistoryCount);
    String k = "w" + String(woHistoryCount - 1);
    p.putString(k.c_str(), wo);
    p.end();
  }
  else
  {
    for (int i = 0; i < MAX_WO_HISTORY - 1; i++)
      woHistory[i] = woHistory[i + 1];
    woHistory[MAX_WO_HISTORY - 1] = wo;
    nvsDirty = true;
  }
}

// ─── Break ────────────────────────────────────────────────────────────────────
bool isBreakBarcode(const String &s)
{
  return s.equalsIgnoreCase(BREAK_CODE_WASHROOM) || s.equalsIgnoreCase(BREAK_CODE_BREAKDOWN) || s.equalsIgnoreCase(BREAK_CODE_OTHER);
}
BreakReason parseBreakReason(const String &s)
{
  if (s.equalsIgnoreCase(BREAK_CODE_WASHROOM))
    return BREAK_WASHROOM;
  if (s.equalsIgnoreCase(BREAK_CODE_BREAKDOWN))
    return BREAK_BREAKDOWN;
  if (s.equalsIgnoreCase(BREAK_CODE_OTHER))
    return BREAK_OTHER;
  return BREAK_NONE;
}
String breakReasonLabel(BreakReason r)
{
  switch (r)
  {
  case BREAK_WASHROOM:
    return "WASHROOM GO";
  case BREAK_BREAKDOWN:
    return "BREAKDOWN";
  case BREAK_OTHER:
    return "OTHER";
  default:
    return "";
  }
}
String breakReasonLabelShort(BreakReason r)
{
  switch (r)
  {
  case BREAK_WASHROOM:
    return "WASHROOM";
  case BREAK_BREAKDOWN:
    return "BREAKDOWN";
  case BREAK_OTHER:
    return "OTHER";
  default:
    return "";
  }
}
bool isInBreakMode() { return currentBreakReason != BREAK_NONE; }

void saveBreakState()
{
  Preferences p;
  p.begin(BREAK_NAMESPACE, false);
  p.putInt("reason", (int)currentBreakReason);
  p.putULong64("startEp", (uint64_t)breakStartEpoch);
  p.putBool("synced", breakStartedThisSession);
  p.end();
}
void loadBreakState()
{
  Preferences p;
  p.begin(BREAK_NAMESPACE, true);
  currentBreakReason = (BreakReason)p.getInt("reason", 0);
  breakStartEpoch = (time_t)p.getULong64("startEp", 0);
  breakStartedThisSession = p.getBool("synced", false);
  p.end();
  breakStartMillis = millis();
}
void clearBreakStateNVS()
{
  Preferences p;
  p.begin(BREAK_NAMESPACE, false);
  p.clear();
  p.end();
}

void startBreak(BreakReason r)
{
  currentBreakReason = r;
  time_t now;
  time(&now);
  if (now > 1700000000UL)
  {
    breakStartEpoch = now;
    breakStartedThisSession = true;
  }
  else
  {
    breakStartEpoch = 0;
    breakStartedThisSession = false;
  }
  breakStartMillis = millis();
  saveBreakState();
  // Breaks are events. Without them, productive-vs-idle minutes in
  // operator_day_stats are guesswork: a stopped machine and a slow one look
  // identical. The old Firebase mirror was removed — nothing ever read it.
  queueEvent("break_start", "", currentEmployeeId, getActiveOpsString(),
             breakReasonLabelShort(r), 0);
}
unsigned long getBreakElapsedSeconds()
{
  if (currentBreakReason == BREAK_NONE)
    return 0;
  if (breakStartEpoch > 0)
  {
    time_t now;
    time(&now);
    if (now > 1700000000UL && now >= breakStartEpoch)
      return (unsigned long)(now - breakStartEpoch);
  }
  if (breakStartMillis > 0)
  {
    unsigned long nm = millis();
    if (nm >= breakStartMillis)
      return (nm - breakStartMillis) / 1000UL;
  }
  return 0;
}
void endBreak(const char *endedBy = "manual")
{
  if (currentBreakReason == BREAK_NONE)
    return;
  unsigned long elapsed = getBreakElapsedSeconds();
  (void)endedBy; // kept in the signature; callers document why a break ended
  queueEvent("break_end", "", currentEmployeeId, getActiveOpsString(),
             breakReasonLabelShort(currentBreakReason), (uint32_t)elapsed);
  currentBreakReason = BREAK_NONE;
  breakStartEpoch = 0;
  breakStartedThisSession = false;
  breakStartMillis = 0;
  clearBreakStateNVS();
}
String formatBreakElapsed(unsigned long sec)
{
  char buf[16];
  snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", sec / 3600, (sec % 3600) / 60, sec % 60);
  return String(buf);
}

// pollFirebaseOps() and pushActiveOpsToFirebase() were removed here. They were
// the CMS <-> device ops sync channel over Firebase RTDB. With Firebase gone,
// operations are set only by ops: / opsgp: barcodes scanned at the machine.
// logBreakEventToFirebase() was removed here. It POSTed every break to
// machines/<id>/breakEvents, and nothing in any repo ever read that path — the
// device was the only writer. It also blocked the main loop for up to 3s on
// every break start/end. Breaks now go to Mongo as break_start / break_end
// events via queueEvent(), which is what the rollup actually consumes.

// ─── Scanner / TFT ────────────────────────────────────────────────────────────
HardwareSerial ScannerSerial(2);
#define SCANNER_RX 4
#define SCANNER_TX 2
#define TFT_CS 25
#define TFT_RST 33
#define TFT_DC 26
#define TFT_MOSI 27
#define TFT_SCLK 14
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_RST);

// ─── NVS ──────────────────────────────────────────────────────────────────────
Preferences preferences;
const char *CONFIG_NAMESPACE = "scanner_cfg";
const char *EMPLOYEE_NAMESPACE = "scanner_emp";
const char *SCANS_NAMESPACE = "scanner_scans";
const char *VERSION_NAMESPACE = "firmware_ver";
const char *MACHINE_NAMESPACE = "scanner_mach";

String scannedData = "";

// ─── Employee State ───────────────────────────────────────────────────────────
String currentEmployeeName = "";
String currentEmployeeId = "";
bool isEmployeeSignedIn = false;
int operatorScanCount = 0;

// ─── Event Queue (v5.5.0) ─────────────────────────────────────────────────────
// struct StoredEvent is declared in the Types block at the top of the file.

// 300 events is roughly 100 minutes of one machine's output. The screen warns
// from 80% and the heartbeat reports depth, so an outage is visible long before
// this fills. Beyond it the OLDEST event is dropped — raising this costs heap
// (each entry holds 7 Strings), so raise MAX_EVENTS_PER_POST first if the
// concern is drain speed rather than capacity.
const int MAX_STORED_SCANS = 300;
const int QUEUE_WARN_THRESHOLD = (MAX_STORED_SCANS * 8) / 10;

// Cap per request so the payload String stays small. Normally 1 on the fast
// path; only a backlog drain ever hits this.
const int MAX_EVENTS_PER_POST = 25;

StoredEvent offlineScans[MAX_STORED_SCANS];
int storedScanCount = 0;
int queueHighWater = 0;
bool isSendingBulk = false;
bool queueOverflowed = false;

// ─── LittleFS-backed durability (v5.5.0) ──────────────────────────────────────
// v5.4.0 wrote 7 NVS keys per queued scan for up to 200 scans. The default 20KB
// NVS partition cannot hold that, so the queue was silently over-committed.
const char *QUEUE_FILE = "/queue.dat";
bool fsReady = false;

// ─── Timers ───────────────────────────────────────────────────────────────────
unsigned long lastHeaderRefresh = 0;
const unsigned long HEADER_REFRESH_INTERVAL = 1000;
const long GMT_OFFSET_SEC = 19800;
const int DAYLIGHT_OFFSET_SEC = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
bool isBarcodeId(const String &id) { return id.length() > 0 && id.startsWith("WO-"); }
bool isEmployeeId(const String &id) { return id.length() > 0 && id.startsWith("GR"); }

String extractEmployeeIdFromUrl(String value)
{
  if (!value.length())
    return value;
  value.trim();
  if (value.startsWith("http://") || value.startsWith("https://"))
  {
    int ls = value.lastIndexOf('/');
    if (ls >= 0 && ls < (int)value.length() - 1)
      return value.substring(ls + 1);
  }
  return value;
}
bool isWiFiConnected() { return WiFi.status() == WL_CONNECTED; }

// v5.4.0 — getLocalTime() defaults to a 5000 ms busy-wait when the clock is
// unset. That froze the main loop 5 s on EVERY scan while offline, and once
// per stale entry inside buildBulkPayload(). Pass 0: check and return.
String getTimeHHMM()
{
  struct tm t;
  if (!getLocalTime(&t, 0))
    return "--:--";
  char buf[10];
  strftime(buf, sizeof(buf), "%H:%M", &t);
  return String(buf);
}
String getISOTimeIST()
{
  struct tm t;
  if (!getLocalTime(&t, 0))
    return "1970-01-01T00:00:00.000+05:30";
  char buf[40];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &t);
  return String(buf) + ".000+05:30";
}

// ─── Operator-facing errors (v5.5.0) ──────────────────────────────────────────
// The old messages ("Unknown: WO-4471-00", "No operator signed in") described
// the FAULT but never the FIX, so an operator's only move was to call someone
// over. Every error now answers three things:
//
//   1. what is wrong        — one or two big words, readable from arm's length
//   2. why                  — one plain sentence
//   3. WHAT TO DO           — on a white band, because this is the part that
//                             actually gets the line moving again
//   4. a code (E1..E7)      — so a supervisor on the phone knows which screen
//                             the operator is looking at
//
// Errors stay up longer than successes. Still inside SCAN_DEBOUNCE_MS, so a
// re-scan is not swallowed while the message is on screen.
const unsigned long ERROR_SHOW_MS = 3500;

// Word-wraps at maxChars, breaking on spaces. Returns the y after the last line.
int drawWrapped(const String &text, int x, int y, int maxChars, int lineH, int maxLines)
{
  int pos = 0, len = text.length(), lines = 0;
  while (pos < len && lines < maxLines)
  {
    int remaining = len - pos;
    int take = (remaining > maxChars) ? maxChars : remaining;
    if (pos + take < len)
    {
      int br = -1;
      for (int k = pos + take; k > pos; k--)
        if (text.charAt(k) == ' ')
        {
          br = k;
          break;
        }
      if (br > pos)
        take = br - pos;
    }
    String chunk = text.substring(pos, pos + take);
    chunk.trim();
    tft.setCursor(x, y);
    tft.print(chunk);
    y += lineH;
    pos += take;
    while (pos < len && text.charAt(pos) == ' ')
      pos++;
    lines++;
  }
  return y;
}

void showScanError(const char *code, const String &headline,
                   const String &what, const String &action)
{
  visualFeedbackActive = true;
  visualFeedbackIsSuccess = false;
  visualFeedbackMessage = what;
  visualFeedbackUntil = millis() + ERROR_SHOW_MS;

  tft.fillScreen(ST77XX_RED);

  // 1 — the headline, size 2, centred. Two words maximum.
  tft.setTextSize(2);
  tft.setTextColor(ST77XX_WHITE);
  int hw = headline.length() * 12;
  tft.setCursor(hw < 156 ? (160 - hw) / 2 : 2, 6);
  tft.print(headline);
  tft.drawFastHLine(0, 26, 160, ST77XX_WHITE);

  // 2 — why, in plain words
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE);
  drawWrapped(what, 4, 31, 26, 10, 3);

  // 3 — the fix, inverted so the eye lands here first
  tft.fillRect(0, 62, 160, 66, ST77XX_WHITE);
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(4, 66);
  tft.print("DO THIS:");
  tft.setTextColor(ST77XX_BLACK);
  drawWrapped(action, 4, 78, 26, 10, 4);

  // 4 — the code, for whoever the operator calls
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(140, 118);
  tft.print(code);

  Serial.println("[Error] " + String(code) + " " + headline + " — " + what);
}

// ─── Visual Feedback ──────────────────────────────────────────────────────────
void showVisualFeedback(bool isSuccess, String message)
{
  visualFeedbackActive = true;
  visualFeedbackIsSuccess = isSuccess;
  visualFeedbackMessage = message;
  visualFeedbackUntil = millis() + 2000;
  if (isSuccess)
  {
    tft.fillScreen(ST77XX_GREEN);
    tft.setTextColor(ST77XX_BLACK);
  }
  else
  {
    tft.fillScreen(ST77XX_RED);
    tft.setTextColor(ST77XX_WHITE);
  }
  tft.setTextSize(2);
  tft.setCursor(25, 35);
  tft.println(isSuccess ? "SUCCESS" : "FAILED");
  tft.setTextSize(1);
  int lineY = 65, startPos = 0;
  while (startPos < (int)message.length())
  {
    int endPos = min(startPos + 28, (int)message.length());
    if (endPos < (int)message.length())
    {
      int sp = message.lastIndexOf(' ', endPos);
      if (sp > startPos)
        endPos = sp;
    }
    tft.setCursor(5, lineY);
    tft.println(message.substring(startPos, endPos));
    lineY += 12;
    startPos = endPos + 1;
    if (lineY > 100)
      break;
  }
  tft.drawFastHLine(0, 20, 160, ST77XX_BLUE);
}

// ─── Machine helpers ──────────────────────────────────────────────────────────
String getMachineIdLast5() { return machineId.length() <= 5 ? machineId : "..." + machineId.substring(machineId.length() - 5); }
String getMachineDisplay()
{
  if (machineName.length() > 0)
  {
    String d = machineName;
    if (d.length() > 20)
      d = d.substring(0, 20);
    return d;
  }
  if (machineId.length() > 0)
    return machineId.length() <= 5 ? machineId : machineId.substring(machineId.length() - 5);
  return "NO-ID";
}
void saveMachineName(String n)
{
  preferences.begin(MACHINE_NAMESPACE, false);
  preferences.putString("mname", n);
  preferences.end();
  machineName = n;
}
void loadMachineName()
{
  preferences.begin(MACHINE_NAMESPACE, true);
  machineName = preferences.getString("mname", "");
  preferences.end();
}
void clearMachineName()
{
  machineName = "";
  preferences.begin(MACHINE_NAMESPACE, false);
  preferences.remove("mname");
  preferences.end();
}
void fetchMachineNameIfNeeded()
{
  if (machineName.length() > 0 || !isWiFiConnected() || machineId.length() == 0)
    return;
  HTTPClient http;
  http.begin(machineNameUrl() + machineId);
  http.setTimeout(5000);
  int code = http.GET();
  if (code == 200)
  {
    String body = http.getString();
    http.end();
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, body))
    {
      String name = "";
      if (doc.containsKey("name"))
        name = doc["name"].as<String>();
      else if (doc.containsKey("machine") && doc["machine"].containsKey("name"))
        name = doc["machine"]["name"].as<String>();
      if (name.length() > 0)
        saveMachineName(name);
    }
  }
  else
  {
    http.end();
  }
}
// ─── Which version does this device report? ───────────────────────────────────
// Two things are easy to confuse:
//
//   FW_VERSION  — compiled INTO the binary. What the code actually is.
//   the label   — typed into the CMS upload form. Just a name on the server.
//
// v5.4.0 made FW_VERSION win unconditionally, so that a USB-flashed unit could
// not keep reporting a stale version from NVS. Correct on its own — but it also
// threw away the label after an OTA install. With a label that does not match
// FW_VERSION (e.g. binary says 5.5.0, uploaded as "800.80") the device reported
// 5.5.0 forever, the server always saw a mismatch, and offered the SAME update
// on every single boot. A successful install changed nothing.
//
// Now both are stored: the label to report, and the FW_VERSION of the build it
// belongs to. If the running binary's FW_VERSION differs from the one recorded,
// the binary genuinely changed (a USB flash, or an OTA of a properly-bumped
// build) and the old label is discarded. Otherwise the label stands, so an
// installed OTA is remembered and the loop ends.
//
// This is a safety net, not a licence to invent version numbers. Bump
// FW_VERSION and upload under that same string — the version belongs to the
// binary, not to the form.
void saveFirmwareVersion(String v)
{
  preferences.begin(VERSION_NAMESPACE, false);
  preferences.putString("version", v);
  // FW_VERSION of the build performing the install. If the incoming image has
  // a different FW_VERSION, the next boot spots the change and drops v.
  preferences.putString("fwbuild", FW_VERSION);
  preferences.end();
  currentFirmwareVersion = v;
}

void loadFirmwareVersion()
{
  preferences.begin(VERSION_NAMESPACE, false);
  String label = preferences.getString("version", "");
  String fwbuild = preferences.getString("fwbuild", "");

  if (fwbuild != String(FW_VERSION) || label.length() == 0)
  {
    // Different binary than the one the label was recorded against — the label
    // is stale. The compiled version is the truth.
    label = String(FW_VERSION);
    preferences.putString("version", label);
    preferences.putString("fwbuild", FW_VERSION);
  }
  preferences.end();

  currentFirmwareVersion = label;
  Serial.println("[FW] build " + String(FW_VERSION) + ", reporting " + currentFirmwareVersion);
}

// ─── UI ───────────────────────────────────────────────────────────────────────
void showSplashScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  for (int i = 0; i < 160; i += 4)
  {
    tft.drawRect(i / 2, i / 4, 160 - i, 128 - i / 2, ST77XX_BLUE);
    delay(5);
  }
  tft.setTextSize(2);
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(22, 45);
  tft.println("GRAV");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(20, 43);
  tft.println("GRAV");
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(45, 70);
  tft.println("Scanner");
  for (int i = 0; i < 120; i += 10)
  {
    tft.drawLine(20, 90, 20 + i, 90, ST77XX_GREEN);
    delay(50);
  }
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(30, 105);
  tft.println("v" + currentFirmwareVersion);
  delay(1500);
  tft.fillScreen(ST77XX_BLACK);
}
// ─── FAR RIGHT: WiFi radio only ───────────────────────────────────────────────
// Signal bars — whether this device is associated with an access point, and
// nothing more.
//
// Deliberately NOT the backend status. The two fail independently, and telling
// them apart is the whole point: bars present with a red cross in the middle
// means "the WiFi is fine, the SERVER is not", which is a different problem
// from "the WiFi is down" and a different person to call.
//
// bg is the surrounding screen colour: the break screen is yellow, and
// clearing to black there would punch a hole in it.
void drawWiFiIconSmall(bool connected, uint16_t bg = ST77XX_BLACK)
{
  const int bX = 152, bY = 15;
  tft.fillRect(140, 0, 20, 18, bg);

  if (connected)
  {
    tft.fillRect(bX - 10, bY - 3, 3, 3, ST77XX_GREEN);
    tft.fillRect(bX - 6, bY - 6, 3, 6, ST77XX_GREEN);
    tft.fillRect(bX - 2, bY - 9, 3, 9, ST77XX_GREEN);
  }
  else
  {
    tft.drawLine(bX - 10, 5, bX, 15, ST77XX_RED);
    tft.drawLine(bX, 5, bX - 10, 15, ST77XX_RED);
  }
}

// ─── Queue line (partial repaint) ─────────────────────────────────────────────
// THE BUG THIS FIXES: "Pending: N" is drawn by showEmployeeScreen() at y=118,
// and that only runs on a screen transition. handleBulkSendCompletion() cleared
// the queue but never repainted, so the text stayed on screen indefinitely
// after the scans had already been delivered — the device looked stuck while
// the server had everything. (Confirmed against a heartbeat reporting
// queueDepth=0 while the screen still read Pending.)
//
// Repaints only the 16px strip, and only when the count or the connection
// state actually changed — the scanner shares this SPI bus.
void drawQueueLine()
{
  if (storedScanCount == lastDrawnQueue && backendOk == lastDrawnBackendOk) return;
  lastDrawnQueue = storedScanCount;
  lastDrawnBackendOk = backendOk;

  tft.fillRect(0, 112, 160, 16, ST77XX_BLACK);
  tft.setTextSize(1);

  if (queueOverflowed)
  {
    tft.fillRect(0, 112, 160, 16, ST77XX_RED);
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 117);
    tft.print("! DATA LOST - CALL IT !");
  }
  else if (storedScanCount >= QUEUE_WARN_THRESHOLD)
  {
    tft.fillRect(0, 112, 160, 16, ST77XX_RED);
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 117);
    tft.print("! QUEUE " + String(storedScanCount) + "/" +
              String(MAX_STORED_SCANS) + " - SERVER?");
  }
  else if (storedScanCount > 0)
  {
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 118);
    tft.print("Pending: " + String(storedScanCount));
  }
  else if (!backendOk && isWiFiConnected())
  {
    // Queue empty but the server is not answering. Worth saying so: the next
    // scan will queue rather than deliver.
    tft.setTextColor(ST77XX_RED);
    tft.setCursor(5, 118);
    tft.print("No server");
  }
  else if (updateAvailable)
  {
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 118);
    tft.print("Upd: v" + newFirmwareVersion);
  }
}
// ─── MIDDLE: BACKEND CONNECTION ───────────────────────────────────────────────
// Is this device actually talking to the server?
//
//   GREEN TICK  — connected and everything recorded is confirmed in the database
//   RED CROSS   — the server is not reachable: backend down, wrong address,
//                 wrong network, or the last send failed
//   YELLOW n    — connected and delivering, n events still in flight
//
// Paired with the WiFi bars on the far right, which show only the radio link.
// Together they separate "the WiFi is down" from "the WiFi is fine but the
// server is not answering" — different problems with different fixes, and
// previously indistinguishable from the machine.
//
// A red cross does NOT mean scans are being lost. They queue on the device and
// upload themselves on reconnect; the "Pending" line below shows how many.
void drawSyncIconSmall()
{
  const int x = 106, y = 5;
  tft.fillRect(102, 0, 36, 18, ST77XX_BLACK);
  tft.setTextSize(1);

  // Reachability is decided by backendOk ALONE — set by every heartbeat and
  // every event POST.
  //
  // lastSendConfirmed is deliberately NOT part of this test. It goes false on a
  // failed send and only returns to true after a successful one — but with an
  // empty queue there is nothing left to send, so nothing ever clears it. One
  // failed send left the cross on screen permanently while heartbeats kept
  // arriving every 60s and the server was perfectly reachable. It is still used
  // below, where it means something: a backlog that is not draining.
  if (!backendOk || queueOverflowed)
  {
    tft.drawLine(x + 2, y + 1, x + 11, y + 10, ST77XX_RED);
    tft.drawLine(x + 11, y + 1, x + 2, y + 10, ST77XX_RED);
    tft.drawLine(x + 3, y + 1, x + 12, y + 10, ST77XX_RED);
    tft.drawLine(x + 12, y + 1, x + 3, y + 10, ST77XX_RED);
    return;
  }

  // Connected, everything acknowledged — tick.
  //
  // GREEN  this scanner is delivered AND the PC is keeping the hosted CMS fed.
  // YELLOW this scanner is delivered, but the PC's hourly push to the hosted
  //        CMS is failing or overdue. Nothing is lost — the scans are safe in
  //        the local database and go up when the link returns — but head office
  //        is looking at stale numbers, and the floor should be able to see
  //        that without opening /health on the PC.
  if (unackedCount == 0)
  {
    uint16_t c = cloudSyncOk ? ST77XX_GREEN : ST77XX_YELLOW;
    tft.drawLine(x + 2, y + 5, x + 5, y + 8, c);
    tft.drawLine(x + 5, y + 8, x + 11, y + 1, c);
    tft.drawLine(x + 2, y + 6, x + 5, y + 9, c);
    tft.drawLine(x + 5, y + 9, x + 11, y + 2, c);
    return;
  }

  // Connected with a backlog — show how much is left rather than a tick that
  // would imply everything is already saved. Red if the last attempt on that
  // backlog actually failed; yellow if it is simply still in flight.
  tft.setTextColor(lastSendConfirmed ? ST77XX_YELLOW : ST77XX_RED);
  tft.setCursor(x, y);
  tft.print(unackedCount > 999 ? "999+" : String(unackedCount));
}

void drawHeader()
{
  tft.fillRect(0, 0, 160, 18, ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(4, 5);
  // Shortened from 20 chars to leave room for the sync indicator.
  String md = getMachineDisplay();
  if (md.length() > 16)
    md = md.substring(0, 16);
  tft.print(md);
  drawSyncIconSmall();
  drawWiFiIconSmall(isWiFiConnected());
  tft.drawFastHLine(0, 18, 160, ST77XX_BLUE);
}
void showScreen(String title, String line1, String line2, int bgColor = ST77XX_BLACK)
{
  tft.fillScreen(bgColor);
  drawHeader();
  tft.setTextColor(ST77XX_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 30);
  tft.println(title);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 50);
  tft.println(line1);
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(5, 70);
  tft.println(line2);
}
void showMessageNB(String line1, String line2)
{
  tft.fillRect(0, 20, 160, 100, ST77XX_BLACK);
  tft.setTextColor(ST77XX_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 40);
  tft.println(line1);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 60);
  tft.println(line2);
}
// v5.4.0 CASE 7 — field triage screen: link quality and recovery counters make
// it possible to tell a weak-signal unit from a mis-provisioned one.
void showInfoScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(1);
  tft.setCursor(5, 22);
  tft.println("DEVICE INFO");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 34);
  tft.print("M:");
  tft.setTextColor(ST77XX_WHITE);
  tft.println(machineName.length() > 0 ? machineName : (machineId.length() > 0 ? getMachineIdLast5() : "Not Set"));
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 45);
  tft.print("D:");
  tft.setTextColor(ST77XX_WHITE);
  tft.println(deviceId);
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 56);
  tft.print("W:");
  tft.setTextColor(ST77XX_WHITE);
  tft.println(wifiSSID.length() > 0 ? wifiSSID : "Not Set");
  if (isWiFiConnected())
  {
    long r = WiFi.RSSI();
    tft.setTextColor(ST77XX_CYAN);
    tft.setCursor(5, 67);
    tft.print("S:");
    tft.setTextColor(r > -60 ? ST77XX_GREEN : (r > -75 ? ST77XX_YELLOW : ST77XX_RED));
    tft.println(String(r) + "dBm ch" + String(WiFi.channel()));
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 78);
    tft.println(WiFi.localIP().toString());
  }
  else
  {
    tft.setTextColor(ST77XX_RED);
    tft.setCursor(5, 67);
    tft.println("S:DISCONNECTED");
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 78);
    tft.println("fail:" + String(wifiConnectionFailCount) + " rst:" + String(wifiRadioResetCount));
  }
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 89);
  tft.print("Ops:" + String(activeOpCount) + "  ");
  // Queue depth is now "un-acked events", which is the number that matters.
  tft.setTextColor(storedScanCount >= QUEUE_WARN_THRESHOLD
                       ? ST77XX_RED
                       : (storedScanCount > 0 ? ST77XX_YELLOW : ST77XX_GREEN));
  tft.print("Q:" + String(storedScanCount) + " hw:" + String(queueHighWater));
  // v5.5.0 — the server address is field-settable, so triage has to show it.
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 100);
  tft.println(serverHost + ":" + String(serverPort));
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(5, 113);
  tft.print("v" + currentFirmwareVersion + " b" + String(bootCount));
  tft.setTextColor(ST77XX_CYAN);
  tft.print(" S:" + String(operatorScanCount));
}
void showOpsOnScreen(int startY)
{
  if (activeOpCount == 0)
    return;
  String allOps = "";
  for (int i = 0; i < activeOpCount; i++)
  {
    if (i > 0)
      allOps += ", ";
    allOps += activeOperations[i];
  }
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_MAGENTA);
  tft.setCursor(5, startY);
  tft.print("Ops:");
  const int MAX_CHARS = 25;
  int lineY = startY, pos = 0, len = allOps.length();
  bool firstChunk = true;
  while (pos < len)
  {
    int remaining = len - pos, take = (remaining > MAX_CHARS) ? MAX_CHARS : remaining;
    if (pos + take < len)
    {
      int bA = -1;
      for (int k = pos + take - 1; k > pos; k--)
        if (allOps.charAt(k) == ' ')
        {
          bA = k;
          break;
        }
      if (bA > pos)
        take = bA - pos + 1;
    }
    String chunk = allOps.substring(pos, pos + take);
    chunk.trim();
    if (firstChunk)
    {
      tft.setTextColor(ST77XX_WHITE);
      tft.print(" ");
      tft.print(chunk);
      firstChunk = false;
      lineY += 10;
    }
    else
    {
      tft.setCursor(5, lineY);
      tft.setTextColor(ST77XX_WHITE);
      tft.print(chunk);
      lineY += 10;
    }
    pos += take;
    if (lineY > startY + 45)
      break;
  }
}
void showOpsToggleScreen(String opName, bool signedin)
{
  tft.fillRect(0, 20, 160, 108, ST77XX_BLACK);
  drawHeader();
  if (signedin)
  {
    tft.setTextColor(ST77XX_GREEN);
    tft.setCursor(5, 30);
    tft.println("OP SIGN-IN:");
  }
  else
  {
    tft.setTextColor(ST77XX_RED);
    tft.setCursor(5, 30);
    tft.println("OP SIGN-OUT:");
  }
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 42);
  String op = opName;
  if (op.length() > 22)
    op = op.substring(0, 22);
  tft.println(op);
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 54);
  tft.println("Active: " + String(activeOpCount));
  showOpsOnScreen(65);
}
void showGroupOpsToggleScreen(int count, int si, int so)
{
  tft.fillRect(0, 20, 160, 108, ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 28);
  tft.println("GROUP OPS (" + String(count) + "):");
  tft.setTextColor(ST77XX_GREEN);
  tft.setCursor(5, 40);
  tft.print("+" + String(si) + " in  ");
  tft.setTextColor(ST77XX_RED);
  tft.print("-" + String(so) + " out");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 52);
  tft.println("Active: " + String(activeOpCount));
  showOpsOnScreen(63);
}
// showFirebaseSyncScreen() removed — it announced a CMS-pushed ops change, and
// ops can no longer arrive from the CMS.
void drawNameLine(int y, uint16_t bg)
{
  bool onY = (bg == ST77XX_YELLOW);
  tft.setTextSize(1);
  tft.setCursor(5, y);
  tft.setTextColor(onY ? ST77XX_BLACK : ST77XX_GREEN);
  tft.print("ID: ");
  String nm = currentEmployeeId;
  if ((int)nm.length() > 20)
    nm = nm.substring(0, 18) + "..";
  tft.setTextColor(onY ? ST77XX_BLACK : ST77XX_WHITE);
  tft.print(nm);
}
void showEmployeeScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  drawNameLine(28, ST77XX_BLACK);
  tft.setTextColor(ST77XX_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 40);
  tft.print("Scans today: ");
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(1);
  tft.print(operatorScanCount);
  showOpsOnScreen(56);
  // The queue/status line is drawn by drawQueueLine() rather than inline here,
  // so the same strip is painted by exactly one function whether it is a full
  // screen redraw or the 1s refresh. It used to be duplicated, and only this
  // copy ever ran — which is why a cleared queue kept showing "Pending".
  lastDrawnQueue = -1; // force a paint on this full redraw
  drawQueueLine();
}
void showNoOperatorScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_RED);
  tft.setTextSize(1);
  tft.setCursor(5, 35);
  tft.println("NO OPERATOR");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 50);
  tft.println("Scan ID card to begin");
  showOpsOnScreen(65);
  // Queued events and a dead server both outlive a sign-out, so this screen
  // has to show them too. Without it a machine could sit all night with
  // undelivered scans and nothing on screen to say so.
  lastDrawnQueue = -1;
  drawQueueLine();
}

// ─── Spinner (retained; no longer used by bulk send) ─────────────────────────
static void drawSpinnerFrame(int head)
{
  const int cx = 80, cy = 76, R = 22, dotR = 3, N = 8;
  tft.fillRect(cx - R - dotR - 1, cy - R - dotR - 1, 2 * (R + dotR + 1), 2 * (R + dotR + 1), SPINNER_BG);
  for (int i = 0; i < N; i++)
  {
    float angle = ((float)i / (float)N) * 2.0f * PI - (PI / 2.0f);
    int x = cx + (int)(cos(angle) * R), y = cy + (int)(sin(angle) * R);
    int dist = (i - head + N) % N;
    uint16_t col;
    switch (dist)
    {
    case 0:
      col = ST77XX_WHITE;
      break;
    case 1:
      col = tft.color565(210, 210, 230);
      break;
    case 2:
      col = tft.color565(140, 140, 170);
      break;
    case 3:
      col = tft.color565(80, 80, 110);
      break;
    default:
      col = tft.color565(40, 40, 65);
      break;
    }
    tft.fillCircle(x, y, dotR, col);
  }
}
static void spinnerTaskFn(void *)
{
  int head = 0;
  while (spinnerRunning)
  {
    drawSpinnerFrame(head);
    head = (head + 1) % 8;
    vTaskDelay(pdMS_TO_TICKS(110));
  }
  vTaskDelete(NULL);
}
void startSpinner()
{
  if (spinnerRunning)
    return;
  tft.fillScreen(SPINNER_BG);
  tft.fillRect(0, 0, 160, 18, ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(4, 5);
  tft.print(getMachineDisplay());
  drawWiFiIconSmall(isWiFiConnected());
  tft.drawFastHLine(0, 18, 160, ST77XX_BLUE);
  spinnerRunning = true;
  xTaskCreatePinnedToCore(spinnerTaskFn, "spin", 2048, NULL, 1, &spinnerTaskHandle, 0);
}
void stopSpinner()
{
  if (!spinnerRunning)
    return;
  spinnerRunning = false;
  delay(160);
  spinnerTaskHandle = NULL;
}

// ─── Break Screen ─────────────────────────────────────────────────────────────
void refreshBreakTimerArea()
{
  tft.fillRect(0, 72, 160, 28, ST77XX_YELLOW);
  tft.setTextSize(2);
  tft.setTextColor(ST77XX_BLACK);
  tft.setCursor(5, 78);
  tft.print(formatBreakElapsed(getBreakElapsedSeconds()));
}
void showBreakScreen()
{
  tft.fillScreen(ST77XX_YELLOW);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_BLACK);
  tft.setCursor(4, 5);
  tft.print(getMachineDisplay());
  // Same tick/cross as every other screen. This used to draw its own signal
  // bars, so a device on a break showed a different — and less truthful —
  // indicator than the same device thirty seconds earlier.
  drawWiFiIconSmall(isWiFiConnected(), ST77XX_YELLOW);
  tft.drawFastHLine(0, 18, 160, ST77XX_BLACK);
  drawNameLine(22, ST77XX_YELLOW);
  tft.setTextColor(ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setCursor(5, 34);
  tft.print("Scans: ");
  tft.print(operatorScanCount);
  tft.setTextSize(2);
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(5, 50);
  tft.print("[");
  tft.print(breakReasonLabelShort(currentBreakReason));
  tft.print("]");
  refreshBreakTimerArea();
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_BLACK);
  tft.setCursor(5, 105);
  tft.print("Scan same = end");
  tft.setCursor(5, 117);
  tft.print("Scan other = resume");
}
void returnToHomeScreen()
{
  if (isInBreakMode())
  {
    showBreakScreen();
    lastBreakScreenRefresh = millis();
  }
  else if (isEmployeeSignedIn)
    showEmployeeScreen();
  else
    showNoOperatorScreen();
}

// ─── OTA ──────────────────────────────────────────────────────────────────────
void showUpdateScreen(String status, int progress = -1)
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(1);
  tft.setCursor(5, 30);
  tft.println("FIRMWARE UPDATE");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 50);
  tft.println("v" + currentFirmwareVersion + "->v" + newFirmwareVersion);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 70);
  tft.println(status);
  if (progress >= 0)
  {
    int bW = 140, bX = 10, bY = 90;
    tft.drawRect(bX, bY, bW, 10, ST77XX_WHITE);
    tft.fillRect(bX, bY, (progress * bW) / 100, 10, ST77XX_GREEN);
    tft.setCursor(bX + 60, bY + 15);
    tft.print(String(progress) + "%");
  }
}
void reconcileBreakEpochIfNeeded()
{
  if (currentBreakReason == BREAK_NONE || breakStartEpoch > 0)
    return;
  time_t now;
  time(&now);
  if (now > 1700000000UL)
  {
    breakStartEpoch = now;
    breakStartedThisSession = true;
    saveBreakState();
  }
}
bool checkForUpdates()
{
  if (!isWiFiConnected() || deviceId.length() == 0)
    return false;
  HTTPClient http;
  http.begin(deviceRegisterUrl());
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);
  StaticJsonDocument<384> doc;
  doc["deviceId"] = deviceId;
  doc["machineId"] = machineId;
  doc["currentVersion"] = currentFirmwareVersion;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiSSID"] = wifiSSID;
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  if (code == 200)
  {
    String resp = http.getString();
    http.end();
    StaticJsonDocument<1024> r;
    if (!deserializeJson(r, resp))
    {
      bool upd = r["updateAvailable"] | false;
      if (upd && r.containsKey("firmware"))
      {
        JsonObject fw = r["firmware"];
        newFirmwareVersion = fw["version"].as<String>();
        newFirmwareUrl = fw["url"].as<String>();
        if (newFirmwareVersion.length() > 0 && newFirmwareUrl.length() > 0)
        {
          // Skip a version that already failed on this boot. Without this a bad
          // upload — wrong file, truncated transfer — is retried on every check
          // and after every watchdog reboot, which is what made one bad file
          // look like an endless download loop.
          if (otaFailedVersion.length() > 0 && newFirmwareVersion == otaFailedVersion)
          {
            Serial.println("[OTA] Skipping " + newFirmwareVersion + " — already failed this boot");
            updateAvailable = false;
            return false;
          }
          updateAvailable = true;
          return true;
        }
      }
      else
      {
        updateAvailable = false;
      }
    }
  }
  else
  {
    http.end();
  }
  return false;
}
bool performOTAUpdate()
{
  if (!updateAvailable || newFirmwareUrl.length() == 0)
    return false;
  showUpdateScreen("Connecting...", 0);
  HTTPClient http;
  http.begin(newFirmwareUrl);
  http.setTimeout(30000);
  int code = http.GET();
  if (code != 200)
  {
    showMessageNB("Update Failed", "HTTP " + String(code));
    delay(3000);
    http.end();
    return false;
  }
  int cl = http.getSize();

  // A real application image is over a megabyte. boot_app0.bin (8KB), the
  // partition table (3KB) and the bootloader (25KB) all sit in the same build
  // folder and are easy to upload by mistake — the old check was only cl > 0,
  // so an 8KB file was accepted and the device then waited forever for bytes
  // that were never coming.
  if (cl < MIN_FIRMWARE_BYTES)
  {
    showMessageNB("Wrong file", cl <= 0 ? "No size sent" : String(cl / 1024) + "KB - need .ino.bin");
    delay(4000);
    http.end();
    otaFailedVersion = newFirmwareVersion; // do not retry this one on every boot
    return false;
  }

  if (!Update.begin(cl))
  {
    showMessageNB("Update Failed", "No space");
    delay(3000);
    http.end();
    otaFailedVersion = newFirmwareVersion;
    return false;
  }

  WiFiClient *stream = http.getStreamPtr();
  size_t written = 0;
  int lastProg = 0;
  unsigned long lastByteAt = millis();

  // The old loop could only exit by completing. If the stream stalled — a
  // dropped connection, a slow cloud host, a WiFi hiccup mid-transfer —
  // available() returned 0 forever and this spun until the watchdog rebooted
  // the device, which then found the same update and started over. That is the
  // "downloads again and again, stuck at 50%" loop.
  while (written < (size_t)cl)
  {
    size_t av = stream->available();

    if (av)
    {
      uint8_t buf[1024]; // 4x the old buffer: fewer iterations, faster transfer
      size_t rd = stream->readBytes(buf, av > sizeof(buf) ? sizeof(buf) : av);
      if (rd > 0)
      {
        size_t w = Update.write(buf, rd);
        // A short write means the flash write failed. Continuing would silently
        // corrupt the image and only surface as a boot loop after reboot.
        if (w != rd)
        {
          Update.abort();
          showMessageNB("Update Failed", "Flash write error");
          delay(3000);
          http.end();
          otaFailedVersion = newFirmwareVersion;
          return false;
        }
        written += w;
        lastByteAt = millis();

        int prog = (written * 100) / cl;
        if (prog >= lastProg + 5)
        {
          showUpdateScreen("Downloading...", prog);
          lastProg = prog;
        }
      }
    }
    else
    {
      // No data right now. Give up if the peer has gone or nothing has arrived
      // for a while — better a clean failure and a working old firmware than a
      // hang that the watchdog turns into a reboot loop.
      if (!stream->connected() && stream->available() == 0)
      {
        Update.abort();
        showMessageNB("Update Failed", "Connection lost at " + String(lastProg) + "%");
        delay(3000);
        http.end();
        otaFailedVersion = newFirmwareVersion;
        return false;
      }
      if (millis() - lastByteAt > OTA_STALL_TIMEOUT_MS)
      {
        Update.abort();
        showMessageNB("Update Failed", "Stalled at " + String(lastProg) + "%");
        delay(3000);
        http.end();
        otaFailedVersion = newFirmwareVersion;
        return false;
      }
      delay(2); // yields to the WiFi task
    }
    // A 1.2MB download legitimately takes far longer than the loop watchdog
    // allows, and delay() does not feed it — only this does. Without it the
    // watchdog would reboot the device mid-update, every time.
    feedWatchdog();
  }

  // end() with no argument, deliberately: the overload end(true) means "finish
  // EVEN IF bytes are still outstanding", which would happily install a
  // truncated image. The default refuses unless the whole image arrived.
  if (Update.end())
  {
    showUpdateScreen("Installing...", 100);
    delay(2000);
    saveFirmwareVersion(newFirmwareVersion);
    http.end();
    return true;
  }

  Update.abort();
  showMessageNB("Update Failed", Update.errorString());
  delay(3000);
  http.end();
  otaFailedVersion = newFirmwareVersion;
  return false;
}

// ─── NVS: Config ──────────────────────────────────────────────────────────────
void saveConfig(String ssid, String pass, String mId, String mName = "")
{
  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.putString("wifi_ssid", ssid);
  preferences.putString("wifi_pass", pass);
  preferences.putString("machine_id", mId);
  preferences.putBool("wifi_configured", true);
  preferences.putBool("machine_configured", true);
  preferences.end();
  wifiSSID = ssid;
  wifiPass = pass;
  machineId = mId;
  wifiConfigured = true;
  machineIdConfigured = true;
  if (mName.length() > 0)
    saveMachineName(mName);
  else
    clearMachineName();
}
void loadConfig()
{
  preferences.begin(CONFIG_NAMESPACE, true);
  wifiSSID = preferences.getString("wifi_ssid", "");
  wifiPass = preferences.getString("wifi_pass", "");
  machineId = preferences.getString("machine_id", "");
  uint64_t chipid = ESP.getEfuseMac();
  deviceId = String((uint32_t)chipid, HEX);
  deviceId.toUpperCase();
  while (deviceId.length() < 8)
    deviceId = "0" + deviceId;
  if (deviceId.length() > 8)
    deviceId = deviceId.substring(deviceId.length() - 8);
  wifiConfigured = preferences.getBool("wifi_configured", false);
  machineIdConfigured = preferences.getBool("machine_configured", false);
  preferences.end();
}
void clearConfig()
{
  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.clear();
  preferences.end();
  clearMachineName();
}

// ─── NVS: Employee ────────────────────────────────────────────────────────────
void saveEmployeeData()
{
  preferences.begin(EMPLOYEE_NAMESPACE, false);
  preferences.putString("empName", currentEmployeeName);
  preferences.putString("empId", currentEmployeeId);
  preferences.putBool("empSignedIn", isEmployeeSignedIn);
  preferences.putInt("empScanCount", operatorScanCount);
  preferences.end();
}
// persistOperatorCountNVS() was removed. It wrote the on-screen tally to flash
// on EVERY counted piece — 500+ commits a shift of needless wear for a display
// value the server already derives from the events. maybeCountWO() now sets
// nvsDirty and lets the 5-minute persistNVS() safety net handle it.
void loadEmployeeData()
{
  preferences.begin(EMPLOYEE_NAMESPACE, true);
  currentEmployeeName = preferences.getString("empName", "");
  currentEmployeeId = preferences.getString("empId", "");
  isEmployeeSignedIn = preferences.getBool("empSignedIn", false);
  operatorScanCount = preferences.getInt("empScanCount", 0);
  preferences.end();
  if (currentEmployeeName.isEmpty())
  {
    isEmployeeSignedIn = false;
    currentEmployeeId = "";
    operatorScanCount = 0;
  }
}
void clearEmployeeData()
{
  currentEmployeeName = "";
  currentEmployeeId = "";
  isEmployeeSignedIn = false;
  operatorScanCount = 0;
  preferences.begin(EMPLOYEE_NAMESPACE, false);
  preferences.clear();
  preferences.end();
}

// ─── Queue persistence: LittleFS (v5.5.0) ─────────────────────────────────────
// Records are unit-separator delimited (0x1F). That byte cannot occur in a
// barcode, an operator id or an operation code, so there is nothing to escape
// and nothing to get wrong at 3am.
//
// Field order:
//   eventId ¦ type ¦ machineId ¦ operatorId ¦ barcodeId ¦ activeOps
//           ¦ breakReason ¦ breakDurationSec ¦ scanEpoch ¦ timeRecovered
//
// millisAtScan is deliberately NOT persisted: millis() resets on reboot, so a
// stored value would be meaningless. A reboot before NTP means that event keeps
// whatever epoch it already had (0 if never known) and the server stamps it.
const char SEP = '\x1F';

void initQueueFS()
{
  fsReady = LittleFS.begin(true); // true = format if the partition is blank
  if (!fsReady)
  {
    Serial.println("[FS] LittleFS mount FAILED — queue is RAM-only this boot");
    return;
  }
  Serial.println("[FS] LittleFS ready");
}

static String serializeEvent(const StoredEvent &e)
{
  String r;
  r.reserve(160);
  r += e.eventId;
  r += SEP;
  r += e.type;
  r += SEP;
  r += e.machineId;
  r += SEP;
  r += e.operatorId;
  r += SEP;
  r += e.barcodeId;
  r += SEP;
  r += e.activeOps;
  r += SEP;
  r += e.breakReason;
  r += SEP;
  r += String(e.breakDurationSec);
  r += SEP;
  r += String((uint32_t)e.scanEpoch);
  r += SEP;
  r += (e.timeRecovered ? "1" : "0");
  return r;
}

static bool deserializeEvent(const String &line, StoredEvent &out)
{
  String f[10];
  int idx = 0, start = 0;
  for (int i = 0; i <= (int)line.length() && idx < 10; i++)
  {
    if (i == (int)line.length() || line.charAt(i) == SEP)
    {
      f[idx++] = line.substring(start, i);
      start = i + 1;
    }
  }
  if (idx < 10 || f[0].length() == 0)
    return false;

  out.eventId = f[0];
  out.type = f[1];
  out.machineId = f[2];
  out.operatorId = f[3];
  out.barcodeId = f[4];
  out.activeOps = f[5];
  out.breakReason = f[6];
  out.breakDurationSec = (uint32_t)f[7].toInt();
  out.scanEpoch = (time_t)f[8].toInt();
  out.timeRecovered = (f[9] == "1");
  out.millisAtScan = 0; // meaningless across a reboot
  return true;
}

// Append is the hot path: one short write per scan, no read-modify-write.
void queueAppendToFS(const StoredEvent &e)
{
  if (!fsReady)
    return;
  File f = LittleFS.open(QUEUE_FILE, FILE_APPEND);
  if (!f)
  {
    Serial.println("[FS] append failed");
    return;
  }
  f.println(serializeEvent(e));
  f.close();
}

// Called after a successful send, when entries have been removed from the head
// of the RAM array. Rewrites the file to match.
void queueRewriteFS()
{
  if (!fsReady)
    return;
  // Common case after a per-scan send: nothing left unconfirmed. Removing the
  // file is a single directory operation, cheaper than open-truncate-close, and
  // this path runs on the main loop after every scan.
  if (storedScanCount == 0)
  {
    if (LittleFS.exists(QUEUE_FILE))
      LittleFS.remove(QUEUE_FILE);
    return;
  }
  File f = LittleFS.open(QUEUE_FILE, FILE_WRITE); // truncates
  if (!f)
  {
    Serial.println("[FS] rewrite failed");
    return;
  }
  for (int i = 0; i < storedScanCount; i++)
    f.println(serializeEvent(offlineScans[i]));
  f.close();
}

void queueLoadFromFS()
{
  storedScanCount = 0;
  if (!fsReady || !LittleFS.exists(QUEUE_FILE))
    return;
  File f = LittleFS.open(QUEUE_FILE, FILE_READ);
  if (!f)
    return;
  while (f.available() && storedScanCount < MAX_STORED_SCANS)
  {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      continue;
    if (deserializeEvent(line, offlineScans[storedScanCount]))
      storedScanCount++;
  }
  f.close();
  if (storedScanCount > queueHighWater)
    queueHighWater = storedScanCount;
  Serial.println("[FS] Restored " + String(storedScanCount) + " queued event(s)");
}

void queueClearFS()
{
  if (fsReady && LittleFS.exists(QUEUE_FILE))
    LittleFS.remove(QUEUE_FILE);
}

// Names kept from v5.4.0 so every existing call site still reads the same.
void saveScansData() { queueRewriteFS(); }
void loadScansData() { queueLoadFromFS(); }
void clearScansData()
{
  storedScanCount = 0;
  unackedCount = 0;
  queueClearFS();
  // v5.4.0 also kept scans in NVS. Clear that namespace too so an upgraded
  // device does not leave orphaned keys behind consuming the partition.
  preferences.begin(SCANS_NAMESPACE, false);
  preferences.clear();
  preferences.end();
}

// ─── Periodic NVS Persist (safety net) ───────────────────────────────────────
void persistNVS()
{
  if (!nvsDirty)
    return;
  saveScansData();
  saveWOHistory();
  saveEmployeeData();
  saveOpsToNVS();
  nvsDirty = false;
  Serial.println("[NVS] Flushed");
}

// ─── Memory Wipe ──────────────────────────────────────────────────────────────
void wipeAllMemory()
{
  endBreak("wipe");
  clearEmployeeData();
  clearScansData();
  clearWOHistory();
  clearConfig();
  clearMachineName();
  activeOpCount = 0;
  for (int i = 0; i < MAX_ACTIVE_OPS; i++)
    activeOperations[i] = "";
  clearOpsNVS(); // v5.4.0
  wifiSSID = "";
  wifiPass = "";
  machineId = "";
  machineName = "";
  wifiConfigured = false;
  machineIdConfigured = false;
  nvsDirty = false;
}

// ─── Event identity (v5.5.0) ──────────────────────────────────────────────────
void loadBootCount()
{
  Preferences p;
  p.begin(BOOT_NAMESPACE, false);
  bootCount = p.getUInt("boot", 0) + 1;
  p.putUInt("boot", bootCount);
  p.end();
  eventSeq = 0;
  Serial.println("[Boot] count=" + String(bootCount));
}

// Unique for the life of the device, identical on every retry of the same
// event. That combination is what makes at-least-once delivery safe.
String nextEventId()
{
  return deviceId + "-" + String(bootCount) + "-" + String(eventSeq++);
}

String isoFromEpoch(time_t epoch)
{
  if (epoch <= 0)
    return "";
  struct tm t;
  localtime_r(&epoch, &t);
  char buf[40];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &t);
  return String(buf) + ".000+05:30";
}

// ─── Clock recovery (v5.5.0) ──────────────────────────────────────────────────
// v5.4.0 rewrote unset timestamps to the time the batch was SENT, which made a
// 09:15 scan flushed at 14:00 look like it happened at 14:00 — and destroyed
// any possibility of computing pace. Instead: once NTP lands, work backwards
// from elapsed millis to the instant each event actually occurred.
void recoverQueuedTimes()
{
  time_t now;
  time(&now);
  if (now <= 1700000000UL)
    return;
  clockValid = true;

  unsigned long nowMs = millis();
  int fixed = 0;
  for (int i = 0; i < storedScanCount; i++)
  {
    if (offlineScans[i].scanEpoch > 0)
      continue;
    if (offlineScans[i].millisAtScan == 0)
      continue; // survived a reboot — elapsed time is unknowable, server stamps it
    unsigned long elapsedMs = (nowMs >= offlineScans[i].millisAtScan)
                                  ? (nowMs - offlineScans[i].millisAtScan)
                                  : 0;
    offlineScans[i].scanEpoch = now - (time_t)(elapsedMs / 1000UL);
    offlineScans[i].timeRecovered = true;
    fixed++;
  }
  if (fixed > 0)
  {
    Serial.println("[Time] Recovered true scan time for " + String(fixed) + " event(s)");
    queueRewriteFS();
  }
}

// ─── Background send (v5.5.0) ─────────────────────────────────────────────────
// Triggered on EVERY scan, not every 5 scans / 5 minutes. Runs on core 0 so a
// dead server can never freeze the display or cause a missed barcode.
int drainCount()
{
  return storedScanCount < MAX_EVENTS_PER_POST ? storedScanCount
                                               : MAX_EVENTS_PER_POST;
}

String buildBulkPayload(int count)
{
  String rb = "{\"events\":[";
  for (int i = 0; i < count; i++)
  {
    if (i > 0)
      rb += ",";
    const StoredEvent &e = offlineScans[i];

    rb += "{\"eventId\":\"" + e.eventId + "\"";
    rb += ",\"type\":\"" + e.type + "\"";
    // machineId comes from the EVENT, not from current state. v5.4.0 stamped
    // whatever was current at flush time, so a mid-shift machine change
    // re-attributed already-queued scans.
    rb += ",\"machineId\":\"" + e.machineId + "\"";
    rb += ",\"deviceId\":\"" + deviceId + "\"";
    if (e.operatorId.length() > 0)
      rb += ",\"operatorId\":\"" + e.operatorId + "\"";
    if (e.barcodeId.length() > 0)
      rb += ",\"barcodeId\":\"" + e.barcodeId + "\"";
    rb += ",\"activeOps\":\"" + e.activeOps + "\"";

    // Empty scanTime is honest: the clock was never set and elapsed millis was
    // lost to a reboot. The server stamps it and flags it, rather than the
    // device inventing a plausible-looking lie.
    String iso = isoFromEpoch(e.scanEpoch);
    if (iso.length() > 0)
      rb += ",\"scanTime\":\"" + iso + "\"";
    rb += ",\"timeRecovered\":" + String(e.timeRecovered ? "true" : "false");

    if (e.breakReason.length() > 0)
      rb += ",\"breakReason\":\"" + e.breakReason + "\"";
    if (e.breakDurationSec > 0)
      rb += ",\"breakDurationSec\":" + String(e.breakDurationSec);

    rb += "}";
  }
  rb += "]}";
  return rb;
}

void bulkSendTaskFn(void *param)
{
  SendJob *job = (SendJob *)param;
  const uint32_t myGen = job->gen;

  HTTPClient http;
  http.begin(eventsUrl());
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");
  // setReuse(false), deliberately.
  //
  // This task issues exactly ONE request and then calls vTaskDelete(NULL),
  // which never returns — so the C++ destructor of `http` never runs. With
  // reuse ON, end() takes the "tcp keep open for reuse" branch and leaves the
  // socket open for a second request that this task will never make; only
  // ~HTTPClient() would have closed it, and it is never reached.
  //
  // lwIP has a fixed socket table (16 by default). One leaked socket per
  // request means the device stops being able to open ANY connection after a
  // few minutes of scanning: every send fails, the indicator goes permanently
  // red, and nothing short of a power cycle clears it — while WiFi still shows
  // full bars, because the association is fine. That is the red cross that
  // could never be reproduced from a browser.
  //
  // Reuse bought nothing here in the first place: there is no second request on
  // this client. Turning it off makes end() call stop() and hand the socket
  // back before the task exits.
  http.setReuse(false);
  // Short timeout. On a healthy LAN this completes in ~20ms; a long timeout
  // only delays discovering that the server is down.
  http.setTimeout(5000);
  int code = http.POST(job->payload);
  http.end();
  delete job; // the payload dies with the attempt that owned it

  // If the main loop gave up on this attempt and started another, this task is
  // an orphan. Reporting now would attribute THIS result to the newer send —
  // including a false success, which would delete scans that were never
  // delivered. Leave every shared variable alone and exit quietly.
  if (myGen != bulkGeneration)
  {
    Serial.println("[Send] Stale task finished (HTTP " + String(code) + "), result discarded");
    vTaskDelete(NULL);
  }

  bulkHttpCode = code;
  bulkTaskResult = (code >= 200 && code < 300) ? 1 : 2;
  // A successful event POST proves the backend is reachable just as well as a
  // heartbeat, and happens far more often while someone is scanning — so the
  // indicator goes green on the first scan rather than waiting up to 60s.
  // Same streak rule: one failed send must not flip the indicator on its own.
  noteBackendResult(bulkTaskResult == 1);
  bulkTaskDone = true;
  bulkTaskHandle = NULL;
  vTaskDelete(NULL);
}

void startBackgroundBulkSend()
{
  if (!isWiFiConnected() || storedScanCount == 0 || isSendingBulk)
    return;

  SendJob *job = new SendJob();
  if (!job)
  {
    Serial.println("[Send] Out of memory, will retry"); // queue untouched
    return;
  }
  bulkPendingCount = drainCount();
  job->gen = ++bulkGeneration;
  job->payload = buildBulkPayload(bulkPendingCount);

  bulkTaskDone = false;
  bulkTaskResult = 0;
  bulkHttpCode = 0;
  bulkStartedAt = millis();
  isSendingBulk = true;
  BaseType_t ok = xTaskCreatePinnedToCore(bulkSendTaskFn, "bulksend", 12288, job, 1, &bulkTaskHandle, 0);
  if (ok != pdPASS)
  {
    delete job;
    isSendingBulk = false;
    bulkPendingCount = 0;
    Serial.println("[Send] Task create failed");
  }
}

// Fire the sender immediately. This is what makes the send per-scan.
void kickSender()
{
  if (isWiFiConnected() && !isSendingBulk && storedScanCount > 0)
    startBackgroundBulkSend();
}

void handleBulkSendCompletion()
{
  if (!isSendingBulk || !bulkTaskDone)
    return;

  if (bulkTaskResult == 1)
  {
    int sent = bulkPendingCount;
    if (sent >= storedScanCount)
      storedScanCount = 0;
    else
    {
      for (int i = sent; i < storedScanCount; i++)
        offlineScans[i - sent] = offlineScans[i];
      storedScanCount -= sent;
    }
    unackedCount = storedScanCount;
    lastSendConfirmed = true;
    queueOverflowed = false;

    // Only the queue file is rewritten here, and it MUST be: it is the record
    // of what is still unconfirmed, so a reboot would otherwise re-send.
    queueRewriteFS();

    // saveEmployeeData() / saveWOHistory() / saveOpsToNVS() used to run here on
    // every confirmed send — which, since sends are per-scan, meant every scan.
    // saveWOHistory() alone does an NVS clear() plus up to 41 key writes, and
    // an NVS page compaction lands in the hundreds of milliseconds. That was
    // the intermittent scan freeze, and it worsened through the shift as
    // woHistory filled.
    //
    // None of it was needed: each of those is already persisted at the moment
    // its data changes (addWOToHistory on add, saveEmployeeData on sign-in/out,
    // markOpsChangedLocally on an ops toggle). Flag it for the 5-minute
    // persistNVS() safety net instead of re-writing everything per scan.
    nvsDirty = true;
    // Repaint immediately rather than waiting for the next 1s tick, so the
    // "Pending" line clears the moment the server confirms. Without this the
    // operator sees stale text and assumes the scan did not go through.
    if (isEmployeeSignedIn && !visualFeedbackActive && !isInBreakMode() && !infoModeActive)
      drawQueueLine();
    Serial.println("[Send] OK: " + String(sent) + " confirmed, " +
                   String(storedScanCount) + " still queued");

    // A backlog drains 25 at a time — keep going without waiting for a timer.
    if (storedScanCount > 0)
      sendBatchNow = true;
  }
  else
  {
    lastSendConfirmed = false;
    Serial.println("[Send] Failed HTTP " + String(bulkHttpCode) +
                   " — " + String(storedScanCount) + " queued, will retry");
  }

  bulkPendingCount = 0;
  bulkTaskDone = false;
  bulkTaskResult = 0;
  isSendingBulk = false;
  bulkStartedAt = 0; // completed normally — nothing for the watchdog to reclaim
}

bool sendBulkScans()
{
  startBackgroundBulkSend();
  return isSendingBulk;
}

// ─── Heartbeat (v5.5.0) ───────────────────────────────────────────────────────
void heartbeatTaskFn(void *param)
{
  SendJob *job = (SendJob *)param;
  const uint32_t myGen = job->gen;

  HTTPClient http;
  http.begin(heartbeatUrl());
  http.addHeader("Content-Type", "application/json");
  // Same reason as bulkSendTaskFn — see the note there.
  http.setReuse(false);
  http.setTimeout(4000);
  int code = http.POST(job->payload);

  // The reply carries the server's own sync health. Read it BEFORE http.end(),
  // and only on success — an error body is HTML or empty, never our JSON.
  bool cloudOk = true;
  if (code >= 200 && code < 300)
  {
    String body = http.getString();
    // Deliberately a substring test rather than a JSON parse: this runs in a
    // background task with a fixed stack, and allocating a document per minute
    // to read one boolean is not worth the heap. Absent field -> stays true,
    // which is what keeps this compatible with an older server build.
    if (body.indexOf("\"cloudSyncOk\":false") >= 0)
      cloudOk = false;
  }
  http.end();
  delete job;

  // Orphaned by the stuck-task watchdog — a newer heartbeat owns the flag now.
  // A minute-old verdict must not colour the indicator.
  if (myGen != hbGeneration)
    vTaskDelete(NULL);

  cloudSyncOk = cloudOk;

  // The heartbeat result was previously discarded, which left the device with
  // no way to tell "WiFi associated" from "the server is actually answering".
  // The header showed WiFi bars while every send was failing. This is the only
  // signal that runs on a timer regardless of whether anyone is scanning, so
  // it is what the connection indicator is based on.
  bool ok = (code >= 200 && code < 300);
  noteBackendResult(ok);

  // A successful heartbeat with an empty queue means there is nothing
  // outstanding, so an old send failure is history. Clearing it here stops a
  // single past failure colouring the indicator for the rest of the shift.
  if (ok && storedScanCount == 0)
    lastSendConfirmed = true;

  hbStartedAt = 0;
  hbTaskRunning = false;
  vTaskDelete(NULL);
}

void sendHeartbeat()
{
  if (!isWiFiConnected() || hbTaskRunning || deviceId.length() == 0)
    return;

  StaticJsonDocument<640> doc;
  doc["deviceId"] = deviceId;
  doc["machineId"] = machineId;
  doc["machineName"] = machineName;
  doc["firmwareVersion"] = currentFirmwareVersion;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiSSID"] = wifiSSID;
  doc["rssi"] = (int)WiFi.RSSI();
  doc["wifiChannel"] = (int)WiFi.channel();
  doc["queueDepth"] = storedScanCount;
  doc["queueHighWater"] = queueHighWater;
  doc["currentOperatorId"] = isEmployeeSignedIn ? currentEmployeeId : "";
  doc["activeOps"] = getActiveOpsString();
  doc["onBreak"] = isInBreakMode();
  doc["bootCount"] = bootCount;
  doc["uptimeSec"] = (uint32_t)(millis() / 1000UL);
  // Tells a watchdog reboot apart from someone switching the machine off.
  doc["resetReason"] = resetReasonText();

  SendJob *job = new SendJob();
  if (!job)
    return; // next tick will try again
  job->gen = ++hbGeneration;
  serializeJson(doc, job->payload);

  hbStartedAt = millis();
  hbTaskRunning = true;
  TaskHandle_t h = NULL;
  if (xTaskCreatePinnedToCore(heartbeatTaskFn, "hbeat", 8192, job, 1, &h, 0) != pdPASS)
  {
    delete job;
    hbTaskRunning = false;
  }
}

// ─── REFRESH_SYSTEM ───────────────────────────────────────────────────────────
// Rechecks everything the indicator depends on, right now, and shows each part
// on its own line. Runs on the main loop and BLOCKS for a few seconds — that is
// deliberate: the operator is standing there waiting for an answer, and a
// background task would hand back the same stale indicator it was scanned to
// resolve.
// One blocking heartbeat, used by the refresh check. Separate from
// sendHeartbeat() because that one hands the work to a background task and
// returns before there is an answer — useless when someone is standing at the
// machine waiting for a verdict.
bool probeServer(bool *dbOk, bool *cloudOk, int *httpCode)
{
  *dbOk = false;
  *cloudOk = true;
  *httpCode = 0;
  if (!isWiFiConnected() || deviceId.length() == 0) return false;

  StaticJsonDocument<640> doc;
  doc["deviceId"] = deviceId;
  doc["machineId"] = machineId;
  doc["machineName"] = machineName;
  doc["firmwareVersion"] = currentFirmwareVersion;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiSSID"] = wifiSSID;
  doc["rssi"] = (int)WiFi.RSSI();
  doc["wifiChannel"] = (int)WiFi.channel();
  doc["queueDepth"] = storedScanCount;
  doc["queueHighWater"] = queueHighWater;
  doc["currentOperatorId"] = isEmployeeSignedIn ? currentEmployeeId : "";
  doc["activeOps"] = getActiveOpsString();
  doc["onBreak"] = isInBreakMode();
  doc["bootCount"] = bootCount;
  doc["uptimeSec"] = (uint32_t)(millis() / 1000UL);
  doc["resetReason"] = resetReasonText();
  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(heartbeatUrl());
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(6000);
  *httpCode = http.POST(payload);
  bool ok = (*httpCode >= 200 && *httpCode < 300);
  if (ok)
  {
    String body = http.getString();
    *dbOk = body.indexOf("\"dbOk\":false") < 0;          // absent => assume ok
    *cloudOk = body.indexOf("\"cloudSyncOk\":false") < 0;
  }
  http.end();
  return ok;
}

// Full teardown and re-association — the part of a power cycle that actually
// fixes things.
//
// WiFi.status() reporting WL_CONNECTED does NOT mean the link works. After the
// access point restarts, or the router hands out a different subnet, the ESP32
// happily keeps a dead association: it still claims connected, still shows full
// bars, and every TCP connection fails. That is the state where the screen sits
// on a red cross while the server is perfectly fine, and it is why switching
// the device off and on has been the only cure.
//
// disconnect(true) drops the radio and clears the old IP, so begin() gets a
// fresh association AND a fresh DHCP lease.
bool hardWifiReset()
{
  if (wifiSSID.length() == 0) return false;

  // Reuses the existing ladder rather than hand-rolling another join:
  // wifiRadioHardReset() takes the radio to WIFI_OFF and back, re-applies the
  // tuning, and pins the strongest AP — the same sequence a boot performs.
  wifiRadioHardReset(true);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000)
  {
    delay(250);
    feedWatchdog(); // a 12s join on its own outlasts the 30s loop watchdog
  }
  return WiFi.status() == WL_CONNECTED;
}

void handleRefreshSystem()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(5, 24);
  tft.println("SYSTEM CHECK");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 40);
  tft.println("Checking...");

  // 1 ── Release anything a dead task is holding. Do this FIRST: if a
  // background task died, its flag blocks every send, and the probe below would
  // fail for that reason alone and blame the network.
  hbGeneration++;
  hbTaskRunning = false;
  hbStartedAt = 0;
  bulkGeneration++;
  isSendingBulk = false;
  bulkStartedAt = 0;
  bulkTaskDone = false;
  bulkTaskResult = 0;
  bulkPendingCount = 0;

  bool wifiOk = isWiFiConnected();
  bool serverOk = false, dbOk = false, cloudOk = true;
  int httpCode = 0;
  bool didHardReset = false;

  // 2 ── WiFi genuinely down: reconnect before blaming the server.
  if (!wifiOk && wifiSSID.length() > 0)
  {
    tft.setCursor(5, 52);
    tft.println("WiFi...");
    WiFi.reconnect();
    unsigned long t0 = millis();
    while (!isWiFiConnected() && millis() - t0 < 8000)
    {
      delay(200);
      feedWatchdog();
    }
    wifiOk = isWiFiConnected();
  }

  // 3 ── First probe.
  if (wifiOk)
  {
    tft.setCursor(5, 52);
    tft.println("Server...");
    serverOk = probeServer(&dbOk, &cloudOk, &httpCode);
  }

  // 4 ── THE STEP THAT MAKES THIS EQUAL TO SWITCHING THE DEVICE OFF AND ON.
  //
  // WiFi says connected but the server is unreachable. That is the exact state
  // a power cycle cures, and the reason it cures it is not the server — it is
  // that booting forces a brand new association and DHCP lease. A stale
  // association still reports WL_CONNECTED and full signal bars while every TCP
  // connection fails, so simply retrying the same socket gets the same failure
  // forever.
  //
  // Only escalated after a failed probe: tearing down a working radio on every
  // scan would drop the link for ten seconds for no reason.
  if (wifiOk && !serverOk)
  {
    tft.fillRect(0, 46, 160, 20, ST77XX_BLACK);
    tft.setCursor(5, 52);
    tft.setTextColor(ST77XX_YELLOW);
    tft.println("Reconnecting WiFi...");
    tft.setTextColor(ST77XX_WHITE);

    didHardReset = true;
    wifiOk = hardWifiReset();
    if (wifiOk)
    {
      delay(400);           // let DHCP settle before the first packet
      feedWatchdog();
      tft.fillRect(0, 46, 160, 20, ST77XX_BLACK);
      tft.setCursor(5, 52);
      tft.println("Server...");
      serverOk = probeServer(&dbOk, &cloudOk, &httpCode);
    }
  }

  // 4 ── Set the verdict DIRECTLY rather than through noteBackendResult().
  // That function needs two consecutive failures before it will show a cross,
  // which is right for a background timer and wrong here: this check just
  // happened, in front of the operator, and must be believed immediately.
  if (serverOk)
  {
    backendFailStreak = 0;
    backendOk = true;
    lastSendConfirmed = true;
  }
  else
  {
    backendFailStreak = BACKEND_FAIL_THRESHOLD;
    backendOk = false;
  }
  cloudSyncOk = cloudOk;
  lastHeartbeat = millis();               // this WAS the heartbeat
  if (serverOk && storedScanCount > 0)
    sendBatchNow = true;                  // drain anything the outage stranded

  // 5 ── Result, one line per thing checked.
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  bool allOk = wifiOk && serverOk && dbOk;
  tft.setTextSize(1);
  tft.setTextColor(allOk ? ST77XX_GREEN : ST77XX_RED);
  tft.setCursor(5, 22);
  tft.println(allOk ? "ALL OK" : "PROBLEM FOUND");

  int y = 36;
  const int STEP = 11;
  // The "Cloud" line is gone in v5.6.0. It reported whether the factory PC was
  // still pushing to a hosted database; there is only one database now, so the
  // three lines below are the whole chain a scan depends on.
  struct { const char *label; bool ok; } rows[] = {
    { "WiFi   ", wifiOk },
    { "Server ", serverOk },
    { "Databas", dbOk && serverOk },
  };
  for (int i = 0; i < 3; i++)
  {
    tft.setCursor(5, y);
    tft.setTextColor(ST77XX_CYAN);
    tft.print(rows[i].label);
    tft.setTextColor(rows[i].ok ? ST77XX_GREEN : ST77XX_RED);
    tft.println(rows[i].ok ? " OK" : " FAIL");
    y += STEP;
  }

  tft.setCursor(5, y + 3);
  tft.setTextColor(ST77XX_WHITE);
  if (!wifiOk)
    tft.println("Check WiFi/router");
  else if (!serverOk)
    tft.println("Srv " + serverHost + " code" + String(httpCode));
  else if (!dbOk)
    tft.println("Server up, DB down");
  else if (didHardReset)
    tft.println("Fixed by WiFi reset");   // the stale-link case, now recovered
  else
    tft.println("Queue: " + String(storedScanCount));

  scanFeedbackUntil = millis() + 6000;
  scanFeedbackReturn = isEmployeeSignedIn ? "scan" : "operator";
}

// ─── Stuck-task reclaim ───────────────────────────────────────────────────────
// The safety net for the failure this exists to prevent: a background task that
// never returns leaves its "busy" flag set, and every later heartbeat or upload
// is refused by the guard at the top of its starter. The device stays on WiFi,
// answers ping, shows healthy bars — and silently never contacts the server
// again until it is power-cycled. On the floor that reads as "the server is
// down" while the server is plainly up, and scans pile up in the queue.
//
// Nothing is force-deleted: a task blocked inside lwIP may hold a network lock,
// and killing it is worse than leaking it. The flag is released so work can
// resume, and the generation counter makes the abandoned task's eventual result
// a no-op. Queued scans are untouched by a reclaim — they were never
// acknowledged, so the retry path picks them up exactly as after any failure.
void reclaimStuckTasks()
{
  unsigned long now = millis();

  if (hbTaskRunning && hbStartedAt && (now - hbStartedAt) > TASK_STUCK_TIMEOUT_MS)
  {
    Serial.println("[Watchdog] Heartbeat task stuck — releasing flag");
    hbGeneration++; // disown whatever that task eventually reports
    hbTaskRunning = false;
    hbStartedAt = 0;
    noteBackendResult(false); // it never answered; treat as a failed attempt
  }

  if (isSendingBulk && bulkStartedAt && (now - bulkStartedAt) > TASK_STUCK_TIMEOUT_MS)
  {
    Serial.println("[Watchdog] Send task stuck — releasing flag, " +
                   String(storedScanCount) + " scans still queued");
    bulkGeneration++;
    bulkTaskDone = false;
    bulkTaskResult = 0;
    bulkPendingCount = 0;
    bulkTaskHandle = NULL;
    isSendingBulk = false;
    bulkStartedAt = 0;
    lastSendConfirmed = false;
    noteBackendResult(false);
  }
}

// ─── WO Count ─────────────────────────────────────────────────────────────────
bool maybeCountWO(const String &scanId)
{
  if (!isEmployeeSignedIn || !scanId.startsWith("WO"))
    return false;
  if (isWOInHistory(scanId))
  {
    Serial.println("[WO] Dup: " + scanId);
    return false;
  }
  addWOToHistory(scanId);
  operatorScanCount++;
  // Deferred, not written here. This counter is the on-screen tally only — the
  // authoritative count is derived from the events in Mongo, so losing it to a
  // power cut costs a display value, not data. Writing NVS on every piece was
  // one more flash commit in the scan path (and 500+ commits a shift of
  // needless flash wear).
  nvsDirty = true;
  Serial.println("[WO] Counted: " + scanId + " total=" + String(operatorScanCount));
  return true;
}

// ─── Queue (v5.5.0) ───────────────────────────────────────────────────────────
// Replaces addToOfflineStorage. Every event is stamped with its identity and
// its context AT THIS MOMENT, then the sender is kicked immediately.
void queueEvent(const String &type, const String &barcodeId,
                const String &operatorId, const String &ops,
                const String &breakReason, uint32_t breakDurationSec)
{
  StoredEvent e;
  e.eventId = nextEventId();
  e.type = type;
  e.machineId = machineId; // captured now, not at send time
  e.operatorId = operatorId;
  e.barcodeId = barcodeId;
  e.activeOps = ops;
  e.breakReason = breakReason;
  e.breakDurationSec = breakDurationSec;
  e.millisAtScan = millis();
  e.timeRecovered = false;

  time_t now;
  time(&now);
  // Only trust a clock that has actually been set. Otherwise leave the epoch
  // at 0 and let recoverQueuedTimes() reconstruct it when NTP lands.
  e.scanEpoch = (now > 1700000000UL) ? now : 0;

  bool dropped = false;
  if (storedScanCount >= MAX_STORED_SCANS)
  {
    // Oldest out. Loud, not silent — v5.4.0 dropped scans with no signal at all.
    for (int i = 0; i < MAX_STORED_SCANS - 1; i++)
      offlineScans[i] = offlineScans[i + 1];
    offlineScans[MAX_STORED_SCANS - 1] = e;
    dropped = true;
    queueOverflowed = true;
    Serial.println("[Queue] FULL — oldest event DROPPED");
  }
  else
  {
    offlineScans[storedScanCount++] = e;
  }

  if (storedScanCount > queueHighWater)
    queueHighWater = storedScanCount;
  unackedCount = storedScanCount;

  // Append is one short write. A drop forces a full rewrite instead.
  if (dropped)
    queueRewriteFS();
  else
    queueAppendToFS(e);

  kickSender();
}

// ═══════════════════════════════════════════════════════════════════════════════
// v5.4.0 CASE 7 — Multi-device WiFi reliability
//
// Identical firmware behaving differently unit-to-unit almost always comes from
// four places, all addressed here:
//   1. Modem sleep (default ON) — marginal-signal units fail to associate or
//      silently drop. WiFi.setSleep(false).
//   2. Stale credentials in the ESP's own system NVS fighting WiFi.begin().
//      WiFi.persistent(false) + explicit disconnect before every join.
//   3. Multi-AP / mesh sites — the radio joins whichever AP answers first, not
//      the strongest. joinWiFiOnce(true) scans and pins BSSID + channel.
//   4. A single 30 s attempt at boot, then only WiFi.reconnect() forever.
//      reconnect() cannot recover a stack that never associated. Replaced with
//      an escalating ladder ending in a full radio power-cycle.
// ═══════════════════════════════════════════════════════════════════════════════
void applyWiFiTuning()
{
  WiFi.persistent(false); // never write creds to system NVS
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false); // biggest single unit-to-unit reliability win
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 2
  WiFi.setTxPower(WIFI_POWER_19_5dBm); // make TX power deterministic per unit
#endif
  String h = "GRAV-" + deviceId; // unique hostname: DHCP sanity + router triage
  WiFi.setHostname(h.c_str());
}

// Find the strongest AP broadcasting our SSID. Blocking scan (~2-3 s).
bool findBestAP(const String &ssid, uint8_t *bssidOut, int32_t *chanOut, int32_t *rssiOut)
{
  int n = WiFi.scanNetworks(false, true);
  if (n <= 0)
  {
    WiFi.scanDelete();
    return false;
  }
  int best = -1;
  int32_t bestRssi = -127;
  for (int i = 0; i < n; i++)
  {
    if (WiFi.SSID(i) != ssid)
      continue;
    if (WiFi.RSSI(i) > bestRssi)
    {
      bestRssi = WiFi.RSSI(i);
      best = i;
    }
  }
  if (best < 0)
  {
    WiFi.scanDelete();
    return false;
  }
  memcpy(bssidOut, WiFi.BSSID(best), 6);
  *chanOut = WiFi.channel(best);
  *rssiOut = bestRssi;
  WiFi.scanDelete();
  return true;
}

bool joinWiFiOnce(bool useBestAP)
{
  WiFi.disconnect(true, false); // drop any half-open association
  delay(120);
  WiFi.mode(WIFI_STA);
  applyWiFiTuning();

  uint8_t bssid[6];
  int32_t chan = 0, rssi = 0;
  if (useBestAP && findBestAP(wifiSSID, bssid, &chan, &rssi))
  {
    Serial.println("[WiFi] Best AP ch=" + String((int)chan) + " rssi=" + String((int)rssi));
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str(), chan, bssid, true);
  }
  else
  {
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
  }

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < WIFI_JOIN_TIMEOUT_MS)
    delay(100);
  return WiFi.status() == WL_CONNECTED;
}

void wifiRadioHardReset(bool pinBestAP)
{
  Serial.println("[WiFi] Hard radio reset (pinBestAP=" + String(pinBestAP ? "yes" : "no") + ")");
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  delay(400);
  WiFi.mode(WIFI_STA);
  applyWiFiTuning();
  delay(120);
  uint8_t bssid[6];
  int32_t chan = 0, rssi = 0;
  if (pinBestAP && findBestAP(wifiSSID, bssid, &chan, &rssi))
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str(), chan, bssid, true);
  else
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
  wifiRadioResetCount++;
}

// Runs after every successful association (boot or reconnect).
void onWiFiConnected()
{
  wifiConnectionFailCount = 0;
  Serial.println("[WiFi] Connected " + WiFi.localIP().toString() + " rssi=" + String(WiFi.RSSI()) + " ch=" + String(WiFi.channel()));
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "in.pool.ntp.org", "pool.ntp.org", "time.nist.gov");
  fetchMachineNameIfNeeded();
  for (int i = 0; i < 50; i++)
  {
    time_t n;
    time(&n);
    if (n > 1700000000UL)
      break;
    delay(200);
  }
  reconcileBreakEpochIfNeeded();
  // v5.5.0 — NTP has (probably) landed. Work backwards from elapsed millis to
  // the instant each queued event actually happened, BEFORE anything is sent.
  recoverQueuedTimes();
  checkForUpdates();
  sendHeartbeat(); // v5.5.0 — tell the dashboard we are back
  if (storedScanCount > 0)
    sendBatchNow = true;
}

// ─── WiFi Connect (boot) ──────────────────────────────────────────────────────
void connectToWiFi()
{
  if (!wifiConfigured || wifiSSID.length() == 0)
  {
    startConfigMode();
    return;
  }
  showScreen("Connecting", "SSID: " + wifiSSID, "Machine: " + getMachineDisplay());
  bool ok = false;
  for (int a = 1; a <= WIFI_BOOT_ATTEMPTS && !ok; a++)
  {
    tft.fillRect(0, 88, 160, 14, ST77XX_BLACK);
    tft.setTextColor(ST77XX_CYAN);
    tft.setTextSize(1);
    tft.setCursor(5, 90);
    tft.print("Attempt " + String(a) + "/" + String(WIFI_BOOT_ATTEMPTS));
    // Attempt 1 is the fast path. Later attempts scan and pin the strongest AP.
    ok = joinWiFiOnce(a > 1);
    if (!ok)
    {
      Serial.println("[WiFi] Boot attempt " + String(a) + " failed");
      delay(300);
    }
  }
  if (ok)
  {
    onWiFiConnected();
    showMessageNB("Connected!", "Machine: " + getMachineDisplay());
    delay(2000);
  }
  else
  {
    wifiConnectionFailCount++;
    showMessageNB("Connection Failed", "Will retry every 30s");
    delay(2000);
  }
}

// ─── WiFi Monitor ─────────────────────────────────────────────────────────────
void checkWiFiConnection()
{
  if (!wifiConfigured || wifiSSID.length() == 0 || inConfigMode)
    return;
  unsigned long now = millis();
  bool cur = isWiFiConnected();

  if (lastWiFiState != cur)
  {
    if (cur)
      onWiFiConnected();
    else
    {
      Serial.println("[WiFi] Link lost");
      // Without this the tick stays GREEN after the WiFi drops.
      //
      // backendOk only ever changes inside noteBackendResult(), and the only
      // callers are the heartbeat and the event POST — both of which are
      // skipped entirely while the link is down. So nothing records a failure,
      // backendOk stays frozen at its last value, and the screen shows a green
      // "server reachable" tick next to a WiFi icon with no bars.
      //
      // No link means unreachable. Say so. Seeding the streak at the threshold
      // also puts the heartbeat on its 10s fast retry, so the tick comes back
      // within ~10s of the link returning rather than up to a minute.
      backendOk = false;
      backendFailStreak = BACKEND_FAIL_THRESHOLD;
    }
    lastWiFiState = cur;
  }

  if (!cur && (now - lastWiFiConnectionAttempt) > WIFI_CONNECTION_RETRY_INTERVAL)
  {
    lastWiFiConnectionAttempt = now;
    wifiConnectionFailCount++;
    // v5.4.0 CASE 7 — escalating recovery ladder
    if (wifiConnectionFailCount <= 2)
    {
      Serial.println("[WiFi] retry " + String(wifiConnectionFailCount) + ": reconnect()");
      WiFi.reconnect();
    }
    else if (wifiConnectionFailCount <= 5)
    {
      Serial.println("[WiFi] retry " + String(wifiConnectionFailCount) + ": re-begin");
      WiFi.disconnect(false, false);
      delay(60);
      WiFi.mode(WIFI_STA);
      applyWiFiTuning();
      WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
    }
    else
    {
      // From 10 fails on, also scan and pin the strongest AP (mesh sites)
      wifiRadioHardReset(wifiConnectionFailCount >= 10);
      // Last resort: only when a restart cannot cost anyone data
      if (wifiConnectionFailCount >= 40 && !isEmployeeSignedIn && storedScanCount == 0 && !isInBreakMode())
      {
        Serial.println("[WiFi] Unrecoverable and idle — restarting");
        delay(200);
        ESP.restart();
      }
    }
  }

  if (cur)
  {
    wifiConnectionFailCount = 0;
    if (now - lastUpdateCheck > UPDATE_CHECK_INTERVAL)
    {
      lastUpdateCheck = now;
      checkForUpdates();
    }
  }
}

// ─── Machine Update Barcode Handler ───────────────────────────────────────────
void handleMachineUpdateBarcode(const String &s)
{
  String newId, newName;
  if (!parseMachineUpdateBarcode(s, newId, newName))
  {
    showScanError("E5", "BAD SETUP",
                  "Machine setup card could not be read.",
                  "Card must read MID:<id>,MNAME:<name>");
    scanFeedbackUntil = millis() + ERROR_SHOW_MS;
    scanFeedbackReturn = isEmployeeSignedIn ? "employee" : "operator";
    return;
  }

  // v5.5.0 — each event now carries the machineId captured AT SCAN TIME, so
  // attribution no longer depends on flushing before the switch. Flushing is
  // still done for hygiene, and now drains the whole queue rather than the
  // single batch v5.4.0 managed.
  if (storedScanCount > 0 && isWiFiConnected())
  {
    showScreen("MACHINE UPDATE", "Flushing " + String(storedScanCount) + " events", "Please wait...");
    unsigned long t0 = millis();
    while (storedScanCount > 0 && (millis() - t0) < 25000)
    {
      if (!isSendingBulk)
        startBackgroundBulkSend();
      handleBulkSendCompletion();
      delay(100);
    }
    handleBulkSendCompletion();
  }
  bool leftover = (storedScanCount > 0);

  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.putString("machine_id", newId);
  preferences.putBool("machine_configured", true);
  preferences.end();
  machineId = newId;
  machineIdConfigured = true;

  if (newName.length() > 0)
    saveMachineName(newName);
  else
    clearMachineName();

  // Reset ops state — old machine's ops must not carry over to the new one
  activeOpCount = 0;
  for (int i = 0; i < MAX_ACTIVE_OPS; i++)
    activeOperations[i] = "";
  clearOpsNVS();
  saveOpsToNVS();
  if (isWiFiConnected())
    fetchMachineNameIfNeeded();

  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(1);
  tft.setCursor(5, 30);
  tft.println("MACHINE UPDATED");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 45);
  tft.println("Name:");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 55);
  tft.println(machineName.length() > 0 ? machineName : "(fetching from API)");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 70);
  tft.println("ID: " + getMachineIdLast5());
  if (leftover)
  {
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 85);
    tft.println(String(storedScanCount) + " scans still queued");
  }
  delay(2500);
  messageShowUntil = millis() + 100;
  messagePending = true;
  pendingReturnScreen = isEmployeeSignedIn ? "employee" : "operator";
}

// ─── WiFi Update Barcode Handler ──────────────────────────────────────────────
void handleWiFiUpdateBarcode(const String &s)
{
  String newSSID, newPass;
  if (!parseWiFiUpdateBarcode(s, newSSID, newPass))
  {
    showScanError("E6", "BAD WIFI",
                  "WiFi setup card could not be read.",
                  "Card must read SSID:<name>,PASSWORD:<pass>");
    scanFeedbackUntil = millis() + ERROR_SHOW_MS;
    return;
  }
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(1);
  tft.setCursor(5, 28);
  tft.println("WIFI UPDATE");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 42);
  tft.println("SSID: " + newSSID);
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 56);
  tft.println("Connecting...");
  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.putString("wifi_ssid", newSSID);
  preferences.putString("wifi_pass", newPass);
  preferences.putBool("wifi_configured", true);
  preferences.end();
  wifiSSID = newSSID;
  wifiPass = newPass;
  wifiConfigured = true;

  // v5.4.0 CASE 7 — same hardened join path as boot, 2 attempts
  bool ok = false;
  for (int a = 1; a <= 2 && !ok; a++)
    ok = joinWiFiOnce(a > 1);

  if (ok)
  {
    lastWiFiState = true;
    onWiFiConnected();
    tft.fillScreen(ST77XX_BLACK);
    drawHeader();
    tft.setTextColor(ST77XX_GREEN);
    tft.setTextSize(1);
    tft.setCursor(5, 35);
    tft.println("WiFi Updated!");
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 50);
    tft.println("SSID: " + newSSID);
    tft.setTextColor(ST77XX_CYAN);
    tft.setCursor(5, 65);
    tft.println("RSSI " + String(WiFi.RSSI()) + "dBm");
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 80);
    tft.println(WiFi.localIP().toString());
    delay(2500);
  }
  else
  {
    tft.fillScreen(ST77XX_BLACK);
    drawHeader();
    tft.setTextColor(ST77XX_RED);
    tft.setTextSize(1);
    tft.setCursor(5, 35);
    tft.println("WiFi Failed");
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(5, 50);
    tft.println("SSID: " + newSSID);
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 65);
    tft.println("Check credentials");
    delay(3000);
  }
  messageShowUntil = millis() + 100;
  messagePending = true;
  pendingReturnScreen = isEmployeeSignedIn ? "employee" : "operator";
}

// ─── Server Update Barcode Handler (v5.5.0) ───────────────────────────────────
// Format: SRV:192.168.1.80:5001
// Exists so that moving the factory PC, or standing up a second line, does not
// mean reflashing every device over USB.
void handleServerUpdateBarcode(const String &s)
{
  String newScheme = DEFAULT_SERVER_SCHEME;
  String newHost;
  int newPort = DEFAULT_SERVER_PORT;
  int newCmsPort = DEFAULT_CMS_PORT;
  if (!parseServerUpdateBarcode(s, newScheme, newHost, newPort, newCmsPort))
  {
    showScanError("E7", "BAD SRV",
                  "Server setup card could not be read.",
                  "SRV:192.168.1.50:5001 or SRV:https://host");
    scanFeedbackUntil = millis() + ERROR_SHOW_MS;
    scanFeedbackReturn = isEmployeeSignedIn ? "employee" : "operator";
    return;
  }

  // Flush to the OLD server first. Those events were produced while this device
  // belonged to that server; sending them onward is the caller's problem, not
  // something to silently re-route.
  if (storedScanCount > 0 && isWiFiConnected())
  {
    showScreen("SERVER UPDATE", "Flushing " + String(storedScanCount) + " events",
               "Please wait...");
    unsigned long t0 = millis();
    while (storedScanCount > 0 && (millis() - t0) < 20000)
    {
      if (!isSendingBulk)
        startBackgroundBulkSend();
      handleBulkSendCompletion();
      delay(100);
    }
    handleBulkSendCompletion();
  }
  bool leftover = (storedScanCount > 0);

  serverScheme = newScheme;
  serverHost = newHost;
  serverPort = newPort;
  cmsPort = newCmsPort;
  saveServerConfig();

  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(1);
  tft.setCursor(5, 30);
  tft.println("SERVER UPDATED");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 48);
  tft.println(serverHost);
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 62);
  tft.println(serverScheme + " : " + String(serverPort));
  if (leftover)
  {
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 80);
    tft.println(String(storedScanCount) + " events still queued");
  }
  Serial.println("[Srv] now " + apiBase());
  delay(2500);

  // Prove the new address works rather than leaving the operator guessing.
  if (isWiFiConnected())
    sendHeartbeat();

  messageShowUntil = millis() + 100;
  messagePending = true;
  pendingReturnScreen = isEmployeeSignedIn ? "employee" : "operator";
}

// ─── WiFi Manager HTML ────────────────────────────────────────────────────────
void handleRoot()
{
  String html = R"rawliteral(<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial;background:#f2f4f7;margin:0;padding:20px}.container{max-width:420px;margin:0 auto;background:white;padding:25px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}h2{margin-top:0;color:#222;text-align:center}h3{color:#444;margin:15px 0 5px;font-size:16px}input,select{width:100%;padding:12px;margin:6px 0;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px}.pw-wrap{position:relative;margin:6px 0}.pw-wrap input{margin:0;padding-right:44px}.eye-btn{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;padding:0;width:32px;height:32px}.primary-btn{background:#4CAF50;color:white;padding:14px;border:none;border-radius:6px;cursor:pointer;width:100%;font-size:16px;margin-top:10px}.primary-btn:disabled{background:#aaa;cursor:not-allowed}.status{margin-top:15px;padding:10px;border-radius:6px;display:none}.success{background:#d4edda;color:#155724;display:block}.error{background:#f8d7da;color:#721c24;display:block}.info{background:#e7f3ff;color:#004085;display:block}.note{font-size:12px;color:#666;margin-top:6px;background:#f8f9fa;border-left:3px solid #4CAF50;padding:8px 10px;border-radius:4px}.divider{border-top:1px solid #eee;margin:20px 0 10px}#scanStatus{font-size:12px;color:#888;margin:4px 0}</style>
</head><body><div class="container"><h2>&#9881; GRAV Scanner Setup</h2>
<h3>1. WiFi Network</h3><div id="scanStatus">Scanning...</div>
<select id="ssidDropdown" onchange="onDropdownSelect(this)"><option value="">-- Scanning... --</option></select>
<input type="text" id="ssid" placeholder="WiFi SSID" required>
<div class="pw-wrap"><input type="password" id="password" placeholder="WiFi Password"><button class="eye-btn" type="button" onclick="togglePw()">&#128065;</button></div>
<h3>2. Machine Details</h3>
<input type="text" id="machineId" placeholder="Machine ID" required>
<input type="text" id="machineName" placeholder="Machine Name (optional)">
<h3>3. Production Server (LAN)</h3>
<input type="text" id="serverHost" placeholder="Server IP e.g. 192.168.1.50" required>
<input type="number" id="serverPort" placeholder="Port (default 5000)">
<div class="note">The factory PC running the production server, on this same network. Use its reserved LAN IP &mdash; not a domain, and never <b>localhost</b> (to the scanner that means itself).</div>
<button class="primary-btn" id="saveBtn" onclick="saveConfig()">Save &amp; Connect</button>
<div class="divider"></div>
<div class="note">&#128273; WiFi update barcode: <b>SSID:NetworkName,PASSWORD:YourPass</b></div>
<div class="note">&#128295; Machine update barcode: <b>MID:MachineId,MNAME:MachineName</b></div>
<div class="note">&#128225; Server update barcode: <b>SRV:192.168.1.50:5001</b> (LAN) or <b>SRV:https://scanner.example.com</b> (hosted)</div>
<div class="note">&#8505; Info screen: scan <b>INFO_ADMIN_2790</b></div>
<div id="status" class="status"></div></div>
<script>
var pwVisible=false;
function togglePw(){pwVisible=!pwVisible;var i=document.getElementById('password');i.type=pwVisible?'text':'password';document.querySelector('.eye-btn').innerHTML=pwVisible?'&#128584;':'&#128065;';}
function loadExistingConfig(){fetch('/status').then(r=>r.json()).then(d=>{if(d.ssid)document.getElementById('ssid').value=d.ssid;if(d.machineId)document.getElementById('machineId').value=d.machineId;if(d.machineName)document.getElementById('machineName').value=d.machineName;if(d.serverHost)document.getElementById('serverHost').value=d.serverHost;if(d.serverPort)document.getElementById('serverPort').value=d.serverPort;if(d.configured){var s=document.getElementById('status');s.className='status info';s.innerHTML='Config loaded. Enter password to update.';s.style.display='block';}}).catch(function(){});}
function scanNetworks(){document.getElementById('scanStatus').textContent='Scanning...';fetch('/scan').then(r=>r.json()).then(d=>{if(d.status==='scanning'){setTimeout(scanNetworks,3000);return;}var dd=document.getElementById('ssidDropdown'),cur=document.getElementById('ssid').value;if(d.networks&&d.networks.length>0){var h='<option value="">-- Select Network --</option>';d.networks.forEach(function(n){var s=(n.ssid===cur)?' selected':'';var b=n.rssi>-60?'&#9608;&#9608;&#9608;':n.rssi>-75?'&#9608;&#9608;&#9617;':'&#9608;&#9617;&#9617;';h+='<option value="'+n.ssid+'"'+s+'>'+b+' '+n.ssid+' ('+n.rssi+'dBm)</option>';});dd.innerHTML=h;document.getElementById('scanStatus').textContent='Found '+d.networks.length+' network(s).';if(cur)dd.value=cur;}else{dd.innerHTML='<option value="">-- No networks --</option>';document.getElementById('scanStatus').textContent='None found. Enter manually.';}}).catch(function(){document.getElementById('scanStatus').textContent='Scan failed.';});}
function onDropdownSelect(s){if(s.value)document.getElementById('ssid').value=s.value;}
function saveConfig(){var ssid=document.getElementById('ssid').value.trim();var password=document.getElementById('password').value;var machineId=document.getElementById('machineId').value.trim();var machineName=document.getElementById('machineName').value.trim();var serverHost=document.getElementById('serverHost').value.trim();var serverPort=document.getElementById('serverPort').value.trim()||'5000';if(!ssid){alert('Enter WiFi SSID');return;}if(!machineId){alert('Enter Machine ID');return;}if(!serverHost){alert('Enter the production server IP');return;}if(/^(localhost|127\.)/i.test(serverHost)){alert('localhost means the scanner itself. Enter the PC LAN IP, e.g. 192.168.1.50');return;}var btn=document.getElementById('saveBtn');btn.disabled=true;btn.textContent='Saving...';var s=document.getElementById('status');s.className='status info';s.innerHTML='Saving...';s.style.display='block';fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'ssid='+encodeURIComponent(ssid)+'&password='+encodeURIComponent(password)+'&machineId='+encodeURIComponent(machineId)+'&machineName='+encodeURIComponent(machineName)+'&serverHost='+encodeURIComponent(serverHost)+'&serverPort='+encodeURIComponent(serverPort)}).then(r=>r.json()).then(d=>{if(d.success){s.className='status success';s.innerHTML='Saved! ID: <b>'+d.deviceId+'</b>. Restarting...';}else{s.className='status error';s.innerHTML='Error: '+d.message;btn.disabled=false;btn.textContent='Save & Connect';}}).catch(function(e){s.className='status error';s.innerHTML='Failed: '+e;btn.disabled=false;btn.textContent='Save & Connect';});}
window.onload=function(){loadExistingConfig();scanNetworks();};
</script></body></html>)rawliteral";
  server.send(200, "text/html", html);
}
void handleScan()
{
  int n = WiFi.scanComplete();
  if (n == -2)
  {
    WiFi.scanNetworks(true);
    server.send(202, "application/json", "{\"status\":\"scanning\"}");
  }
  else if (n >= 0)
  {
    String j = "{\"networks\":[";
    for (int i = 0; i < n; ++i)
    {
      if (i)
        j += ",";
      j += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
    }
    j += "]}";
    server.send(200, "application/json", j);
    WiFi.scanDelete();
  }
  else
    server.send(200, "application/json", "{\"networks\":[]}");
}
void handleSave()
{
  if (!server.hasArg("ssid") || !server.hasArg("machineId"))
  {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing params\"}");
    return;
  }
  String ssid = server.arg("ssid"), pass = server.arg("password"), mId = server.arg("machineId"), mName = server.hasArg("machineName") ? server.arg("machineName") : "";
  if (ssid.length() == 0 || mId.length() == 0)
  {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Empty field\"}");
    return;
  }
  String nd = String((uint32_t)ESP.getEfuseMac(), HEX);
  nd.toUpperCase();
  while (nd.length() < 8)
    nd = "0" + nd;
  if (nd.length() > 8)
    nd = nd.substring(nd.length() - 8);
  saveConfig(ssid, pass, mId, mName);
  // v5.5.0 — LAN server address, persisted in its own namespace so a machine
  // or WiFi change never disturbs it.
  if (server.hasArg("serverHost"))
  {
    String h = server.arg("serverHost");
    h.trim();
    if (h.length() > 0)
      serverHost = h;
  }
  if (server.hasArg("serverPort"))
  {
    int p = server.arg("serverPort").toInt();
    if (p > 0 && p <= 65535)
      serverPort = p;
  }
  saveServerConfig();
  server.send(200, "application/json", "{\"success\":true,\"deviceId\":\"" + nd + "\"}");
  delay(1000);
  ESP.restart();
}
void handleStatus()
{
  String j = "{\"configured\":" + String(wifiConfigured ? "true" : "false") + ",\"connected\":" + String(isWiFiConnected() ? "true" : "false") + ",\"ssid\":\"" + wifiSSID + "\",\"deviceId\":\"" + deviceId + "\",\"machineId\":\"" + machineId + "\",\"machineName\":\"" + machineName + "\",\"serverHost\":\"" + serverHost + "\",\"serverPort\":" + String(serverPort) + ",\"queued\":" + String(storedScanCount) + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.send(200, "application/json", j);
}
void startConfigMode()
{
  inConfigMode = true;
  configModeStartTime = millis();
  clearMachineName();
  activeOpCount = 0;
  for (int i = 0; i < MAX_ACTIVE_OPS; i++)
    activeOperations[i] = "";
  clearOpsNVS();
  WiFi.disconnect();
  delay(500);
  uint64_t chipid = ESP.getEfuseMac();
  String chipId = String((uint32_t)chipid, HEX);
  fullAP_SSID = String(AP_SSID) + "-" + chipId.substring(chipId.length() - 4);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(fullAP_SSID.c_str(), AP_PASSWORD);
  IPAddress apIP = WiFi.softAPIP();
  dnsServer.start(DNS_PORT, "*", apIP);
  server.on("/", handleRoot);
  server.on("/scan", handleScan);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/status", handleStatus);
  server.onNotFound([]()
                    {server.sendHeader("Location","http://"+WiFi.softAPIP().toString(),true);server.send(302,"text/plain",""); });
  server.begin();
  WiFi.scanNetworks(true);
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 18);
  tft.println("SETUP MODE");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 32);
  tft.println("WiFi: " + fullAP_SSID);
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(5, 46);
  tft.println("Pass: " + String(AP_PASSWORD));
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 62);
  tft.println("Open browser:");
  tft.setTextColor(ST77XX_GREEN);
  tft.setCursor(5, 76);
  tft.println(apIP.toString());
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 92);
  tft.println("Timeout: 5 min");
}

// ─── Process Local Scan ───────────────────────────────────────────────────────
void processLocalScan(String rawScanId)
{
  String scanId = extractEmployeeIdFromUrl(rawScanId);
  if (scanId.indexOf(INFO_KEYWORD) >= 0)
  {
    infoModeActive = true;
    infoModeStartTime = millis();
    showInfoScreen();
    return;
  }
  // Before the machine-assignment guard below: a device with no machine set is
  // exactly one an engineer needs to diagnose.
  if (scanId.indexOf(REFRESH_KEYWORD) >= 0)
  {
    handleRefreshSystem();
    return;
  }
  if (deviceId.length() == 0 || machineId.length() == 0)
  {
    showScanError("E3", "NOT SET",
                  "This scanner has no machine number, so scans cannot be "
                  "saved to any machine.",
                  "Do not use this machine. Call your supervisor to set the "
                  "device up.");
    scanFeedbackUntil = millis() + ERROR_SHOW_MS;
    scanFeedbackReturn = "operator";
    return;
  }
  String currentOps = getActiveOpsString();

  if (isEmployeeId(scanId))
  {
    if (isEmployeeSignedIn && currentEmployeeId == scanId)
    {
      queueEvent("signout", "", scanId, "");
      String outId = currentEmployeeId;
      saveEmployeeData();
      clearEmployeeData();
      clearWOHistory();
      showVisualFeedback(true, outId + " signed out");
      scanFeedbackUntil = millis() + 2000;
      scanFeedbackReturn = "operator";
      return;
    }
    if (isEmployeeSignedIn && currentEmployeeId != scanId)
    {
      queueEvent("signout", "", currentEmployeeId, "");
      saveEmployeeData();
      clearEmployeeData();
      clearWOHistory();
    }
    currentEmployeeId = scanId;
    currentEmployeeName = scanId;
    isEmployeeSignedIn = true;
    operatorScanCount = 0;
    saveEmployeeData();
    queueEvent("signin", "", scanId, "");
    showVisualFeedback(true, "Signed in: " + scanId);
    scanFeedbackUntil = millis() + 2000;
    scanFeedbackReturn = "employee";
    return;
  }

  if (isBarcodeId(scanId))
  {
    if (!isEmployeeSignedIn)
    {
      showScanError("E2", "NO ID",
                    "Nobody is signed in on this machine, so this piece "
                    "cannot be counted.",
                    "Scan your ID card first. Then scan the garment tag again.");
      scanFeedbackUntil = millis() + ERROR_SHOW_MS;
      scanFeedbackReturn = "operator";
      return;
    }
    // v5.5.0 — operatorId travels WITH the scan. v5.4.0 left the server to
    // infer it from whoever was signed in, which is the stateful coupling that
    // made concurrent writes corrupt each other.
    queueEvent("scan", scanId, currentEmployeeId, currentOps);
    maybeCountWO(scanId);
    showVisualFeedback(true, "Scan #" + String(operatorScanCount) + " saved");
    scanFeedbackUntil = millis() + 1500;
    scanFeedbackReturn = "employee";
    return;
  }

  // The most common operator-facing error: a code that is neither a garment
  // tag nor an ID card. Show what was actually read so a supervisor can tell a
  // damaged label from the wrong label.
  showScanError("E1", "BAD CODE",
                "Not a garment tag or an ID card. Read: " +
                    scanId.substring(0, 16),
                "Scan the tag on the garment. If it fails again, use another "
                "tag and tell your supervisor.");
  scanFeedbackUntil = millis() + ERROR_SHOW_MS;
  scanFeedbackReturn = isEmployeeSignedIn ? "employee" : "operator";
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup()
{
  Serial.begin(115200);
  delay(500);
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.initR(INITR_BLACKTAB);
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);
  loadConfig();
  loadBootCount();      // v5.5.0 — must follow loadConfig(): eventId needs deviceId
  loadServerConfig();   // v5.5.0 — LAN server address
  initQueueFS();        // v5.5.0 — must precede loadScansData()
  loadFirmwareVersion();
  loadMachineName();
  loadEmployeeData();
  loadScansData();      // v5.5.0 — now reads LittleFS, not 7 NVS keys per scan
  loadWOHistory();
  loadBreakState();
  loadOpsFromNVS(); // v5.4.0 CASE 2/3 — MUST be before connectToWiFi()
  unackedCount = storedScanCount;
  ScannerSerial.begin(9600, SERIAL_8N1, SCANNER_RX, SCANNER_TX);
  showSplashScreen();
  if (!wifiConfigured || machineId.length() == 0)
  {
    startConfigMode();
  }
  else
  {
    connectToWiFi();
    if (currentEmployeeName.isEmpty())
    {
      isEmployeeSignedIn = false;
      currentEmployeeId = "";
      operatorScanCount = 0;
      if (isInBreakMode())
        endBreak("orphan");
    }
    lastWiFiState = isWiFiConnected();
    if (storedScanCount > 0 && isWiFiConnected())
      sendBatchNow = true;
    if (isInBreakMode())
    {
      showBreakScreen();
      lastBreakScreenRefresh = millis();
    }
    else if (isEmployeeSignedIn)
      showEmployeeScreen();
    else
      showNoOperatorScreen();
  }
  unsigned long now = millis();
  lastHeaderRefresh = now;
  lastQueueRetry = now;
  lastHeartbeat = 0; // send one immediately so the dashboard sees us on boot
  lastNVSPersist = now;
  lastWiFiConnectionAttempt = now;
  lastUpdateCheck = now;
  lastAcceptedScanTime = 0;
  nvsDirty = false;

  // Last thing in setup: everything above can legitimately block for a while
  // (WiFi association, NTP, LittleFS recovery) and must not be shot at 30s.
  Serial.println("[Boot] reset reason: " + resetReasonText());
  startLoopWatchdog();
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop()
{
  // First statement, before every early return: reaching the top of loop() is
  // exactly the definition of "not hung".
  feedWatchdog();

  if (inConfigMode)
  {
    dnsServer.processNextRequest();
    server.handleClient();
    if (millis() - configModeStartTime > CONFIG_MODE_TIMEOUT)
      ESP.restart();
    return;
  }

  unsigned long now = millis();

  if (visualFeedbackActive && now >= visualFeedbackUntil)
  {
    visualFeedbackActive = false;
    returnToHomeScreen();
  }
  if (messagePending && now >= messageShowUntil)
  {
    messagePending = false;
    returnToHomeScreen();
  }
  if (scanFeedbackUntil > 0 && now >= scanFeedbackUntil)
  {
    scanFeedbackUntil = 0;
    if (!visualFeedbackActive)
      returnToHomeScreen();
    scanFeedbackReturn = "";
  }
  if (infoModeActive && (now - infoModeStartTime > INFO_MODE_DURATION))
  {
    infoModeActive = false;
    returnToHomeScreen();
  }

  handleBulkSendCompletion();

  // Runs before anything that depends on a send being possible. A device that
  // has lost a task must recover on its own — nobody is watching the serial log
  // on the floor.
  reclaimStuckTasks();

  checkWiFiConnection();

  if (updateAvailable && isWiFiConnected() && !infoModeActive && !isInBreakMode())
  {
    showUpdateScreen("Update available!", 0);
    delay(2000);
    if (performOTAUpdate())
      ESP.restart();
    else
    {
      updateAvailable = false;
      returnToHomeScreen();
    }
  }

  // v5.5.0 — the normal send is triggered by the scan itself (queueEvent ->
  // kickSender). This is only the RETRY path for events that could not be
  // delivered, plus the continuation of a backlog draining 25 at a time.
  if (isWiFiConnected() && !isSendingBulk && storedScanCount > 0)
  {
    bool retryDue = (now - lastQueueRetry) >= QUEUE_RETRY_INTERVAL;
    if (sendBatchNow || retryDue)
    {
      sendBatchNow = false;
      lastQueueRetry = now;
      startBackgroundBulkSend();
    }
  }

  // v5.5.0 — heartbeat. Cheap, and the only thing that distinguishes a quiet
  // machine from a dead one.
  // After a failure, re-check in 10s instead of 60s. That is what lets the
  // indicator ignore a single blip WITHOUT being slow to report a real outage:
  // two failures 10s apart is a genuine problem, and the cross appears then.
  unsigned long hbInterval =
      (backendFailStreak > 0) ? HEARTBEAT_FAST_RETRY_MS : HEARTBEAT_INTERVAL;
  if (isWiFiConnected() && (lastHeartbeat == 0 || (now - lastHeartbeat) >= hbInterval))
  {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  // v5.5.0 — the clock can arrive well after the first scans of a cold boot.
  // Keep trying to back-fill true times until it does.
  if (!clockValid && isWiFiConnected() && storedScanCount > 0)
    recoverQueuedTimes();

  if (nvsDirty && (now - lastNVSPersist) >= NVS_PERSIST_INTERVAL)
  {
    lastNVSPersist = now;
    persistNVS();
  }

  // Keep the queue line honest on the same 1s tick as the header. Cheap:
  // drawQueueLine() returns immediately unless something actually changed.
  // Not gated on isEmployeeSignedIn: an undelivered queue and an unreachable
  // server both survive a sign-out and still need to be visible. Break mode IS
  // excluded — that screen uses this same strip for its own instructions.
  if ((now - lastHeaderRefresh) > HEADER_REFRESH_INTERVAL && !visualFeedbackActive &&
      !isInBreakMode() && !infoModeActive && !messagePending && scanFeedbackUntil == 0)
  {
    drawQueueLine();
  }

  if ((now - lastHeaderRefresh) > HEADER_REFRESH_INTERVAL && !visualFeedbackActive && !isInBreakMode())
  {
    drawHeader();
    lastHeaderRefresh = now;
  }

  if (isInBreakMode() && !visualFeedbackActive && !messagePending && scanFeedbackUntil == 0 && !infoModeActive && (now - lastBreakScreenRefresh) > BREAK_TIMER_REFRESH_MS)
  {
    lastBreakScreenRefresh = now;
    refreshBreakTimerArea();
  }

  while (ScannerSerial.available())
  {
    char c = ScannerSerial.read();
    if (c == '\n' || c == '\r')
    {
      if (scannedData.length() > 0)
      {
        String scanValue = scannedData;
        scannedData = "";
        scanValue.trim();
        if ((now - lastAcceptedScanTime) < SCAN_DEBOUNCE_MS)
        {
          Serial.println("[Debounce] Ignored: " + scanValue);
          while (ScannerSerial.available())
            ScannerSerial.read();
          scannedData = "";
          break;
        }
        lastAcceptedScanTime = now;

        if (checkForAdminConfig(scanValue))
        {
          tft.fillScreen(ST77XX_BLACK);
          drawHeader();
          tft.setTextColor(ST77XX_RED);
          tft.setTextSize(1);
          tft.setCursor(5, 30);
          tft.println("ADMIN CONFIG");
          tft.setTextColor(ST77XX_YELLOW);
          tft.setCursor(5, 50);
          tft.println("Wiping memory...");
          wipeAllMemory();
          delay(1500);
          tft.setTextColor(ST77XX_GREEN);
          tft.setCursor(5, 70);
          tft.println("Cleared");
          tft.setTextColor(ST77XX_WHITE);
          tft.setCursor(5, 90);
          tft.println("Entering setup...");
          delay(1500);
          startConfigMode();
          return;
        }
        if (isWiFiUpdateBarcode(scanValue))
        {
          handleWiFiUpdateBarcode(scanValue);
          scannedData = "";
          break;
        }
        if (isMachineUpdateBarcode(scanValue))
        {
          handleMachineUpdateBarcode(scanValue);
          scannedData = "";
          break;
        }
        // v5.5.0 — SRV:192.168.1.50:5000
        if (isServerUpdateBarcode(scanValue))
        {
          handleServerUpdateBarcode(scanValue);
          scannedData = "";
          break;
        }
        if (isBreakBarcode(scanValue))
        {
          BreakReason newReason = parseBreakReason(scanValue);
          if (!isEmployeeSignedIn)
          {
            showScanError("E4", "NO ID",
                          "A break can only be started by a signed-in "
                          "operator.",
                          "Scan your ID card first, then scan the break card "
                          "again.");
            scanFeedbackUntil = now + ERROR_SHOW_MS;
            scanFeedbackReturn = "operator";
          }
          else if (isInBreakMode() && currentBreakReason == newReason)
          {
            unsigned long elapsed = getBreakElapsedSeconds();
            String endMsg = breakReasonLabel(currentBreakReason) + ": " + formatBreakElapsed(elapsed);
            endBreak("manual");
            showVisualFeedback(true, endMsg);
            scanFeedbackUntil = now + 2000;
            scanFeedbackReturn = "employee";
          }
          else if (isInBreakMode() && currentBreakReason != newReason)
          {
            endBreak("switched");
            startBreak(newReason);
            showBreakScreen();
            lastBreakScreenRefresh = now;
          }
          else
          {
            startBreak(newReason);
            showBreakScreen();
            lastBreakScreenRefresh = now;
          }
          scannedData = "";
          break;
        }
        if (isInBreakMode())
        {
          endBreak("auto_other_scan");
        }
        if (isOpsKeyword(scanValue))
        {
          String opName = extractOpName(scanValue);
          if (opName.length() > 0)
          {
            bool si = toggleOperation(opName);
            markOpsChangedLocally();
            showOpsToggleScreen(opName, si);
            scanFeedbackUntil = now + 1500;
            scanFeedbackReturn = isEmployeeSignedIn ? "employee" : "operator";
          }
          scannedData = "";
          break;
        }
        if (isOpsGroupKeyword(scanValue))
        {
          String gOps[MAX_ACTIVE_OPS];
          int count = extractGroupOps(scanValue, gOps, MAX_ACTIVE_OPS);
          if (count > 0)
          {
            int si = 0, so = 0;
            toggleGroupOps(gOps, count, si, so);
            markOpsChangedLocally();
            showGroupOpsToggleScreen(count, si, so);
            scanFeedbackUntil = now + 2000;
            scanFeedbackReturn = isEmployeeSignedIn ? "employee" : "operator";
          }
          scannedData = "";
          break;
        }
        processLocalScan(scanValue);
        scannedData = "";
        break;
      }
    }
    else
    {
      scannedData += c;
    }
  }
}