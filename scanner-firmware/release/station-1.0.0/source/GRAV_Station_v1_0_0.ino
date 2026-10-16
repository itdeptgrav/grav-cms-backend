// ═══════════════════════════════════════════════════════════════════════════════
// GRAV Remote Station Firmware v1.0.0
//
// A GRAV hand-scanner device as the REMOTE INPUT of a finishing dashboard
// (Ironing, Trimming — any stage in services/manufacturing/finishingStages.js).
//
// ── WHAT THIS DEVICE IS NOW (15 Oct 2026, owner) ──────────────────────────────
// Ironing has three stations and Trimming four. A tablet at each one is seven
// tablets, and the factory already owns these ESP32 scanners. So the scanner
// is no longer fitted to a sewing machine: it is PAIRED to a stage's dashboard
// and becomes that dashboard's remote input. The operator at the station:
//
//   1. scans the QR the dashboard shows under "Access this dashboard
//      remotely"  — ONCE, by whoever sets the device up. The device is then
//      paired to that stage (the screen says IRONING / TRIMMING) and stays
//      paired across reboots until the dashboard lets it go.
//   2. scans their ID card              → signed in
//   3. scans each garment piece         → recorded on the dashboard as
//                                         ironed / trimmed, under their name,
//                                         with the time they scanned it
//   4. scans their ID card again        → signed out
//
// Every piece lands in the SAME book the dashboard's own scan screen writes
// (`finishingscans`), attributed to the operator the badge names, flagged as
// recorded from this device, with the device's own event id — so who did what,
// when, and from where is recorded exactly as it is for a scan made in the
// browser.
//
// ── WHAT IS GONE FROM THE MACHINE-SCANNER FIRMWARE (GRAV_Scanner_v5_6_7) ─────
//   · the machine (MID: card, machine name, /name lookup)   — no machine
//   · operations (ops: / opsgp: cards, the 8-op list)       — no operations
//   · breaks (BREAK_* cards, the break screen)              — not a machine state
//   · the sewing-floor ingest (/events with machineId)      — a different book
//   · the production rollup's operator-count                — replaced by the
//                                                             stage's own count
//
// ── WHAT IS KEPT, UNCHANGED, BECAUSE IT WAS HARD-WON ──────────────────────────
//   · the WiFi join ladder, best-AP pinning, the idle restart (v5.4.0 CASE 7)
//   · the LittleFS offline queue: every scan is durable the instant it is read,
//     sends per scan over the LAN, retries every 30 s, survives a reboot, and
//     the true scan time is reconstructed when NTP lands late (v5.5.0)
//   · the background send / heartbeat / update-check tasks with their
//     generation guards and the stuck-task reclaim (v5.6.3)
//   · the loop watchdog, the socket-leak fix, the backend tick/cross with its
//     fail-slow / recover-fast streak
//   · OTA, with the "wrong file" and stall protection — now on its own channel
//     (`product: "station"`), so a station build is never offered to a machine
//     scanner nor a machine build to a station
//   · SRV: / SSID: / ROTATE_SCREEN / INFO_ADMIN_2790 / REFRESH_SYSTEM /
//     ADMIN-CONFIG-94731 cards, and the WiFi setup portal
//
// ── THE SERVER SIDE ────────────────────────────────────────────────────────────
//   POST /api/cms/production/barcode_punchings/station/pair
//   POST …/station/events        header X-Station-Key     ← the hot path
//   POST …/station/heartbeat     header X-Station-Key
//   GET  …/station/operator-count?operatorId=   header X-Station-Key
//   POST …/station/unpair        header X-Station-Key
//   GET  …/station/ping
//   (routes/Barcode_Scan_Punchings/remoteStationRoutes.js — same base path as
//    the machine scanners, so the one SRV: card re-points both.)
//
// A 401 with code UNPAIRED on any of them means the dashboard let this device
// go: the key is dropped and the screen goes back to "SCAN QR TO PAIR".
//
// ── NVS NAMESPACES ─────────────────────────────────────────────────────────────
// `scanner_cfg` (WiFi), `scanner_srv` (server), `scanner_boot`, `scanner_disp`
// and `firmware_ver` are the machine firmware's own, deliberately: a device
// reflashed from the machine firmware joins WiFi and finds the server with no
// setup at all, and only needs the QR. `station_pair` and `station_op` are new.
// The machine firmware's `scanner_emp` / `scanner_ops` / `scanner_brk` /
// `scanner_wo` / `scanner_mach` are wiped once at first boot (see setup()).
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
#include <freertos/queue.h>
#include <LittleFS.h>

// THE version. Shown on the splash screen, reported to /check-update, and
// compared against the label on the server. BUMP THIS whenever you build
// firmware to upload, and type the SAME string into the CMS Version field
// (device type: Remote finishing station).
#define FW_VERSION "1.0.0"
#define FW_PRODUCT "station"

// ─── Types ────────────────────────────────────────────────────────────────────
// These MUST stay above the first function definition: the Arduino builder
// inserts auto-generated prototypes before the first function body, and a type
// named in any signature has to exist by then.

// One queued event. Every field is captured at SCAN time — that is the only
// moment the values are true.
struct StoredEvent
{
  String eventId;    // <deviceId>-<bootCount>-<seq>, stable across retries
  String type;       // scan | signin | signout
  String stage;      // the stage this device was paired to when it happened
  String operatorId; // the badge, as read
  String barcodeId;  // WO-<id>-<unit> for a scan; empty otherwise
  time_t scanEpoch;  // 0 when the clock was unset at scan time
  unsigned long millisAtScan; // what recovers scanEpoch when NTP lands
  bool timeRecovered;
};

// One upload attempt, owned by the task that performs it (v5.6.3 — a private
// snapshot of everything the task reads, so core 1 can never rewrite a String
// out from under core 0).
struct SendJob
{
  uint32_t gen;
  String url;
  String key; // the station key, for X-Station-Key
  String payload;
};

// The send task's answer, handed back through a FreeRTOS queue by pointer —
// NOT through volatile globals. See the long note above UpdateResult in
// GRAV_Scanner_v5_6_7 for why a volatile flag is not a safe cross-core
// handoff of a String. The body is needed on core 1 because the server
// answers EVERY event by name: saved / already (by whom) / invalid (why).
struct SendResult
{
  uint32_t gen;
  int code;
  String body;
};

struct UpdateJob
{
  uint32_t gen;
  String checkUrl;
  String payload;
};

struct UpdateResult
{
  uint32_t gen;
  int8_t verdict; // 1 = update offered, -1 = none, 0 = no verdict
  String version;
  String url;
};

// What the heartbeat task learned, besides reachability. Same ownership rule.
struct HeartbeatResult
{
  uint32_t gen;
  int code;
  bool unpaired;      // the server answered 401 UNPAIRED
  String stationName; // the name the dashboard gave this device
};

// ─── WiFi Manager ─────────────────────────────────────────────────────────────
WebServer server(80);
DNSServer dnsServer;
const byte DNS_PORT = 53;
const char *AP_SSID = "Grav_Station";
const char *AP_PASSWORD = "Grav_production_2702";
String fullAP_SSID;
String wifiSSID = "";
String wifiPass = "";
String deviceId = "";

/* THIS DEVICE'S IDENTITY — the whole 48-bit MAC, 12 hex characters. The old
   8-character form took the low 32 bits, three bytes of which are the
   Espressif OUI every chip shares; it collided in production. */
String makeDeviceId()
{
  uint64_t mac = ESP.getEfuseMac();
  char buf[13];
  snprintf(buf, sizeof(buf), "%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(buf);
}
bool wifiConfigured = false;
bool inConfigMode = false;
unsigned long configModeStartTime = 0;
const unsigned long CONFIG_MODE_TIMEOUT = 300000;
unsigned long lastWiFiConnectionAttempt = 0;
const unsigned long WIFI_CONNECTION_RETRY_INTERVAL = 30000;
int wifiConnectionFailCount = 0;
bool lastWiFiState = false;

// ─── WiFi robustness (v5.4.0 CASE 7) ──────────────────────────────────────────
const unsigned long WIFI_JOIN_TIMEOUT_MS = 20000;
const int WIFI_BOOT_ATTEMPTS = 3;
int wifiRadioResetCount = 0;

// ─── Info / refresh ───────────────────────────────────────────────────────────
const char *INFO_KEYWORD = "INFO_ADMIN_2790";
const char *REFRESH_KEYWORD = "REFRESH_SYSTEM";
bool infoModeActive = false;
unsigned long infoModeStartTime = 0;
const unsigned long INFO_MODE_DURATION = 10000;

// ─── Loop watchdog ────────────────────────────────────────────────────────────
// A hung Arduino loop still answers ping (the WiFi stack runs in its own
// task). Subscribing the loop task turns "dead until a human notices" into a
// reboot within 30 s; queued scans live in LittleFS and survive it.
const uint32_t LOOP_WDT_TIMEOUT_S = 30;
bool wdtActive = false;

void startLoopWatchdog()
{
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = LOOP_WDT_TIMEOUT_S * 1000;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic = true;
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

// ─── OTA ──────────────────────────────────────────────────────────────────────
String currentFirmwareVersion = FW_VERSION;
bool updateAvailable = false;
String newFirmwareUrl = "";
String newFirmwareVersion = "";
unsigned long lastUpdateCheck = 0;
const unsigned long UPDATE_CHECK_INTERVAL = 3600000;
const int MIN_FIRMWARE_BYTES = 200000;
const unsigned long OTA_STALL_TIMEOUT_MS = 20000;
const int OTA_MAX_ATTEMPTS = 4;
String otaFailedVersion = "";
int otaFailCount = 0;

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

// ─── API — the factory PC, or a hosted server ─────────────────────────────────
// Plain HTTP to the factory PC on the same LAN by default; SRV:https://host
// for a hosted deployment. Same scheme/host/port rules as the machine scanner
// (see GRAV_Scanner_v5_6_7 for the reasoning). Two ports exist because the
// scanner server and the CMS backend are two processes on the factory PC;
// a TLS or bare-:80 target is one origin and carries one port.
const char *SERVER_NAMESPACE = "scanner_srv";
const char *DEFAULT_SERVER_HOST = "192.168.1.80"; // factory PC — MUST be DHCP-reserved
const int DEFAULT_SERVER_PORT = 5001;             // scanner compat listener
const int DEFAULT_CMS_PORT = 5000;                // CMS backend, same machine
const char *DEFAULT_SERVER_SCHEME = "http";
String serverScheme = DEFAULT_SERVER_SCHEME;
String serverHost = DEFAULT_SERVER_HOST;
int serverPort = DEFAULT_SERVER_PORT;
int cmsPort = DEFAULT_CMS_PORT;

String hostPort(int port)
{
  bool isDefault = (serverScheme == "https" && port == 443) ||
                   (serverScheme == "http" && port == 80);
  return isDefault ? serverHost : serverHost + ":" + String(port);
}
String apiBase()
{
  return serverScheme + "://" + hostPort(serverPort) +
         "/api/cms/production/barcode_punchings/station";
}
String pairUrl() { return apiBase() + "/pair"; }
String eventsUrl() { return apiBase() + "/events"; }
String heartbeatUrl() { return apiBase() + "/heartbeat"; }
String operatorCountUrl() { return apiBase() + "/operator-count"; }
String unpairUrl() { return apiBase() + "/unpair"; }
String pingUrl() { return apiBase() + "/ping"; }
String cmsBase() { return serverScheme + "://" + hostPort(cmsPort) + "/api"; }
String deviceRegisterUrl() { return cmsBase() + "/barcode-devices/check-update"; }

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
  // A unit upgrading from 5.5.x may hold port 5000 (now the CMS). HTTP only.
  if (serverScheme == "http" && serverPort == 5000)
  {
    serverPort = DEFAULT_SERVER_PORT;
    saveServerConfig();
  }
  Serial.println("[Srv] station " + apiBase());
  Serial.println("[Srv] cms     " + cmsBase());
}

// Format: SRV:192.168.1.80:5001   (port optional)   or   SRV:https://host
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
  int sep = rest.indexOf("://");
  if (sep > 0)
  {
    outScheme = rest.substring(0, sep);
    outScheme.toLowerCase();
    if (outScheme != "http" && outScheme != "https")
      return false;
    rest = rest.substring(sep + 3);
    rest.trim();
    explicitScheme = true;
  }
  if (rest.length() == 0)
    return false;
  int slash = rest.indexOf('/');
  if (slash >= 0)
    rest = rest.substring(0, slash);
  const int schemeDefaultPort = (outScheme == "https") ? 443 : 80;
  int colon = rest.indexOf(':');
  if (colon < 0)
  {
    outHost = rest;
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
  bool singleOrigin = (outScheme == "https") || (outPort == 80);
  outCmsPort = singleOrigin ? outPort : DEFAULT_CMS_PORT;
  return outHost.length() > 0;
}
void handleServerUpdateBarcode(const String &s);

// ─── THE PAIRING ──────────────────────────────────────────────────────────────
// The QR on the dashboard reads GRAVSTN:<token>. Scanning it is the one setup
// step. The server answers with a STATION KEY bound to this deviceId, which is
// what every later call carries; it is stored in NVS and survives reboots.
const char *PAIR_NAMESPACE = "station_pair";
const char *PAIR_PREFIX = "GRAVSTN:";
const char *UNPAIR_KEYWORD = "UNPAIR_STATION";
String stationKey = "";   // empty = not paired
String stageSlug = "";    // "ironing" / "trimming" …
String stageName = "";    // "Ironing"
String stageDoneLabel = ""; // "Ironed"
String stationName = "";  // what the dashboard calls this device
bool isPaired() { return stationKey.length() > 0 && stageSlug.length() > 0; }

bool isPairBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.startsWith(PAIR_PREFIX);
}
bool isUnpairBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.indexOf(UNPAIR_KEYWORD) >= 0;
}

