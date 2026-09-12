# Scanner firmware — source and releases

The ESP32 barcode scanners on the production floor. This folder is the **source
of truth for the firmware itself**; it is not the OTA store.

| | |
|---|---|
| `GRAV_Scanner_v5_5_0/` | the Arduino sketch (`.ino` + `sketch.yaml`) |
| `platformio.ini` | PlatformIO build config for the same sketch |
| `GRAV_Scanner_v5_*.bin` | historical builds, kept for rollback |
| `release/<version>/` | a tagged build: `bin/`, `source/`, `SHA256.txt`, `BUILD-INFO.txt` |
| `FIRMWARE-README.md` | flashing instructions, partition scheme, what each version changed |
| `BARCODE-SERVER-README.md` | the standalone barcode server's own README, kept as the record of what it was before the merge |

## This is NOT where the devices download from

`../firmware/` is the OTA store. The upload form on
**Production Supervisor → Firmware / OTA** posts to
`POST /api/barcode-devices/firmware`, which writes
`../firmware/firmware_v<version>.bin` and inserts a `Firmware` record; devices
fetch `GET /api/barcode-devices/firmware/download/:version` from there.

Two consequences worth knowing:

- Dropping a `.bin` into this folder does nothing. A device is only ever offered
  a build that went through the upload form.
- A `Firmware` record and its `.bin` live in different places — the record in
  MongoDB, which every server shares, and the file on one server's disk. Upload
  to the wrong server and you get a record that looks perfect and a download
  that 404s at the machine, which the scanner shows as *Update Failed / HTTP
  404*. The **check** button next to each build on the Firmware page asks the
  download endpoint directly and tells the two apart.

## History

Until 11 Sep 2026 these files lived in a fourth repo, `barcode/`, alongside a
standalone Express server that ran on the factory PC on port 5001 and served its
own static supervisor dashboards. That server has been merged into this backend:

| what it was | where it is now |
|---|---|
| scan ingest / heartbeat | `routes/Barcode_Scan_Punchings/scannerIngestRoutes.js` |
| rollup job, shift bucketing, master-data cache, mDNS | `services/barcodeScanner/` |
| supervisor read endpoints, QR, health | `routes/CMS_Routes/Production/Scanner/` |
| `production_events`, day stats, heartbeats | `models/CMS_Models/Manufacturing/Production/Barcode/` |
| the six static dashboards | `grav-clothing/app/production-supervisor/dashboard/` |

The devices were not reflashed for the merge. Every scanner still stores
`<host>:5001`, and firmware 5.6+ actively rewrites a stored port of `5000` back
to `5001` on boot, so `server.js` opens a second listener on `SCANNER_COMPAT_PORT`
(default 5001) serving the same app. Set `SCANNER_COMPAT_PORT=0` once every
device has been re-pointed with a fresh `SRV:` card.
