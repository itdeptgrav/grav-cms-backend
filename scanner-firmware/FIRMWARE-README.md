# GRAV Remote Station firmware (v1.0.0) — the current firmware for the hand scanners

The ESP32 scanners are no longer fitted to sewing machines. Each one is paired
to a **finishing dashboard** (Ironing, Trimming) and becomes that dashboard's
remote input (owner, 15 Oct 2026: three ironing stations and four trimmers;
tablets cost too much, use the scanner devices).

The sketch is `GRAV_Station_v1_0_0/GRAV_Station_v1_0_0.ino`. The machine-scanner
sketch it replaces (`GRAV_Scanner_v5_6_7/`) is retired — kept only as the record
of what the devices ran before; do not flash it.

## What the operator does

| Step | Scan | Screen |
|---|---|---|
| 1 (once, setup) | the QR under **Access this dashboard remotely** on the Ironing / Trimming **Scan** page | `PAIRED IRONING` |
| 2 | their ID card (`GR…`) | `Signed in: GR0045` — the name appears once the server answers |
| 3 | each garment piece (`WO-<id>-<unit>`) | `#N WO-…` green; later `ALREADY DONE by X at HH:MM` (yellow) or `NOT SAVED: reason` (red) if the server refused it |
| 4 | the same ID card | `… signed out. N ironed today.` |

Everything goes into the same book the dashboard's own scan screen writes
(`finishingscans`), under the operator's name, flagged `source: "device"` with
the device id and the device's own event id. The dashboard's Overview shows
them with "via scanner device"; the Scan page's **Access this dashboard
remotely** drawer lists every paired device, who is on it and today's pieces,
and can let a device go.

## Before you flash

1. **Partition scheme**: Tools → Partition Scheme → *Default 4MB with spiffs
   (1.2MB APP / 1.5MB SPIFFS)*. The offline queue lives on LittleFS.
2. **Server address**: `DEFAULT_SERVER_HOST` is `192.168.1.80` (the factory
   PC, scanner compat port 5001, CMS on 5000). A device reflashed from the
   machine firmware keeps its WiFi and server settings — it only needs the QR.
3. **Flash at end of shift** if a device still holds queued scans from the
   machine firmware: that queue (`/queue.dat`) is machine data and is removed
   on the first boot of this firmware.
4. **Upload** on Production Supervisor → Firmware with device type **Remote
   finishing station** and version exactly `FW_VERSION`. A station build is
   only ever offered to station devices (`product: "station"` on check-update),
   and a machine build never to a station.

## Config barcodes

| Barcode | Effect |
|---|---|
| `GRAVSTN:<token>` (the dashboard's QR) | Pair to that dashboard. Good for 10 minutes; the pairing is permanent until let go. |
| `UNPAIR_STATION` | Forget the dashboard (the dashboard is told). |
| `SRV:192.168.1.80:5001` / `SRV:https://host` | Point at a server. The pairing survives: the key is signed by the CMS secret the servers share. |
| `SSID:<net>,PASSWORD:<pw>` | WiFi credentials |
| `INFO_ADMIN_2790` | Info screen (10 s): pairing, device id, signal, queue, server, version |
| `REFRESH_SYSTEM` | Recheck WiFi / server / database / pairing now, with a WiFi hard reset if the server is unreachable |
| `ROTATE_SCREEN` | Flip the panel 180° |
| `ADMIN-CONFIG-94731` | Wipe everything (pairing included) and enter the WiFi setup portal |

## Reading the screen

Header: the stage (and the device's name from the dashboard) on the left; the
server tick / cross / in-flight count in the middle; WiFi bars on the right.
Bottom strip: `Pending: N` (queued, not yet confirmed), `No server`, `Upd: vX`.
`NOT PAIRED` in red on the left, and a `SCAN QR` screen, until a QR is scanned.

## Offline

A scan is written to LittleFS the instant it is read and sent at once; if the
server is away it is retried every 30 s and survives a reboot. The server
records the scan at the moment it was made on the device (reconstructed from
elapsed time when the clock was unset), not the moment it arrived. A retry of
an event the server already stored answers `saved`, never a second row.

## What happens when the dashboard lets a device go

The next heartbeat (≤ 60 s) or send answers `401 UNPAIRED`: the device drops
its key, shows `RELEASED`, signs the operator out and goes back to `SCAN QR`.
Queued scans are kept; pairing again to the SAME stage sends them, pairing to
another stage drops them loudly on screen.

## Tuning

| Constant | Default | Notes |
|---|---|---|
| `MAX_STORED_SCANS` | 300 | ~37KB of static RAM |
| `MAX_EVENTS_PER_POST` | 25 | a backlog drains 25 per request |
| `QUEUE_RETRY_INTERVAL` | 30 s | retry while the queue is non-empty |
| `HEARTBEAT_INTERVAL` | 60 s | the dashboard calls a device offline after 3 minutes without one |
| `SCAN_DEBOUNCE_MS` | 1200 | a hand scanner's double trigger, not a sewing machine's pace |