// Set from the heartbeat / send tasks when the server says UNPAIRED; acted on
// by loop() on core 1, which owns the NVS and the screen.
volatile bool unpairedByServer = false;

// ─── Send cadence (v5.5.0) ────────────────────────────────────────────────────
const unsigned long QUEUE_RETRY_INTERVAL = 30UL * 1000UL;
unsigned long lastQueueRetry = 0;
bool sendBatchNow = false;

// background send task state
volatile bool bulkTaskDone = false;
int bulkPendingCount = 0;
TaskHandle_t bulkTaskHandle = NULL;
QueueHandle_t sendResultQueue = NULL;

// ─── Heartbeat ────────────────────────────────────────────────────────────────
const unsigned long HEARTBEAT_INTERVAL = 60UL * 1000UL;
unsigned long lastHeartbeat = 0;
volatile bool hbTaskRunning = false;
QueueHandle_t hbResultQueue = NULL;

// ─── Stuck-task watchdogs (v5.6.3) ────────────────────────────────────────────
const unsigned long TASK_STUCK_TIMEOUT_MS = 30UL * 1000UL;
unsigned long hbStartedAt = 0;
unsigned long bulkStartedAt = 0;
volatile uint32_t bulkGeneration = 0;
volatile uint32_t hbGeneration = 0;

// ─── Update check, off the main loop (v5.6.3) ─────────────────────────────────
volatile uint32_t updGeneration = 0;
volatile bool updTaskRunning = false;
unsigned long updStartedAt = 0;
QueueHandle_t updResultQueue = NULL;

// ─── Reconnect follow-up (v5.6.3) ─────────────────────────────────────────────
enum ReconnectPhase : uint8_t
{
  RC_IDLE = 0,
  RC_WAIT_CLOCK,
  RC_QUEUE_TIMES,
  RC_UPDATE_CHECK
};
ReconnectPhase reconnectPhase = RC_IDLE;
unsigned long reconnectPhaseAt = 0;
const unsigned long RECONNECT_CLOCK_WAIT_MS = 10UL * 1000UL;
// Holds the SENDER while queued events still carry unreconstructed times.
bool queueTimesPending = false;

// ─── Event identity (v5.5.0) ──────────────────────────────────────────────────
const char *BOOT_NAMESPACE = "scanner_boot";
uint32_t bootCount = 0;
uint32_t eventSeq = 0;

// ─── Two-phase scan feedback ──────────────────────────────────────────────────
int unackedCount = 0;
bool lastSendConfirmed = true;

// ─── Backend reachability ─────────────────────────────────────────────────────
volatile bool backendOk = false;
const int BACKEND_FAIL_THRESHOLD = 2;
const unsigned long HEARTBEAT_FAST_RETRY_MS = 10UL * 1000UL;
volatile int backendFailStreak = 0;
volatile bool backendStateDirty = false;

bool isWiFiConnected();

// FAIL SLOW, RECOVER FAST (see GRAV_Scanner_v5_6_7 for the reasoning).
void noteBackendResult(bool ok)
{
  if (ok)
  {
    if (!isWiFiConnected())
      return;
    bool wasDown = !backendOk;
    backendFailStreak = 0;
    backendOk = true;
    if (wasDown)
    {
      Serial.println("[Server] ONLINE");
      backendStateDirty = true;
    }
    return;
  }
  if (backendFailStreak < 1000) backendFailStreak++;
  if (backendFailStreak >= BACKEND_FAIL_THRESHOLD && backendOk)
  {
    backendOk = false;
    Serial.println("[Server] OFFLINE");
    backendStateDirty = true;
  }
}

int lastDrawnQueue = -1;
bool lastDrawnBackendOk = false;
bool clockValid = false;

// ─── The on-screen tally, corrected from the server ───────────────────────────
bool operatorCountSyncPending = false;
unsigned long lastOperatorCountSync = 0;
const unsigned long OPERATOR_COUNT_RETRY_MS = 30UL * 1000UL;

// ─── Display / Message ────────────────────────────────────────────────────────
unsigned long messageShowUntil = 0;
bool messagePending = false;
unsigned long scanFeedbackUntil = 0;

// ─── Scan debounce ────────────────────────────────────────────────────────────
// 1.2 s, not the machine scanner's 4 s: an ironing table turns a piece over
// far faster than a sewing machine finishes one, and the server refuses a
// genuine double anyway.
unsigned long lastAcceptedScanTime = 0;
const unsigned long SCAN_DEBOUNCE_MS = 1200;

// ─── Visual feedback ──────────────────────────────────────────────────────────
unsigned long visualFeedbackUntil = 0;
bool visualFeedbackActive = false;

// ─── Forward declarations ─────────────────────────────────────────────────────
extern bool isEmployeeSignedIn;
extern String currentEmployeeName;
extern String currentEmployeeId;
void showEmployeeScreen();
void showNoOperatorScreen();
void showNotPairedScreen();
int drawWrapped(const String &text, int x, int y, int maxChars, int lineH, int maxLines);
void showScanError(const char *code, const String &headline, const String &what, const String &action);
void showNotice(uint16_t bg, uint16_t ink, const String &headline, const String &what, unsigned long forMs);
void drawHeader();
void drawWiFiIconSmall(bool connected, uint16_t bg);
void drawQueueLine();
void returnToHomeScreen();
String getISOTimeIST();
void startBackgroundBulkSend();
void handleBulkSendCompletion();
void handleHeartbeatCompletion();
void reclaimStuckTasks();
void handleRefreshSystem();
String buildBulkPayload(int count);
void saveEmployeeData();
void showScreen(String title, String line1, String line2, int bgColor);
void applyWiFiTuning();
bool joinWiFiOnce(bool useBestAP);
void wifiRadioHardReset(bool pinBestAP);
String nextEventId();
void loadBootCount();
void queueEvent(const String &type, const String &barcodeId, const String &operatorId);
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
void savePairing();
void loadPairing();
void clearPairing(bool tellServer);
void handlePairBarcode(const String &s);
void handleUnpairBarcode();
String homeScreenName();

// ─── Admin ────────────────────────────────────────────────────────────────────
const char *ADMIN_KEYWORD = "ADMIN-CONFIG-94731";
bool checkForAdminConfig(String s) { return s.indexOf(ADMIN_KEYWORD) >= 0; }

// ─── WiFi update barcode ──────────────────────────────────────────────────────
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

// ─── Screen rotation (v5.6.7) ─────────────────────────────────────────────────
const char *DISPLAY_NAMESPACE = "scanner_disp";
const char *ROTATE_KEYWORD = "ROTATE_SCREEN";
uint8_t screenRotation = 1;

void loadScreenRotation()
{
  Preferences p;
  p.begin(DISPLAY_NAMESPACE, true);
  uint8_t r = p.getUChar("rot", 1);
  p.end();
  screenRotation = (r == 3) ? 3 : 1;
}
void toggleScreenRotation()
{
  screenRotation = (screenRotation == 1) ? 3 : 1;
  Preferences p;
  p.begin(DISPLAY_NAMESPACE, false);
  p.putUChar("rot", screenRotation);
  p.end();
  tft.setRotation(screenRotation);
  Serial.println("[Display] rotation=" + String(screenRotation));
}
bool isRotateBarcode(const String &s)
{
  String u = s;
  u.toUpperCase();
  return u.indexOf(ROTATE_KEYWORD) >= 0;
}

// ─── NVS ──────────────────────────────────────────────────────────────────────
Preferences preferences;
const char *CONFIG_NAMESPACE = "scanner_cfg";
const char *OPERATOR_NAMESPACE = "station_op";
const char *VERSION_NAMESPACE = "firmware_ver";

String scannedData = "";

// ─── Operator state ───────────────────────────────────────────────────────────
String currentEmployeeName = ""; // the person's name, once the server has told us
String currentEmployeeId = "";   // the badge
bool isEmployeeSignedIn = false;
int operatorScanCount = 0;       // pieces today at this stage, server-corrected

// Pieces this operator scanned on THIS device since sign-in, so an immediate
// re-scan is refused on the spot instead of after a round trip. RAM only; the
// server's piece index is the real rule.
const int RECENT_PIECES = 24;
String recentPieces[RECENT_PIECES];
int recentPieceHead = 0;
bool recentPieceSeen(const String &b)
{
  for (int i = 0; i < RECENT_PIECES; i++)
    if (recentPieces[i].length() && recentPieces[i].equalsIgnoreCase(b)) return true;
  return false;
}
void recentPieceAdd(const String &b)
{
  recentPieces[recentPieceHead] = b;
  recentPieceHead = (recentPieceHead + 1) % RECENT_PIECES;
}
void recentPiecesClear()
{
  for (int i = 0; i < RECENT_PIECES; i++) recentPieces[i] = "";
  recentPieceHead = 0;
}

// ─── Event queue (v5.5.0) ─────────────────────────────────────────────────────
const int MAX_STORED_SCANS = 300;
const int QUEUE_WARN_THRESHOLD = (MAX_STORED_SCANS * 8) / 10;
const int MAX_EVENTS_PER_POST = 25;
StoredEvent offlineScans[MAX_STORED_SCANS];
int storedScanCount = 0;
int queueHighWater = 0;
bool isSendingBulk = false;
bool queueOverflowed = false;

// ─── LittleFS-backed durability ───────────────────────────────────────────────
const char *QUEUE_FILE = "/station-queue.dat";
bool fsReady = false;

