# GRAV Scanner Firmware v5.5.0

Local-first event sourcing. Every v5.4.0 behaviour is preserved — this release
changes **where scans go and when**, not how the device behaves at the machine.

## Before you flash

### 1. Partition scheme — required

v5.5.0 stores the offline queue on **LittleFS**. In Arduino IDE:

> Tools → Partition Scheme → **Default 4MB with spiffs (1.2MB APP / 1.5MB SPIFFS)**

That scheme keeps `ota_0` / `ota_1`, so OTA still works.

Why the change: v5.4.0 wrote **7 NVS keys per queued scan** for up to 200 scans.
The default NVS partition is 20KB and cannot hold that — it was silently
over-committed, and the ring buffer dropped the oldest scan with no warning.

### 2. Set the server IP

`DEFAULT_SERVER_HOST` at the top of the sketch is `192.168.1.50`. Change it to
your factory PC's **DHCP-reserved** LAN IP before the first flash, or set it per
device afterwards via the setup page or a `SRV:` barcode.

Never `localhost` — to an ESP32 that means the ESP32 itself.

### 3. Flash when queues are empty

The queue format changed. A device upgraded mid-shift with events still queued
loses them: v5.4.0 wrote to NVS, v5.5.0 reads LittleFS. **Flash at end of shift**,
or scan each machine's operator out first and confirm the tick in the header.

## Config barcodes

| Barcode | Effect |
|---|---|
| `SRV:192.168.1.50:5000` | **New in v5.5.0.** Point the device at a production server. Port optional. |
| `MID:<id>,MNAME:<name>` | Machine id + name |
| `SSID:<net>,PASSWORD:<pw>` | WiFi credentials |
| `INFO_ADMIN_2790` | Info screen (10s) |
| `ADMIN-CONFIG-94731` | Wipe everything, enter setup |
| `BREAK_WASHROOM` / `BREAK_BREAKDOWN` / `BREAK_OTHER` | Break start/end |
| `ops:<CODE>` / `opsgp:<A,B,C>` | Toggle operations |

## Reading the screen

The header now carries a send indicator between the machine name and the WiFi icon:

| Indicator | Meaning |
|---|---|
| Green tick | Everything the device recorded is confirmed in the database |
| Yellow number | That many events queued, not yet acknowledged |
| Red number | Last send failed, or the queue has overflowed |

On the operator screen:

- `Pending: N` — queued but unconfirmed
- `! QUEUE 240/300 - SERVER?` — past 80%, someone needs to check the PC
- `! DATA LOST - CALL IT !` — the queue overflowed and the oldest events were
  dropped. This is the one v5.4.0 did silently.

## Tuning

| Constant | Default | Notes |
|---|---|---|
| `MAX_STORED_SCANS` | 300 | ~100 min of one machine's output. Costs ~37KB of **static** RAM (7 Strings per entry). Lower it if you hit allocation failures. |
| `MAX_EVENTS_PER_POST` | 25 | Caps payload size. A backlog drains 25 per request, back to back. |
| `QUEUE_RETRY_INTERVAL` | 30s | Retry cadence while the queue is non-empty. Not the normal send path — every scan sends immediately. |
| `HEARTBEAT_INTERVAL` | 60s | Must stay below the server's `HEARTBEAT_STALE_SEC` (180s). |

## What still needs the internet

Ops sync still runs through Firebase RTDB, unchanged — that logic took six
debugged cases to get right in v5.4.0 and was deliberately left alone. OTA
update checks also still hit the cloud.

Consequence: with the internet down, scanning, queueing, sending and heartbeats
all keep working on the LAN, but CMS-driven operation changes stop reaching
devices until it returns. Operators can still toggle operations locally with
`ops:` barcodes, and those changes win on reconnect (v5.4.0 CASE 4/6).