// ─── Timers ───────────────────────────────────────────────────────────────────
unsigned long lastHeaderRefresh = 0;
const unsigned long HEADER_REFRESH_INTERVAL = 1000;
const long GMT_OFFSET_SEC = 19800;
const int DAYLIGHT_OFFSET_SEC = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
// The same two rules the server applies (services/manufacturing/finishingStation.js).
bool isBarcodeId(const String &id)
{
  String u = id;
  u.toUpperCase();
  return u.length() > 3 && u.startsWith("WO-");
}
bool isEmployeeId(const String &id)
{
  String u = id;
  u.toUpperCase();
  if (u.length() < 4 || !u.startsWith("GR")) return false;
  for (unsigned int i = 2; i < u.length(); i++)
    if (!isalnum(u.charAt(i))) return false;
  return true;
}
// An ID card may be printed as a URL whose last segment is the id.
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

// ─── Operator-facing errors ───────────────────────────────────────────────────
// Every error answers: what is wrong (big), why (one sentence), WHAT TO DO (on a
// white band) and a code for whoever the operator calls.
const unsigned long ERROR_SHOW_MS = 3500;

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
  visualFeedbackUntil = millis() + ERROR_SHOW_MS;
  scanFeedbackUntil = visualFeedbackUntil;

  tft.fillScreen(ST77XX_RED);
  tft.setTextSize(2);
  tft.setTextColor(ST77XX_WHITE);
  int hw = headline.length() * 12;
  tft.setCursor(hw < 156 ? (160 - hw) / 2 : 2, 6);
  tft.print(headline);
  tft.drawFastHLine(0, 26, 160, ST77XX_WHITE);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE);
  drawWrapped(what, 4, 31, 26, 10, 3);
  tft.fillRect(0, 62, 160, 66, ST77XX_WHITE);
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(4, 66);
  tft.print("DO THIS:");
  tft.setTextColor(ST77XX_BLACK);
  drawWrapped(action, 4, 78, 26, 10, 4);
  tft.setTextColor(ST77XX_RED);
  tft.setCursor(140, 118);
  tft.print(code);
  Serial.println("[Error] " + String(code) + " " + headline + " - " + what);
}

// A coloured notice: headline at size 2, a sentence under it. Used for the
// server's own verdict on a piece ("ALREADY DONE by X at T", "NOT ACCEPTED")
// and for pairing results. `forMs` is how long before the home screen returns.
void showNotice(uint16_t bg, uint16_t ink, const String &headline, const String &what, unsigned long forMs)
{
  visualFeedbackActive = true;
  visualFeedbackUntil = millis() + forMs;
  scanFeedbackUntil = visualFeedbackUntil;
  tft.fillScreen(bg);
  tft.setTextSize(2);
  tft.setTextColor(ink);
  int hw = headline.length() * 12;
  tft.setCursor(hw < 156 ? (160 - hw) / 2 : 2, 14);
  tft.print(headline);
  tft.drawFastHLine(0, 36, 160, ink);
  tft.setTextSize(1);
  drawWrapped(what, 4, 44, 26, 11, 6);
}

// Green success for a scan or a sign-in. Short — the next piece is coming.
void showVisualFeedback(bool isSuccess, String message)
{
  visualFeedbackActive = true;
  visualFeedbackUntil = millis() + (isSuccess ? 1200 : 2000);
  scanFeedbackUntil = visualFeedbackUntil;
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
  drawWrapped(message, 5, 65, 26, 12, 4);
  tft.drawFastHLine(0, 20, 160, ST77XX_BLUE);
}

// ─── Which version does this device report? ───────────────────────────────────
// Both the compiled FW_VERSION and the label an OTA was installed under are
// stored; the label stands only while the binary it was recorded against is
// the one running. (See GRAV_Scanner_v5_6_7 for the "800.80" story.)
void saveFirmwareVersion(String v)
{
  preferences.begin(VERSION_NAMESPACE, false);
  preferences.putString("version", v);
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
  tft.setCursor(38, 70);
  tft.println("Remote Station");
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

// FAR RIGHT: the WiFi radio only.
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

// The 16px strip at the bottom: queue depth / server / update. Repainted only
// when something actually changed (the scanner shares this SPI bus).
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
    tft.print("! QUEUE " + String(storedScanCount) + "/" + String(MAX_STORED_SCANS) + " - SERVER?");
  }
  else if (storedScanCount > 0)
  {
    tft.setTextColor(ST77XX_YELLOW);
    tft.setCursor(5, 118);
    tft.print("Pending: " + String(storedScanCount));
  }
  else if (!backendOk && isWiFiConnected())
  {
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

// MIDDLE: is this device actually talking to the server?
//   GREEN TICK  connected, everything recorded is confirmed
//   RED CROSS   server not reachable (or the queue overflowed)
//   YELLOW n    connected, n events still in flight
void drawSyncIconSmall()
{
  const int x = 106, y = 5;
  tft.fillRect(102, 0, 36, 18, ST77XX_BLACK);
  tft.setTextSize(1);
  if (!backendOk || queueOverflowed)
  {
    tft.drawLine(x + 2, y + 1, x + 11, y + 10, ST77XX_RED);
    tft.drawLine(x + 11, y + 1, x + 2, y + 10, ST77XX_RED);
    tft.drawLine(x + 3, y + 1, x + 12, y + 10, ST77XX_RED);
    tft.drawLine(x + 12, y + 1, x + 3, y + 10, ST77XX_RED);
    return;
  }
  if (unackedCount == 0)
  {
    uint16_t c = ST77XX_GREEN;
    tft.drawLine(x + 2, y + 5, x + 5, y + 8, c);
    tft.drawLine(x + 5, y + 8, x + 11, y + 1, c);
    tft.drawLine(x + 2, y + 6, x + 5, y + 9, c);
    tft.drawLine(x + 5, y + 9, x + 11, y + 2, c);
    return;
  }
  tft.setTextColor(lastSendConfirmed ? ST77XX_YELLOW : ST77XX_RED);
  tft.setCursor(x, y);
  tft.print(unackedCount > 999 ? "999+" : String(unackedCount));
}

// The header's left word: the stage this device feeds, and the name the
// dashboard gave it. "NOT PAIRED" until a QR has been scanned.
String homeScreenName()
{
  if (!isPaired()) return "NOT PAIRED";
  String s = stageName;
  s.toUpperCase();
  if (stationName.length() > 0 && stationName != deviceId)
  {
    String n = stationName;
    if (n.length() > 8) n = n.substring(0, 8);
    s = s.substring(0, 7) + " " + n;
  }
  return s;
}

void drawHeader()
{
  tft.fillRect(0, 0, 160, 18, ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(isPaired() ? ST77XX_YELLOW : ST77XX_RED);
  tft.setCursor(4, 5);
  String md = homeScreenName();
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

// Field triage: link quality, pairing, queue, server address, version.
void showInfoScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(1);
  tft.setCursor(5, 22);
  tft.println("STATION INFO");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 34);
  tft.print("P:");
  tft.setTextColor(isPaired() ? ST77XX_WHITE : ST77XX_RED);
  tft.println(isPaired() ? (stageName + " " + (stationName.length() ? stationName : "")) : "Not paired");
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
  tft.setTextColor(storedScanCount >= QUEUE_WARN_THRESHOLD ? ST77XX_RED : (storedScanCount > 0 ? ST77XX_YELLOW : ST77XX_GREEN));
  tft.setCursor(5, 89);
  tft.print("Q:" + String(storedScanCount) + " hw:" + String(queueHighWater));
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 100);
  tft.println(serverHost + ":" + String(serverPort));
  tft.setTextColor(ST77XX_YELLOW);
  tft.setCursor(5, 113);
  tft.print("v" + currentFirmwareVersion + " b" + String(bootCount));
  tft.setTextColor(ST77XX_CYAN);
  tft.print(" S:" + String(operatorScanCount));
}

void drawNameLine(int y)
{
  tft.setTextSize(1);
  tft.setCursor(5, y);
  tft.setTextColor(ST77XX_GREEN);
  tft.print("ID: ");
  String nm = currentEmployeeId;
  if ((int)nm.length() > 20)
    nm = nm.substring(0, 18) + "..";
  tft.setTextColor(ST77XX_WHITE);
  tft.print(nm);
  // The person's name, once the server has resolved the badge. Not drawn when
  // it is just the badge again.
  if (currentEmployeeName.length() > 0 && currentEmployeeName != currentEmployeeId)
  {
    String n = currentEmployeeName;
    if (n.length() > 25) n = n.substring(0, 24) + ".";
    tft.setCursor(5, y + 11);
    tft.setTextColor(ST77XX_CYAN);
    tft.print(n);
  }
}
void showEmployeeScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  drawNameLine(26);
  tft.setTextColor(ST77XX_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 52);
  tft.print(stageDoneLabel.length() ? stageDoneLabel + " today: " : "Pieces today: ");
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(5, 64);
  tft.print(operatorScanCount);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 88);
  tft.print("Scan a piece.");
  tft.setCursor(5, 99);
  tft.setTextColor(ST77XX_CYAN);
  tft.print("Same ID card = sign out");
  lastDrawnQueue = -1;
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
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 70);
  tft.println("Pieces go to the " + stageName);
  tft.setCursor(5, 81);
  tft.println("dashboard under your name");
  lastDrawnQueue = -1;
  drawQueueLine();
}
// Until a QR has been scanned the device belongs to no dashboard, and says
// exactly how to fix that — the one setup step there is.
void showNotPairedScreen()
{
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(2);
  tft.setCursor(14, 28);
  tft.println("SCAN QR");
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 52);
  tft.println("Open Ironing or Trimming");
  tft.setCursor(5, 63);
  tft.println("> Scan > Access this");
  tft.setCursor(5, 74);
  tft.println("dashboard remotely, and");
  tft.setCursor(5, 85);
  tft.println("scan the code shown.");
  tft.setTextColor(ST77XX_CYAN);
  tft.setCursor(5, 100);
  tft.println("ID " + deviceId);
  lastDrawnQueue = -1;
  drawQueueLine();
}
void returnToHomeScreen()
{
  if (!isPaired())
    showNotPairedScreen();
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

void updateCheckTaskFn(void *param)
{
  UpdateJob *job = (UpdateJob *)param;
  UpdateResult *res = new UpdateResult();
  if (!res)
  {
    delete job;
    updTaskRunning = false;
    vTaskDelete(NULL);
  }
  res->gen = job->gen;
  res->verdict = 0;
  {
    HTTPClient http;
    http.begin(job->checkUrl);
    http.addHeader("Content-Type", "application/json");
    http.setReuse(false); // vTaskDelete(NULL) skips ~HTTPClient(); reuse would leak the socket
    http.setTimeout(10000);
    int code = http.POST(job->payload);
    String resp = (code == 200) ? http.getString() : String("");
    http.end();
    if (code == 200)
    {
      StaticJsonDocument<1024> r;
      if (!deserializeJson(r, resp))
      {
        bool upd = r["updateAvailable"] | false;
        if (upd && r.containsKey("firmware"))
        {
          JsonObject fw = r["firmware"];
          String ver = fw["version"].as<String>();
          String url = fw["url"].as<String>();
          if (ver.length() > 0 && url.length() > 0)
          {
            if (otaFailedVersion.length() > 0 && ver == otaFailedVersion)
              res->verdict = -1;
            else
            {
              res->version = ver;
              res->url = url;
              res->verdict = 1;
            }
          }
        }
        else
          res->verdict = -1;
      }
    }
  }
  delete job;
  if (updResultQueue == NULL || xQueueSend(updResultQueue, &res, 0) != pdTRUE)
    delete res;
  updTaskRunning = false;
  vTaskDelete(NULL);
}

bool startUpdateCheck()
{
  if (!isWiFiConnected() || deviceId.length() == 0 || updTaskRunning)
    return false;
  if (updResultQueue == NULL)
  {
    updResultQueue = xQueueCreate(1, sizeof(UpdateResult *));
    if (updResultQueue == NULL)
      return false;
  }
  UpdateResult *stale = NULL;
  while (xQueueReceive(updResultQueue, &stale, 0) == pdTRUE)
  {
    if (stale) delete stale;
    stale = NULL;
  }
  UpdateJob *job = new UpdateJob();
  if (!job)
    return false;
  job->checkUrl = deviceRegisterUrl();
  StaticJsonDocument<384> doc;
  doc["deviceId"] = deviceId;
  doc["product"] = FW_PRODUCT; // the OTA channel: only station builds are offered
  doc["machineId"] = "";
  doc["currentVersion"] = currentFirmwareVersion;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiSSID"] = wifiSSID;
  serializeJson(doc, job->payload);
  job->gen = ++updGeneration;
  updStartedAt = millis();
  updTaskRunning = true;
  if (xTaskCreatePinnedToCore(updateCheckTaskFn, "updchk", 8192, job, 1, NULL, 0) != pdPASS)
  {
    delete job;
    updTaskRunning = false;
    updStartedAt = 0;
    return false;
  }
  return true;
}

void handleUpdateCheckCompletion()
{
  if (updResultQueue == NULL)
    return;
  UpdateResult *res = NULL;
  if (xQueueReceive(updResultQueue, &res, 0) != pdTRUE || res == NULL)
    return;
  if (res->gen != updGeneration)
  {
    delete res;
    return;
  }
  if (res->verdict == 1)
  {
    newFirmwareVersion = res->version;
    newFirmwareUrl = res->url;
    updateAvailable = true;
    Serial.println("[OTA] Update available: " + newFirmwareVersion);
  }
  else if (res->verdict == -1)
    updateAvailable = false;
  delete res;
  updStartedAt = 0;
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
  if (cl < MIN_FIRMWARE_BYTES)
  {
    showMessageNB("Wrong file", cl <= 0 ? "No size sent" : String(cl / 1024) + "KB - need .ino.bin");
    delay(4000);
    http.end();
    otaFailedVersion = newFirmwareVersion;
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
  while (written < (size_t)cl)
  {
    size_t av = stream->available();
    if (av)
    {
      uint8_t buf[1024];
      size_t rd = stream->readBytes(buf, av > sizeof(buf) ? sizeof(buf) : av);
      if (rd > 0)
      {
        size_t w = Update.write(buf, rd);
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
      delay(2);
    }
    feedWatchdog();
  }
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

// ─── NVS: WiFi config ─────────────────────────────────────────────────────────
void saveConfig(String ssid, String pass)
{
  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.putString("wifi_ssid", ssid);
  preferences.putString("wifi_pass", pass);
  preferences.putBool("wifi_configured", true);
  preferences.end();
  wifiSSID = ssid;
  wifiPass = pass;
  wifiConfigured = true;
}
void loadConfig()
{
  preferences.begin(CONFIG_NAMESPACE, true);
  wifiSSID = preferences.getString("wifi_ssid", "");
  wifiPass = preferences.getString("wifi_pass", "");
  deviceId = makeDeviceId();
  wifiConfigured = preferences.getBool("wifi_configured", false);
  preferences.end();
}
void clearConfig()
{
  preferences.begin(CONFIG_NAMESPACE, false);
  preferences.clear();
  preferences.end();
}

// ─── NVS: Pairing ─────────────────────────────────────────────────────────────
void savePairing()
{
  Preferences p;
  p.begin(PAIR_NAMESPACE, false);
  p.putString("key", stationKey);
  p.putString("stage", stageSlug);
  p.putString("sname", stageName);
  p.putString("done", stageDoneLabel);
  p.putString("name", stationName);
  p.end();
}
void loadPairing()
{
  Preferences p;
  p.begin(PAIR_NAMESPACE, true);
  stationKey = p.getString("key", "");
  stageSlug = p.getString("stage", "");
  stageName = p.getString("sname", "");
  stageDoneLabel = p.getString("done", "");
  stationName = p.getString("name", "");
  p.end();
  if (stationKey.length() == 0 || stageSlug.length() == 0)
  {
    stationKey = ""; stageSlug = ""; stageName = ""; stageDoneLabel = ""; stationName = "";
  }
  Serial.println(isPaired() ? "[Pair] paired to " + stageSlug : "[Pair] not paired");
}
// Forgets the dashboard. `tellServer` posts /unpair first (best effort, 4 s)
// so the dashboard's list updates at once instead of on the next heartbeat gap.
void clearPairing(bool tellServer)
{
  if (tellServer && isPaired() && isWiFiConnected())
  {
    HTTPClient http;
    http.begin(unpairUrl());
    http.addHeader("X-Station-Key", stationKey);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(4000);
    http.POST("{}");
    http.end();
  }
  stationKey = ""; stageSlug = ""; stageName = ""; stageDoneLabel = ""; stationName = "";
  Preferences p;
  p.begin(PAIR_NAMESPACE, false);
  p.clear();
  p.end();
  // Whoever was signed in was signed in to THAT dashboard.
  if (isEmployeeSignedIn)
  {
    currentEmployeeName = ""; currentEmployeeId = ""; isEmployeeSignedIn = false; operatorScanCount = 0;
    saveEmployeeData();
  }
  recentPiecesClear();
  // Any in-flight task carries the old key; disown its verdict.
  hbGeneration++;
  hbTaskRunning = false;
  hbStartedAt = 0;
  bulkGeneration++;
  isSendingBulk = false;
  bulkStartedAt = 0;
  bulkTaskDone = false;
  bulkPendingCount = 0;
}

// ─── NVS: Operator ────────────────────────────────────────────────────────────
void saveEmployeeData()
{
  preferences.begin(OPERATOR_NAMESPACE, false);
  preferences.putString("empName", currentEmployeeName);
  preferences.putString("empId", currentEmployeeId);
  preferences.putBool("empSignedIn", isEmployeeSignedIn);
  preferences.putInt("empScanCount", operatorScanCount);
  preferences.end();
}
void loadEmployeeData()
{
  preferences.begin(OPERATOR_NAMESPACE, true);
  currentEmployeeName = preferences.getString("empName", "");
  currentEmployeeId = preferences.getString("empId", "");
  isEmployeeSignedIn = preferences.getBool("empSignedIn", false);
  operatorScanCount = preferences.getInt("empScanCount", 0);
  preferences.end();
  if (currentEmployeeId.isEmpty())
  {
    isEmployeeSignedIn = false;
    currentEmployeeName = "";
    operatorScanCount = 0;
  }
}
void clearEmployeeData()
{
  currentEmployeeName = "";
  currentEmployeeId = "";
  isEmployeeSignedIn = false;
  operatorScanCount = 0;
  recentPiecesClear();
  preferences.begin(OPERATOR_NAMESPACE, false);
  preferences.clear();
  preferences.end();
}

// The screen's tally, corrected from the server. Failure leaves the local
// number alone; this can only CORRECT the tally, never blank it. Also the
// moment the device learns the operator's NAME.
bool syncOperatorCountFromServer()
{
  if (!isEmployeeSignedIn || currentEmployeeId.isEmpty() || !isPaired() || !isWiFiConnected())
    return false;
  HTTPClient http;
  http.begin(operatorCountUrl() + "?operatorId=" + currentEmployeeId);
  http.addHeader("X-Station-Key", stationKey);
  http.setTimeout(5000);
  int code = http.GET();
  if (code == 401)
  {
    http.end();
    unpairedByServer = true;
    return false;
  }
  if (code != 200)
  {
    http.end();
    Serial.println("[Count] sync HTTP " + String(code) + " - keeping local " + String(operatorScanCount));
    return false;
  }
  String body = http.getString();
  http.end();
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, body) || !doc["success"].as<bool>() || !doc.containsKey("count"))
    return false;
  int serverCount = doc["count"].as<int>();
  if (serverCount < 0)
    return false;
  bool changed = false;
  if (doc.containsKey("name"))
  {
    String n = doc["name"].as<String>();
    if (n.length() > 0 && n != currentEmployeeName) { currentEmployeeName = n; changed = true; }
  }
  if (serverCount != operatorScanCount)
  {
    Serial.println("[Count] corrected " + String(operatorScanCount) + " -> " + String(serverCount));
    operatorScanCount = serverCount;
    changed = true;
  }
  if (changed)
  {
    saveEmployeeData();
    if (!visualFeedbackActive && !infoModeActive && !messagePending && scanFeedbackUntil == 0)
      showEmployeeScreen();
  }
  return true;
}

// ─── Queue persistence: LittleFS (v5.5.0) ─────────────────────────────────────
// Records are unit-separator delimited (0x1F): that byte cannot occur in a
// barcode or a badge, so nothing is escaped.
//
// Field order:
//   eventId ¦ type ¦ stage ¦ operatorId ¦ barcodeId ¦ scanEpoch ¦ timeRecovered
//
// millisAtScan is NOT persisted: millis() resets on reboot.
const char SEP = '\x1F';

void initQueueFS()
{
  fsReady = LittleFS.begin(true);
  if (!fsReady)
  {
    Serial.println("[FS] LittleFS mount FAILED - queue is RAM-only this boot");
    return;
  }
  Serial.println("[FS] LittleFS ready");
}

static String serializeEvent(const StoredEvent &e)
{
  String r;
  r.reserve(120);
  r += e.eventId; r += SEP;
  r += e.type; r += SEP;
  r += e.stage; r += SEP;
  r += e.operatorId; r += SEP;
  r += e.barcodeId; r += SEP;
  r += String((uint32_t)e.scanEpoch); r += SEP;
  r += (e.timeRecovered ? "1" : "0");
  return r;
}

static bool deserializeEvent(const String &line, StoredEvent &out)
{
  String f[7];
  int idx = 0, start = 0;
  for (int i = 0; i <= (int)line.length() && idx < 7; i++)
  {
    if (i == (int)line.length() || line.charAt(i) == SEP)
    {
      f[idx++] = line.substring(start, i);
      start = i + 1;
    }
  }
  if (idx < 7 || f[0].length() == 0)
    return false;
  out.eventId = f[0];
  out.type = f[1];
  out.stage = f[2];
  out.operatorId = f[3];
  out.barcodeId = f[4];
  out.scanEpoch = (time_t)f[5].toInt();
  out.timeRecovered = (f[6] == "1");
  out.millisAtScan = 0;
  return true;
}

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

void queueRewriteFS()
{
  if (!fsReady)
    return;
  if (storedScanCount == 0)
  {
    if (LittleFS.exists(QUEUE_FILE))
      LittleFS.remove(QUEUE_FILE);
    return;
  }
  File f = LittleFS.open(QUEUE_FILE, FILE_WRITE);
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
void clearScansData()
{
  storedScanCount = 0;
  unackedCount = 0;
  queueClearFS();
}

// Events queued while paired to ANOTHER stage are not sent to this one: the
// server records against the key's stage, and a trimming scan must never
// become an ironing record. Called after a (re)pairing. Loud, never silent.
int dropQueuedEventsOfOtherStages()
{
  int kept = 0, dropped = 0;
  for (int i = 0; i < storedScanCount; i++)
  {
    if (offlineScans[i].stage == stageSlug)
      offlineScans[kept++] = offlineScans[i];
    else
      dropped++;
  }
  if (dropped)
  {
    storedScanCount = kept;
    unackedCount = kept;
    queueRewriteFS();
    Serial.println("[Queue] dropped " + String(dropped) + " event(s) of another stage");
  }
  return dropped;
}

// ─── Memory wipe (ADMIN card) ─────────────────────────────────────────────────
// Screen rotation is deliberately kept: how the panel is mounted is a physical
// fact. The pairing IS cleared — a wiped device belongs to no dashboard.
void wipeAllMemory()
{
  clearPairing(true);
  clearEmployeeData();
  clearScansData();
  clearConfig();
  wifiSSID = "";
  wifiPass = "";
  wifiConfigured = false;
}

// The machine-scanner firmware's own state, left behind by a reflash. Cleared
// once: a machine assignment, an operations list or a break must never be
// read by this firmware, and the keys would otherwise sit in NVS for ever.
void retireMachineScannerState()
{
  Preferences p;
  p.begin("station_mig", false);
  if (p.getBool("v1", false)) { p.end(); return; }
  p.end();
  const char *old[] = { "scanner_emp", "scanner_ops", "scanner_opsf", "scanner_brk", "scanner_wo", "scanner_mach", "scanner_scans" };
  for (unsigned i = 0; i < sizeof(old) / sizeof(old[0]); i++)
  {
    Preferences q;
    if (q.begin(old[i], false)) { q.clear(); q.end(); }
  }
  // The machine firmware's queue file, if any: those were machine events.
  if (fsReady && LittleFS.exists("/queue.dat")) LittleFS.remove("/queue.dat");
  p.begin("station_mig", false);
  p.putBool("v1", true);
  p.end();
  Serial.println("[Boot] machine-scanner state retired");
}

// ─── Event identity ───────────────────────────────────────────────────────────
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

// ─── Clock recovery ───────────────────────────────────────────────────────────
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
      continue;
    unsigned long elapsedMs = (nowMs >= offlineScans[i].millisAtScan) ? (nowMs - offlineScans[i].millisAtScan) : 0;
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

// ─── Background send ──────────────────────────────────────────────────────────
int drainCount()
{
  return storedScanCount < MAX_EVENTS_PER_POST ? storedScanCount : MAX_EVENTS_PER_POST;
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
    rb += ",\"deviceId\":\"" + deviceId + "\"";
    if (e.operatorId.length() > 0)
      rb += ",\"operatorId\":\"" + e.operatorId + "\"";
    if (e.barcodeId.length() > 0)
      rb += ",\"barcodeId\":\"" + e.barcodeId + "\"";
    String iso = isoFromEpoch(e.scanEpoch);
    if (iso.length() > 0)
      rb += ",\"scanTime\":\"" + iso + "\"";
    rb += ",\"timeRecovered\":" + String(e.timeRecovered ? "true" : "false");
    rb += "}";
  }
  rb += "]}";
  return rb;
}

void bulkSendTaskFn(void *param)
{
  SendJob *job = (SendJob *)param;
  const uint32_t myGen = job->gen;
  SendResult *res = new SendResult();
  int code;
  {
    // The brace forces ~HTTPClient() to run before vTaskDelete(NULL): it is
    // the only thing that frees the socket when the peer closed first, and
    // lwIP has 16 of them.
    HTTPClient http;
    http.begin(job->url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Accept", "application/json");
    http.addHeader("X-Station-Key", job->key);
    http.setReuse(false);
    http.setTimeout(5000);
    code = http.POST(job->payload);
    if (res && (code == 200 || code == 401))
      res->body = http.getString();
    http.end();
  }
  delete job;

  if (myGen != bulkGeneration)
  {
    Serial.println("[Send] Stale task finished (HTTP " + String(code) + "), result discarded");
    if (res) delete res;
    vTaskDelete(NULL);
  }
  // A 2xx AND a 401 both prove the server is answering; only the former clears
  // the queue. The indicator is about reachability.
  noteBackendResult(code >= 200 && code < 300);
  if (res)
  {
    res->gen = myGen;
    res->code = code;
    if (sendResultQueue == NULL || xQueueSend(sendResultQueue, &res, 0) != pdTRUE)
      delete res;
  }
  bulkTaskDone = true;
  bulkTaskHandle = NULL;
  vTaskDelete(NULL);
}

void startBackgroundBulkSend()
{
  if (!isWiFiConnected() || storedScanCount == 0 || isSendingBulk || !isPaired())
    return;
  if (queueTimesPending)
    return;
  if (sendResultQueue == NULL)
  {
    sendResultQueue = xQueueCreate(1, sizeof(SendResult *));
    if (sendResultQueue == NULL)
      return;
  }
  SendResult *stale = NULL;
  while (xQueueReceive(sendResultQueue, &stale, 0) == pdTRUE)
  {
    if (stale) delete stale;
    stale = NULL;
  }
  SendJob *job = new SendJob();
  if (!job)
    return;
  bulkPendingCount = drainCount();
  job->gen = ++bulkGeneration;
  job->url = eventsUrl();
  job->key = stationKey;
  job->payload = buildBulkPayload(bulkPendingCount);
  bulkTaskDone = false;
  bulkStartedAt = millis();
  isSendingBulk = true;
  if (xTaskCreatePinnedToCore(bulkSendTaskFn, "bulksend", 12288, job, 1, &bulkTaskHandle, 0) != pdPASS)
  {
    delete job;
    isSendingBulk = false;
    bulkPendingCount = 0;
    Serial.println("[Send] Task create failed");
  }
}

void kickSender()
{
  if (isWiFiConnected() && !isSendingBulk && storedScanCount > 0)
    startBackgroundBulkSend();
}

// "2026-10-15T09:30:00.000Z" -> "15:00" on the factory clock (IST, +05:30).
// The server answers in UTC; the floor reads IST.
String istClockOf(const String &iso)
{
  if (iso.length() < 16 || iso.charAt(10) != 'T') return "";
  int hh = iso.substring(11, 13).toInt();
  int mm = iso.substring(14, 16).toInt();
  bool utc = iso.endsWith("Z") || iso.indexOf("+00:00") > 0;
  int mins = hh * 60 + mm + (utc ? 330 : 0);
  mins %= 1440;
  char buf[8];
  snprintf(buf, sizeof(buf), "%02d:%02d", mins / 60, mins % 60);
  return String(buf);
}

// What the server said about the pieces in the batch just confirmed. The
// batch is already cleared from the queue — the server has it — so this is
// about the SCREEN: an "already done" or an "invalid" piece gets a notice,
// and the tally takes the server's figure.
void showSendResults(const String &body)
{
  DynamicJsonDocument doc(8192);
  if (deserializeJson(doc, body))
    return;
  // The operator's true figure for today, from the book itself.
  if (doc["operator"].is<JsonObject>() && isEmployeeSignedIn)
  {
    String badge = doc["operator"]["badge"].as<String>();
    if (badge.equalsIgnoreCase(currentEmployeeId))
    {
      int n = doc["operator"]["piecesToday"] | -1;
      String name = doc["operator"]["name"].as<String>();
      bool changed = false;
      if (n >= 0 && n != operatorScanCount) { operatorScanCount = n; changed = true; }
      if (name.length() > 0 && name != currentEmployeeName) { currentEmployeeName = name; changed = true; }
      if (changed) saveEmployeeData();
      operatorCountSyncPending = false;
    }
  }
  JsonArray results = doc["results"].as<JsonArray>();
  // The LAST piece that was not simply saved is the one worth a notice; a
  // backlog of twenty-five is not twenty-five screens.
  String noticeHead, noticeWhat;
  uint16_t bg = ST77XX_YELLOW, ink = ST77XX_BLACK;
  for (JsonObject r : results)
  {
    String type = r["type"].as<String>();
    String status = r["status"].as<String>();
    if (type != "scan") continue;
    if (status == "already")
    {
      String who = r["doneBy"]["name"].as<String>();
      String when = istClockOf(r["doneAt"].as<String>());
      noticeHead = "ALREADY " + (stageDoneLabel.length() ? stageDoneLabel : String("DONE"));
      noticeHead.toUpperCase();
      if (noticeHead.length() > 13) noticeHead = "ALREADY DONE";
      noticeWhat = r["barcode"].as<String>() + " was done by " + (who.length() ? who : String("someone")) + (when.length() ? " at " + when : "") + ". Not counted again.";
      bg = ST77XX_YELLOW; ink = ST77XX_BLACK;
    }
    else if (status == "invalid")
    {
      noticeHead = "NOT SAVED";
      noticeWhat = r["barcode"].as<String>() + ": " + r["reason"].as<String>();
      bg = ST77XX_RED; ink = ST77XX_WHITE;
    }
  }
  if (noticeHead.length() && !infoModeActive)
    showNotice(bg, ink, noticeHead, noticeWhat, 3000);
}

void handleBulkSendCompletion()
{
  if (!isSendingBulk || !bulkTaskDone)
    return;
  SendResult *res = NULL;
  if (sendResultQueue != NULL)
    xQueueReceive(sendResultQueue, &res, 0);
  int code = res ? res->code : 0;

  if (res && res->gen != bulkGeneration)
  {
    delete res;
    res = NULL;
    code = 0;
  }

  if (code >= 200 && code < 300)
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
    queueRewriteFS();
    if (isPaired() && !visualFeedbackActive && !infoModeActive)
      drawQueueLine();
    Serial.println("[Send] OK: " + String(sent) + " confirmed, " + String(storedScanCount) + " still queued");
    if (res) showSendResults(res->body);
    if (storedScanCount > 0)
      sendBatchNow = true;
  }
  else if (code == 401 && res && res->body.indexOf("UNPAIRED") >= 0)
  {
    // The dashboard let this device go. The queue is kept: the next pairing
    // to the SAME stage sends it; another stage's pairing drops it, loudly.
    Serial.println("[Send] server says UNPAIRED");
    unpairedByServer = true;
  }
  else
  {
    lastSendConfirmed = false;
    Serial.println("[Send] Failed HTTP " + String(code) + " - " + String(storedScanCount) + " queued, will retry");
  }
  if (res) delete res;
  bulkPendingCount = 0;
  bulkTaskDone = false;
  isSendingBulk = false;
  bulkStartedAt = 0;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
void heartbeatTaskFn(void *param)
{
  SendJob *job = (SendJob *)param;
  const uint32_t myGen = job->gen;
  HeartbeatResult *res = new HeartbeatResult();
  int code;
  {
    HTTPClient http;
    http.begin(job->url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Station-Key", job->key);
    http.setReuse(false);
    http.setTimeout(4000);
    code = http.POST(job->payload);
    if (res)
    {
      res->unpaired = false;
      if (code == 200)
      {
        String body = http.getString();
        StaticJsonDocument<768> d;
        if (!deserializeJson(d, body) && d.containsKey("stationName"))
          res->stationName = d["stationName"].as<String>();
      }
      else if (code == 401)
      {
        String body = http.getString();
        res->unpaired = body.indexOf("UNPAIRED") >= 0;
      }
    }
    http.end();
  }
  delete job;
  if (myGen != hbGeneration)
  {
    if (res) delete res;
    vTaskDelete(NULL);
  }
  bool ok = (code >= 200 && code < 300);
  noteBackendResult(ok || code == 401); // 401 is an answer: the server is up
  if (ok && storedScanCount == 0)
    lastSendConfirmed = true;
  if (res)
  {
    res->gen = myGen;
    res->code = code;
    if (hbResultQueue == NULL || xQueueSend(hbResultQueue, &res, 0) != pdTRUE)
      delete res;
  }
  hbStartedAt = 0;
  hbTaskRunning = false;
  vTaskDelete(NULL);
}

void sendHeartbeat()
{
  if (!isWiFiConnected() || hbTaskRunning || deviceId.length() == 0 || !isPaired())
    return;
  if (hbResultQueue == NULL)
  {
    hbResultQueue = xQueueCreate(1, sizeof(HeartbeatResult *));
    if (hbResultQueue == NULL)
      return;
  }
  HeartbeatResult *stale = NULL;
  while (xQueueReceive(hbResultQueue, &stale, 0) == pdTRUE)
  {
    if (stale) delete stale;
    stale = NULL;
  }
  StaticJsonDocument<512> doc;
  doc["deviceId"] = deviceId;
  doc["product"] = FW_PRODUCT;
  doc["firmwareVersion"] = currentFirmwareVersion;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiSSID"] = wifiSSID;
  doc["rssi"] = (int)WiFi.RSSI();
  doc["wifiChannel"] = (int)WiFi.channel();
  doc["queueDepth"] = storedScanCount;
  doc["queueHighWater"] = queueHighWater;
  doc["currentOperatorId"] = isEmployeeSignedIn ? currentEmployeeId : "";
  doc["bootCount"] = bootCount;
  doc["uptimeSec"] = (uint32_t)(millis() / 1000UL);
  doc["resetReason"] = resetReasonText();
  SendJob *job = new SendJob();
  if (!job)
    return;
  job->gen = ++hbGeneration;
  job->url = heartbeatUrl();
  job->key = stationKey;
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

// Main-loop side of the heartbeat: the name the dashboard gave this device,
// and the one answer that changes everything — UNPAIRED.
void handleHeartbeatCompletion()
{
  if (hbResultQueue == NULL)
    return;
  HeartbeatResult *res = NULL;
  if (xQueueReceive(hbResultQueue, &res, 0) != pdTRUE || res == NULL)
    return;
  if (res->gen == hbGeneration)
  {
    if (res->unpaired)
      unpairedByServer = true;
    else if (res->code == 200 && res->stationName.length() > 0 && res->stationName != stationName)
    {
      stationName = res->stationName;
      savePairing();
      backendStateDirty = true; // the header shows the name
    }
  }
  delete res;
}

// One blocking probe, for the REFRESH check: GET /ping needs no key, so it
// says whether the server is there even when this device is not paired.
bool probeServer(bool *dbOk, int *httpCode)
{
  *dbOk = false;
  *httpCode = 0;
  if (!isWiFiConnected()) return false;
  HTTPClient http;
  http.begin(pingUrl());
  http.setTimeout(6000);
  *httpCode = http.GET();
  bool ok = (*httpCode == 200);
  if (ok)
  {
    String body = http.getString();
    *dbOk = body.indexOf("\"dbOk\":false") < 0;
  }
  http.end();
  return ok;
}

bool hardWifiReset()
{
  if (wifiSSID.length() == 0) return false;
  wifiRadioHardReset(true);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000)
  {
    delay(250);
    feedWatchdog();
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

  hbGeneration++;
  hbTaskRunning = false;
  hbStartedAt = 0;
  bulkGeneration++;
  isSendingBulk = false;
  bulkStartedAt = 0;
  bulkTaskDone = false;
  bulkPendingCount = 0;

  bool wifiOk = isWiFiConnected();
  bool serverOk = false, dbOk = false;
  int httpCode = 0;
  bool didHardReset = false;

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
  if (wifiOk)
  {
    tft.setCursor(5, 52);
    tft.println("Server...");
    serverOk = probeServer(&dbOk, &httpCode);
  }
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
      delay(400);
      feedWatchdog();
      tft.fillRect(0, 46, 160, 20, ST77XX_BLACK);
      tft.setCursor(5, 52);
      tft.println("Server...");
      serverOk = probeServer(&dbOk, &httpCode);
    }
  }
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
  lastHeartbeat = millis();
  if (serverOk && storedScanCount > 0)
    sendBatchNow = true;
  if (serverOk && isPaired())
    sendHeartbeat(); // proves the pairing too, in the background

  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  bool allOk = wifiOk && serverOk && dbOk && isPaired();
  tft.setTextSize(1);
  tft.setTextColor(allOk ? ST77XX_GREEN : ST77XX_RED);
  tft.setCursor(5, 22);
  tft.println(allOk ? "ALL OK" : "PROBLEM FOUND");
  int y = 36;
  const int STEP = 11;
  struct { const char *label; bool ok; } rows[] = {
    { "WiFi   ", wifiOk },
    { "Server ", serverOk },
    { "Databas", dbOk && serverOk },
    { "Paired ", isPaired() },
  };
  for (int i = 0; i < 4; i++)
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
  else if (!isPaired())
    tft.println("Scan the dashboard QR");
  else if (didHardReset)
    tft.println("Fixed by WiFi reset");
  else
    tft.println("Queue: " + String(storedScanCount));
  scanFeedbackUntil = millis() + 6000;
}

// ─── Stuck-task reclaim ───────────────────────────────────────────────────────
void reclaimStuckTasks()
{
  unsigned long now = millis();
  if (hbTaskRunning && hbStartedAt && (now - hbStartedAt) > TASK_STUCK_TIMEOUT_MS)
  {
    Serial.println("[Watchdog] Heartbeat task stuck - releasing flag");
    hbGeneration++;
    hbTaskRunning = false;
    hbStartedAt = 0;
    noteBackendResult(false);
  }
  if (updTaskRunning && updStartedAt && (now - updStartedAt) > TASK_STUCK_TIMEOUT_MS)
  {
    Serial.println("[Watchdog] Update-check task stuck - releasing flag");
    updGeneration++;
    updTaskRunning = false;
    updStartedAt = 0;
  }
  if (isSendingBulk && bulkStartedAt && (now - bulkStartedAt) > TASK_STUCK_TIMEOUT_MS)
  {
    Serial.println("[Watchdog] Send task stuck - releasing flag, " + String(storedScanCount) + " scans still queued");
    bulkGeneration++;
    bulkTaskDone = false;
    bulkPendingCount = 0;
    bulkTaskHandle = NULL;
    isSendingBulk = false;
    bulkStartedAt = 0;
    lastSendConfirmed = false;
    noteBackendResult(false);
  }
}

// ─── Queue an event ───────────────────────────────────────────────────────────
// Stamped with its identity and its context AT THIS MOMENT — the stage this
// device is paired to and the badge that is signed in — then the sender is
// kicked at once.
void queueEvent(const String &type, const String &barcodeId, const String &operatorId)
{
  StoredEvent e;
  e.eventId = nextEventId();
  e.type = type;
  e.stage = stageSlug;
  e.operatorId = operatorId;
  e.barcodeId = barcodeId;
  e.millisAtScan = millis();
  e.timeRecovered = false;
  time_t now;
  time(&now);
  e.scanEpoch = (now > 1700000000UL) ? now : 0;

  bool dropped = false;
  if (storedScanCount >= MAX_STORED_SCANS)
  {
    for (int i = 0; i < MAX_STORED_SCANS - 1; i++)
      offlineScans[i] = offlineScans[i + 1];
    offlineScans[MAX_STORED_SCANS - 1] = e;
    dropped = true;
    queueOverflowed = true;
    Serial.println("[Queue] FULL - oldest event DROPPED");
  }
  else
    offlineScans[storedScanCount++] = e;
  if (storedScanCount > queueHighWater)
    queueHighWater = storedScanCount;
  unackedCount = storedScanCount;
  if (dropped)
    queueRewriteFS();
  else
    queueAppendToFS(e);
  kickSender();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-device WiFi reliability (v5.4.0 CASE 7) — unchanged.
// ═══════════════════════════════════════════════════════════════════════════════
void applyWiFiTuning()
{
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 2
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
#endif
  String h = "GRAV-" + deviceId;
  WiFi.setHostname(h.c_str());
}

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
  WiFi.disconnect(true, false);
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
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
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

// Runs after every successful association. Must RETURN, not work (v5.6.3):
// it starts things that do not block and hands the rest to the phase machine
// loop() drives.
void onWiFiConnected()
{
  wifiConnectionFailCount = 0;
  Serial.println("[WiFi] Connected IP=" + WiFi.localIP().toString() + " RSSI=" + String(WiFi.RSSI()) + " ch=" + String(WiFi.channel()));
  sendHeartbeat();
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "in.pool.ntp.org", "pool.ntp.org", "time.nist.gov");
  operatorCountSyncPending = true;
  queueTimesPending = true;
  reconnectPhase = RC_WAIT_CLOCK;
  reconnectPhaseAt = millis();
}

void serviceReconnectFollowUp()
{
  if (reconnectPhase == RC_IDLE)
    return;
  if (!isWiFiConnected())
  {
    reconnectPhase = RC_IDLE;
    queueTimesPending = false;
    return;
  }
  if (reconnectPhase == RC_UPDATE_CHECK && (hbTaskRunning || backendStateDirty))
    return;
  switch (reconnectPhase)
  {
  case RC_WAIT_CLOCK:
  {
    time_t n;
    time(&n);
    if (n > 1700000000UL || (millis() - reconnectPhaseAt) >= RECONNECT_CLOCK_WAIT_MS)
      reconnectPhase = RC_QUEUE_TIMES;
    break;
  }
  case RC_QUEUE_TIMES:
    recoverQueuedTimes();
    queueTimesPending = false;
    if (storedScanCount > 0)
    {
      Serial.println("[Queue] draining " + String(storedScanCount) + " queued event(s)");
      sendBatchNow = true;
    }
    reconnectPhase = RC_UPDATE_CHECK;
    break;
  case RC_UPDATE_CHECK:
    startUpdateCheck();
    reconnectPhase = RC_IDLE;
    break;
  default:
    reconnectPhase = RC_IDLE;
    queueTimesPending = false;
    break;
  }
}

void connectToWiFi()
{
  if (!wifiConfigured || wifiSSID.length() == 0)
  {
    startConfigMode();
    return;
  }
  showScreen("Connecting", "SSID: " + wifiSSID, isPaired() ? "Station: " + stageName : "Not paired yet");
  bool ok = false;
  for (int a = 1; a <= WIFI_BOOT_ATTEMPTS && !ok; a++)
  {
    tft.fillRect(0, 88, 160, 14, ST77XX_BLACK);
    tft.setTextColor(ST77XX_CYAN);
    tft.setTextSize(1);
    tft.setCursor(5, 90);
    tft.print("Attempt " + String(a) + "/" + String(WIFI_BOOT_ATTEMPTS));
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
    showMessageNB("Connected!", isPaired() ? "Station: " + stageName : "Scan the dashboard QR");
    delay(2000);
  }
  else
  {
    wifiConnectionFailCount++;
    showMessageNB("Connection Failed", "Will retry every 30s");
    delay(2000);
  }
}

static unsigned long wifiRetryIntervalFor(int fails)
{
  if (fails <= 3) return 3000UL;
  if (fails <= 8) return 10000UL;
  return WIFI_CONNECTION_RETRY_INTERVAL;
}

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
      backendOk = false;
      backendFailStreak = BACKEND_FAIL_THRESHOLD;
      backendStateDirty = true;
    }
    lastWiFiState = cur;
  }
  if (!cur && (now - lastWiFiConnectionAttempt) > wifiRetryIntervalFor(wifiConnectionFailCount))
  {
    lastWiFiConnectionAttempt = now;
    wifiConnectionFailCount++;
    if (wifiConnectionFailCount <= 2)
      WiFi.reconnect();
    else if (wifiConnectionFailCount <= 5)
    {
      WiFi.disconnect(false, false);
      delay(60);
      WiFi.mode(WIFI_STA);
      applyWiFiTuning();
      WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
    }
    else
    {
      wifiRadioHardReset(wifiConnectionFailCount >= 10);
      if (wifiConnectionFailCount >= 40 && !isEmployeeSignedIn && storedScanCount == 0)
      {
        Serial.println("[WiFi] Unrecoverable and idle - restarting");
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
      startUpdateCheck();
    }
  }
}

// ─── PAIRING — the QR off the dashboard ───────────────────────────────────────
// Blocking, on purpose: someone is standing here holding the device at the
// screen, and the answer decides what the device IS from now on. One POST,
// 8 s ceiling, the watchdog fed around it.
void handlePairBarcode(const String &s)
{
  String token = s;
  token.trim();
  if (!isWiFiConnected())
  {
    showScanError("P1", "NO WIFI", "The device must reach the server to pair, and WiFi is down.",
                  "Wait for the WiFi bars, then scan the code again.");
    return;
  }
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();
  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(1);
  tft.setCursor(5, 30);
  tft.println("PAIRING...");
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(5, 44);
  tft.println("Asking the server");

  // A device already paired elsewhere: flush what it holds for THAT dashboard
  // first, bounded, exactly as a SRV: re-point does.
  if (isPaired() && storedScanCount > 0)
  {
    if (queueTimesPending) { recoverQueuedTimes(); queueTimesPending = false; }
    reconnectPhase = RC_IDLE;
    unsigned long t0 = millis();
    while (storedScanCount > 0 && (millis() - t0) < 15000)
    {
      if (!isSendingBulk) startBackgroundBulkSend();
      handleBulkSendCompletion();
      delay(100);
      feedWatchdog();
    }
    handleBulkSendCompletion();
  }

  StaticJsonDocument<512> req;
  req["deviceId"] = deviceId;
  req["pairToken"] = token;
  req["product"] = FW_PRODUCT;
  req["firmwareVersion"] = currentFirmwareVersion;
  req["ipAddress"] = WiFi.localIP().toString();
  req["wifiSSID"] = wifiSSID;
  String payload;
  serializeJson(req, payload);

  HTTPClient http;
  http.begin(pairUrl());
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);
  int code = http.POST(payload);
  String body = (code > 0) ? http.getString() : String("");
  http.end();
  feedWatchdog();

  if (code == 200)
  {
    StaticJsonDocument<1024> d;
    if (deserializeJson(d, body) || !d["success"].as<bool>() || !d.containsKey("stationKey"))
    {
      showScanError("P3", "BAD REPLY", "The server answered, but not with a pairing.",
                    "Try the code again. If it fails again, tell your supervisor.");
      return;
    }
    String oldStage = stageSlug;
    // Disown anything in flight under the old key before the new one lands.
    hbGeneration++; hbTaskRunning = false; hbStartedAt = 0;
    bulkGeneration++; isSendingBulk = false; bulkStartedAt = 0; bulkTaskDone = false; bulkPendingCount = 0;

    stationKey = d["stationKey"].as<String>();
    stageSlug = d["stage"]["slug"].as<String>();
    stageName = d["stage"]["name"].as<String>();
    stageDoneLabel = d["stage"]["doneLabel"].as<String>();
    stationName = d["stationName"].as<String>();
    savePairing();

    if (oldStage.length() && oldStage != stageSlug && isEmployeeSignedIn)
    {
      // The operator was signed in to the OTHER dashboard; that session ends.
      clearEmployeeData();
    }
    int dropped = dropQueuedEventsOfOtherStages();
    operatorCountSyncPending = true;
    lastOperatorCountSync = 0;
    backendOk = true;
    backendFailStreak = 0;
    backendStateDirty = true;
    Serial.println("[Pair] paired to " + stageSlug + " as " + stationName);

    String head = stageName;
    head.toUpperCase();
    String what = "This device now records into the " + stageName + " dashboard" +
                  (stationName.length() && stationName != deviceId ? " as " + stationName : String("")) + ".";
    if (dropped) what += " " + String(dropped) + " queued scan(s) from " + oldStage + " were dropped.";
    showNotice(ST77XX_GREEN, ST77XX_BLACK, "PAIRED " + head.substring(0, 6), what + " Scan your ID card to begin.", 4000);
    sendHeartbeat();
    return;
  }
  if (code == 400)
  {
    showScanError("P2", "OLD CODE", "That pairing code is not valid, or it has expired (a code lasts 10 minutes).",
                  "On the dashboard press New code, then scan the fresh one.");
    return;
  }
  showScanError("P4", "NO SERVER", "Could not reach the server to pair (HTTP " + String(code) + ").",
                "Check the server on the PC, then scan the code again.");
}

// UNPAIR_STATION card: forget the dashboard. The server is told so the list
// updates at once; if it cannot be reached, the heartbeat gap tells it.
void handleUnpairBarcode()
{
  if (!isPaired())
  {
    showNotice(ST77XX_YELLOW, ST77XX_BLACK, "NOT PAIRED", "This device is not paired to any dashboard.", 2000);
    return;
  }
  String was = stageName;
  clearPairing(true);
  showNotice(ST77XX_YELLOW, ST77XX_BLACK, "UNPAIRED", "No longer recording into " + was + ". Scan a dashboard QR to pair again.", 3000);
  backendStateDirty = true;
}

// ─── WiFi update barcode ──────────────────────────────────────────────────────
void handleWiFiUpdateBarcode(const String &s)
{
  String newSSID, newPass;
  if (!parseWiFiUpdateBarcode(s, newSSID, newPass))
  {
    showScanError("E6", "BAD WIFI", "WiFi setup card could not be read.", "Card must read SSID:<name>,PASSWORD:<pass>");
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
  saveConfig(newSSID, newPass);
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
}

// ─── Server update barcode ────────────────────────────────────────────────────
// SRV:192.168.1.80:5001 — re-points scans, heartbeats, pairing AND OTA at once.
// The pairing is KEPT: the key is signed by the CMS's secret, which the factory
// PC and the hosted server share, and the device record lives in the one
// MongoDB they share. A device moved to the other server is still paired.
void handleServerUpdateBarcode(const String &s)
{
  String newScheme = DEFAULT_SERVER_SCHEME;
  String newHost;
  int newPort = DEFAULT_SERVER_PORT;
  int newCmsPort = DEFAULT_CMS_PORT;
  if (!parseServerUpdateBarcode(s, newScheme, newHost, newPort, newCmsPort))
  {
    showScanError("E7", "BAD SRV", "Server setup card could not be read.", "SRV:192.168.1.50:5001 or SRV:https://host");
    return;
  }
  if (queueTimesPending)
  {
    recoverQueuedTimes();
    queueTimesPending = false;
  }
  reconnectPhase = RC_IDLE;
  if (storedScanCount > 0 && isWiFiConnected() && isPaired())
  {
    showScreen("SERVER UPDATE", "Flushing " + String(storedScanCount) + " events", "Please wait...");
    unsigned long t0 = millis();
    while (storedScanCount > 0 && (millis() - t0) < 20000)
    {
      if (!isSendingBulk)
        startBackgroundBulkSend();
      handleBulkSendCompletion();
      delay(100);
      feedWatchdog();
    }
    handleBulkSendCompletion();
  }
  bool leftover = (storedScanCount > 0);
  hbGeneration++; hbTaskRunning = false; hbStartedAt = 0;
  bulkGeneration++; isSendingBulk = false; bulkStartedAt = 0; bulkTaskDone = false; bulkPendingCount = 0;
  backendOk = false;
  backendFailStreak = BACKEND_FAIL_THRESHOLD;
  backendStateDirty = true;
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
  if (isWiFiConnected())
    sendHeartbeat();
  messageShowUntil = millis() + 100;
  messagePending = true;
}

// ─── WiFi setup portal ────────────────────────────────────────────────────────
void handleRoot()
{
  String html = R"rawliteral(<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial;background:#f2f4f7;margin:0;padding:20px}.container{max-width:420px;margin:0 auto;background:white;padding:25px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}h2{margin-top:0;color:#222;text-align:center}h3{color:#444;margin:15px 0 5px;font-size:16px}input,select{width:100%;padding:12px;margin:6px 0;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px}.pw-wrap{position:relative;margin:6px 0}.pw-wrap input{margin:0;padding-right:44px}.eye-btn{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;padding:0;width:32px;height:32px}.primary-btn{background:#4CAF50;color:white;padding:14px;border:none;border-radius:6px;cursor:pointer;width:100%;font-size:16px;margin-top:10px}.primary-btn:disabled{background:#aaa;cursor:not-allowed}.status{margin-top:15px;padding:10px;border-radius:6px;display:none}.success{background:#d4edda;color:#155724;display:block}.error{background:#f8d7da;color:#721c24;display:block}.info{background:#e7f3ff;color:#004085;display:block}.note{font-size:12px;color:#666;margin-top:6px;background:#f8f9fa;border-left:3px solid #4CAF50;padding:8px 10px;border-radius:4px}.divider{border-top:1px solid #eee;margin:20px 0 10px}#scanStatus{font-size:12px;color:#888;margin:4px 0}</style>
</head><body><div class="container"><h2>&#9881; GRAV Station Setup</h2>
<h3>1. WiFi Network</h3><div id="scanStatus">Scanning...</div>
<select id="ssidDropdown" onchange="onDropdownSelect(this)"><option value="">-- Scanning... --</option></select>
<input type="text" id="ssid" placeholder="WiFi SSID" required>
<div class="pw-wrap"><input type="password" id="password" placeholder="WiFi Password"><button class="eye-btn" type="button" onclick="togglePw()">&#128065;</button></div>
<h3>2. Production Server (LAN)</h3>
<input type="text" id="serverHost" placeholder="Server IP e.g. 192.168.1.80" required>
<input type="number" id="serverPort" placeholder="Port (default %SCANNER_PORT%)">
<div class="note">The factory PC running the CMS, on this same network. Use its reserved LAN IP &mdash; never <b>localhost</b> (to the device that means itself).</div>
<button class="primary-btn" id="saveBtn" onclick="saveConfig()">Save &amp; Connect</button>
<div class="divider"></div>
<div class="note">&#128279; After it connects, open the Ironing or Trimming dashboard &rarr; Scan &rarr; <b>Access this dashboard remotely</b> and scan the QR with this device. That is the whole setup.</div>
<div class="note">&#128273; WiFi update barcode: <b>SSID:NetworkName,PASSWORD:YourPass</b></div>
<div class="note">&#128225; Server update barcode: <b>SRV:192.168.1.80:5001</b> (LAN) or <b>SRV:https://host</b> (hosted)</div>
<div class="note">&#128683; Forget the dashboard: scan <b>UNPAIR_STATION</b></div>
<div class="note">&#8505; Info screen: scan <b>INFO_ADMIN_2790</b> &middot; recheck: <b>REFRESH_SYSTEM</b></div>
<div class="note">&#128260; Screen upside down? Scan <b>ROTATE_SCREEN</b></div>
<div id="status" class="status"></div></div>
<script>
var pwVisible=false;
function togglePw(){pwVisible=!pwVisible;var i=document.getElementById('password');i.type=pwVisible?'text':'password';document.querySelector('.eye-btn').innerHTML=pwVisible?'&#128584;':'&#128065;';}
function loadExistingConfig(){fetch('/status').then(r=>r.json()).then(d=>{if(d.ssid)document.getElementById('ssid').value=d.ssid;if(d.serverHost)document.getElementById('serverHost').value=d.serverHost;if(d.serverPort)document.getElementById('serverPort').value=d.serverPort;if(d.configured){var s=document.getElementById('status');s.className='status info';s.innerHTML='Config loaded. Enter password to update.';s.style.display='block';}}).catch(function(){});}
function scanNetworks(){document.getElementById('scanStatus').textContent='Scanning...';fetch('/scan').then(r=>r.json()).then(d=>{if(d.status==='scanning'){setTimeout(scanNetworks,3000);return;}var dd=document.getElementById('ssidDropdown'),cur=document.getElementById('ssid').value;if(d.networks&&d.networks.length>0){var h='<option value="">-- Select Network --</option>';d.networks.forEach(function(n){var s=(n.ssid===cur)?' selected':'';var b=n.rssi>-60?'&#9608;&#9608;&#9608;':n.rssi>-75?'&#9608;&#9608;&#9617;':'&#9608;&#9617;&#9617;';h+='<option value="'+n.ssid+'"'+s+'>'+b+' '+n.ssid+' ('+n.rssi+'dBm)</option>';});dd.innerHTML=h;document.getElementById('scanStatus').textContent='Found '+d.networks.length+' network(s).';if(cur)dd.value=cur;}else{dd.innerHTML='<option value="">-- No networks --</option>';document.getElementById('scanStatus').textContent='None found. Enter manually.';}}).catch(function(){document.getElementById('scanStatus').textContent='Scan failed.';});}
function onDropdownSelect(s){if(s.value)document.getElementById('ssid').value=s.value;}
function saveConfig(){var ssid=document.getElementById('ssid').value.trim();var password=document.getElementById('password').value;var serverHost=document.getElementById('serverHost').value.trim();var serverPort=document.getElementById('serverPort').value.trim()||'%SCANNER_PORT%';if(!ssid){alert('Enter WiFi SSID');return;}if(!serverHost){alert('Enter the production server IP');return;}if(/^(localhost|127\.)/i.test(serverHost)){alert('localhost means the device itself. Enter the PC LAN IP, e.g. 192.168.1.80');return;}var btn=document.getElementById('saveBtn');btn.disabled=true;btn.textContent='Saving...';var s=document.getElementById('status');s.className='status info';s.innerHTML='Saving...';s.style.display='block';fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'ssid='+encodeURIComponent(ssid)+'&password='+encodeURIComponent(password)+'&serverHost='+encodeURIComponent(serverHost)+'&serverPort='+encodeURIComponent(serverPort)}).then(r=>r.json()).then(d=>{if(d.success){s.className='status success';s.innerHTML='Saved! ID: <b>'+d.deviceId+'</b>. Restarting...';}else{s.className='status error';s.innerHTML='Error: '+d.message;btn.disabled=false;btn.textContent='Save & Connect';}}).catch(function(e){s.className='status error';s.innerHTML='Failed: '+e;btn.disabled=false;btn.textContent='Save & Connect';});}
window.onload=function(){loadExistingConfig();scanNetworks();};
</script></body></html>)rawliteral";
  html.replace("%SCANNER_PORT%", String(DEFAULT_SERVER_PORT));
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
  if (!server.hasArg("ssid"))
  {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing params\"}");
    return;
  }
  String ssid = server.arg("ssid"), pass = server.arg("password");
  if (ssid.length() == 0)
  {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Empty field\"}");
    return;
  }
  String nd = makeDeviceId();
  saveConfig(ssid, pass);
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
  String j = "{\"configured\":" + String(wifiConfigured ? "true" : "false") + ",\"connected\":" + String(isWiFiConnected() ? "true" : "false") +
             ",\"ssid\":\"" + wifiSSID + "\",\"deviceId\":\"" + deviceId + "\",\"paired\":" + String(isPaired() ? "true" : "false") +
             ",\"stage\":\"" + stageSlug + "\",\"serverHost\":\"" + serverHost + "\",\"serverPort\":" + String(serverPort) +
             ",\"queued\":" + String(storedScanCount) + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.send(200, "application/json", j);
}
void startConfigMode()
{
  inConfigMode = true;
  configModeStartTime = millis();
  WiFi.disconnect();
  delay(500);
  String id = makeDeviceId();
  fullAP_SSID = String(AP_SSID) + "-" + id.substring(id.length() - 4);
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

// ─── The scan itself ──────────────────────────────────────────────────────────
// An ID card signs in, the same card signs out, another card takes over; a
// piece is queued and sent. Nothing else is a valid read here.
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
  if (scanId.indexOf(REFRESH_KEYWORD) >= 0)
  {
    handleRefreshSystem();
    return;
  }
  if (!isPaired())
  {
    showScanError("E3", "NOT PAIRED",
                  "This device is not paired to any dashboard, so nothing can be recorded.",
                  "Open Ironing or Trimming > Scan > Access this dashboard remotely, and scan the QR shown.");
    return;
  }

  if (isEmployeeId(scanId))
  {
    scanId.toUpperCase();
    if (isEmployeeSignedIn && currentEmployeeId == scanId)
    {
      queueEvent("signout", "", scanId);
      String outName = currentEmployeeName.length() ? currentEmployeeName : currentEmployeeId;
      int made = operatorScanCount;
      clearEmployeeData();
      showVisualFeedback(true, outName + " signed out. " + String(made) + " " + (stageDoneLabel.length() ? stageDoneLabel : String("done")) + " today.");
      visualFeedbackUntil = millis() + 2500;
      scanFeedbackUntil = visualFeedbackUntil;
      return;
    }
    if (isEmployeeSignedIn && currentEmployeeId != scanId)
    {
      queueEvent("signout", "", currentEmployeeId);
      clearEmployeeData();
    }
    currentEmployeeId = scanId;
    currentEmployeeName = "";
    isEmployeeSignedIn = true;
    operatorScanCount = 0;
    recentPiecesClear();
    saveEmployeeData();
    // Zero is a starting guess: the server knows this person's real figure
    // for today at this stage, and loop() fetches it.
    operatorCountSyncPending = true;
    lastOperatorCountSync = 0;
    queueEvent("signin", "", scanId);
    showVisualFeedback(true, "Signed in: " + scanId + ". Scan pieces now.");
    visualFeedbackUntil = millis() + 1800;
    scanFeedbackUntil = visualFeedbackUntil;
    return;
  }

  if (isBarcodeId(scanId))
  {
    if (!isEmployeeSignedIn)
    {
      showScanError("E2", "NO ID", "Nobody is signed in on this device, so this piece cannot be recorded.",
                    "Scan your ID card first. Then scan the garment tag again.");
      return;
    }
    if (recentPieceSeen(scanId))
    {
      showNotice(ST77XX_YELLOW, ST77XX_BLACK, "SAME PIECE", scanId + " was already scanned here. Not counted again.", 1500);
      return;
    }
    recentPieceAdd(scanId);
    queueEvent("scan", scanId, currentEmployeeId);
    operatorScanCount++;
    showVisualFeedback(true, "#" + String(operatorScanCount) + " " + scanId + (isWiFiConnected() && backendOk ? "" : " (queued)"));
    return;
  }

  showScanError("E1", "BAD CODE",
                "Not a garment tag or an ID card. Read: " + scanId.substring(0, 16),
                "Scan the tag on the garment. If it fails again, use another tag and tell your supervisor.");
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup()
{
  Serial.begin(115200);
  delay(500);
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.initR(INITR_BLACKTAB);
  loadScreenRotation();
  tft.setRotation(screenRotation);
  tft.fillScreen(ST77XX_BLACK);
  loadConfig();
  loadBootCount();
  loadServerConfig();
  initQueueFS();
  retireMachineScannerState();
  loadFirmwareVersion();
  loadPairing();
  loadEmployeeData();
  queueLoadFromFS();
  unackedCount = storedScanCount;
  ScannerSerial.begin(9600, SERIAL_8N1, SCANNER_RX, SCANNER_TX);
  showSplashScreen();
  if (!wifiConfigured)
    startConfigMode();
  else
  {
    connectToWiFi();
    lastWiFiState = isWiFiConnected();
    if (storedScanCount > 0 && isWiFiConnected())
      sendBatchNow = true;
    returnToHomeScreen();
  }
  unsigned long now = millis();
  lastHeaderRefresh = now;
  lastQueueRetry = now;
  lastHeartbeat = 0;
  operatorCountSyncPending = true;
  lastOperatorCountSync = 0;
  lastWiFiConnectionAttempt = now;
  lastUpdateCheck = now;
  lastAcceptedScanTime = 0;
  Serial.println("[Boot] reset reason: " + resetReasonText());
  startLoopWatchdog();
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop()
{
  feedWatchdog();

  if (inConfigMode)
  {
    dnsServer.processNextRequest();
    server.handleClient();
    while (ScannerSerial.available())
    {
      char c = ScannerSerial.read();
      if (c == '\n' || c == '\r')
      {
        String v = scannedData;
        scannedData = "";
        v.trim();
        if (isRotateBarcode(v))
        {
          toggleScreenRotation();
          delay(200);
          ESP.restart();
        }
      }
      else if (scannedData.length() < 64)
        scannedData += c;
    }
    if (millis() - configModeStartTime > CONFIG_MODE_TIMEOUT)
      ESP.restart();
    return;
  }

  unsigned long now = millis();

  if (visualFeedbackActive && now >= visualFeedbackUntil)
  {
    visualFeedbackActive = false;
    scanFeedbackUntil = 0;
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
  }
  if (infoModeActive && (now - infoModeStartTime > INFO_MODE_DURATION))
  {
    infoModeActive = false;
    returnToHomeScreen();
  }

  handleBulkSendCompletion();
  handleHeartbeatCompletion();
  handleUpdateCheckCompletion();
  reclaimStuckTasks();
  checkWiFiConnection();
  serviceReconnectFollowUp();

  // The dashboard let this device go (a 401 UNPAIRED from any call). Acted on
  // here, on core 1, which owns NVS and the screen.
  if (unpairedByServer)
  {
    unpairedByServer = false;
    if (isPaired())
    {
      String was = stageName;
      clearPairing(false);
      Serial.println("[Pair] released by the dashboard");
      showNotice(ST77XX_YELLOW, ST77XX_BLACK, "RELEASED", "The " + was + " dashboard let this device go. Scan a dashboard QR to pair again.", 4000);
    }
  }

  if (updateAvailable && isWiFiConnected() && !infoModeActive)
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

  // Retry path for events that could not be delivered, plus the continuation
  // of a backlog draining 25 at a time. The normal send is the scan itself.
  if (isWiFiConnected() && isPaired() && !isSendingBulk && storedScanCount > 0)
  {
    bool retryDue = (now - lastQueueRetry) >= QUEUE_RETRY_INTERVAL;
    if (sendBatchNow || retryDue)
    {
      sendBatchNow = false;
      lastQueueRetry = now;
      startBackgroundBulkSend();
    }
  }

  unsigned long hbInterval = (backendFailStreak > 0) ? HEARTBEAT_FAST_RETRY_MS : HEARTBEAT_INTERVAL;
  if (isWiFiConnected() && isPaired() && (lastHeartbeat == 0 || (now - lastHeartbeat) >= hbInterval))
  {
    lastHeartbeat = now;
    sendHeartbeat();
  }
  // Not paired: the reachability tick still has to mean something, so probe
  // /ping on the heartbeat cadence instead.
  if (isWiFiConnected() && !isPaired() && (lastHeartbeat == 0 || (now - lastHeartbeat) >= hbInterval))
  {
    lastHeartbeat = now;
    bool dbOk; int code;
    noteBackendResult(probeServer(&dbOk, &code));
  }

  if (!clockValid && isWiFiConnected() && storedScanCount > 0)
    recoverQueuedTimes();

  if (operatorCountSyncPending && isWiFiConnected() && isPaired() && isEmployeeSignedIn &&
      (lastOperatorCountSync == 0 || (now - lastOperatorCountSync) >= OPERATOR_COUNT_RETRY_MS))
  {
    lastOperatorCountSync = now;
    if (syncOperatorCountFromServer())
      operatorCountSyncPending = false;
  }

  bool statusChanged = backendStateDirty;
  bool headerDue = (now - lastHeaderRefresh) > HEADER_REFRESH_INTERVAL;
  if ((headerDue || statusChanged) && !visualFeedbackActive && !infoModeActive && !messagePending && scanFeedbackUntil == 0)
    drawQueueLine();
  if ((headerDue || statusChanged) && !visualFeedbackActive)
  {
    drawHeader();
    lastHeaderRefresh = now;
    backendStateDirty = false;
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

        if (isRotateBarcode(scanValue))
        {
          toggleScreenRotation();
          lastDrawnQueue = -1;
          if (infoModeActive) showInfoScreen(); else returnToHomeScreen();
          break;
        }
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
        if (isWiFiUpdateBarcode(scanValue)) { handleWiFiUpdateBarcode(scanValue); break; }
        if (isServerUpdateBarcode(scanValue)) { handleServerUpdateBarcode(scanValue); break; }
        if (isPairBarcode(scanValue)) { handlePairBarcode(scanValue); break; }
        if (isUnpairBarcode(scanValue)) { handleUnpairBarcode(); break; }
        processLocalScan(scanValue);
        break;
      }
    }
    else if (scannedData.length() < 160) // a pairing QR is ~55 chars; a URL-form badge longer
      scannedData += c;
  }
}
