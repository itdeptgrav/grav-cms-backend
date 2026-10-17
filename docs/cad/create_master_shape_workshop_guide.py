from pathlib import Path
from io import BytesIO
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth

ROOT = Path(__file__).resolve().parents[2]
MASTER = ROOT / "docs" / "cad" / "assets" / "fabric_meter_master_side_qc.png"
OUT = ROOT / "output" / "pdf" / "Fabric_Roll_Meter_Master_Visual_Workshop_Guide_RevC.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = landscape(A4)
NAVY = HexColor("#153B66")
BLUE = HexColor("#0875C1")
PALE = HexColor("#EAF3FB")
LIGHT = HexColor("#F4F7FA")
INK = HexColor("#1E2B36")
MID = HexColor("#607181")
ORANGE = HexColor("#EF741B")
GREEN = HexColor("#25845D")
RED = HexColor("#D6403D")
YELLOW = HexColor("#FFF3CC")
BORDER = HexColor("#B6C6D4")

c = canvas.Canvas(str(OUT), pagesize=(W, H), pageCompression=1)
c.setTitle("Fabric Roll Meter - Master Visual Workshop Guide - Revision C")
c.setAuthor("Concept design for engineering completion")


def header(page, title_text, subtitle=""):
    c.setFillColor(NAVY)
    c.rect(0, H - 55, W, 55, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(24, H - 34, title_text)
    if subtitle:
        c.setFont("Helvetica", 8.3)
        c.drawRightString(W - 22, H - 33, subtitle)
    c.setStrokeColor(BORDER)
    c.line(22, 22, W - 22, 22)
    c.setFillColor(MID)
    c.setFont("Helvetica", 6.8)
    c.drawString(22, 12, "FABRIC ROLL METER + SINGLE-CAMERA QC | MASTER SHAPE GUIDE | REV C | 2026-10-16")
    c.drawRightString(W - 22, 12, f"PAGE {page} OF 8")


def title(text, x, y, size=14, color=NAVY):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", size)
    c.drawString(x, y, text)


def panel(x, y, w, h, fill=LIGHT, stroke=BORDER, radius=7):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.75)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def wrap(text, x, y, width, size=8.5, leading=11, color=INK, font="Helvetica"):
    words = text.split()
    lines, line = [], ""
    for word in words:
        candidate = word if not line else line + " " + word
        if stringWidth(candidate, font, size) <= width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    c.setFillColor(color)
    c.setFont(font, size)
    yy = y
    for row in lines:
        c.drawString(x, yy, row)
        yy -= leading
    return yy


def bullet(text, x, y, width, color=BLUE, size=8.2):
    c.setFillColor(color)
    c.circle(x + 4, y + 3, 3, fill=1, stroke=0)
    return wrap(text, x + 15, y + 7, width - 15, size, size + 3)


def badge(label, x, y, color=BLUE, r=11):
    c.setFillColor(color)
    c.circle(x, y, r, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(x, y - 3, str(label))


def arrow(x1, y1, x2, y2, color=ORANGE, width=4):
    import math
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    ang = math.atan2(y2 - y1, x2 - x1)
    a = 10
    pts = [
        (x2, y2),
        (x2 - a * math.cos(ang - .45), y2 - a * math.sin(ang - .45)),
        (x2 - a * math.cos(ang + .45), y2 - a * math.sin(ang + .45)),
    ]
    p = c.beginPath(); p.moveTo(*pts[0]); p.lineTo(*pts[1]); p.lineTo(*pts[2]); p.close()
    c.drawPath(p, fill=1, stroke=0)


def image_contain(path, x, y, w, h, crop=None):
    im = Image.open(path).convert("RGB")
    if crop:
        im = im.crop(crop)
    iw, ih = im.size
    scale = min(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    dx, dy = x + (w - dw) / 2, y + (h - dh) / 2
    bio = BytesIO(); im.save(bio, format="JPEG", quality=94); bio.seek(0)
    c.drawImage(ImageReader(bio), dx, dy, dw, dh, preserveAspectRatio=True)
    return dx, dy, dw, dh


def note(x, y, w):
    c.setFillColor(MID); c.setFont("Helvetica-Oblique", 6.2)
    c.drawRightString(x + w, y, "Approved master shape. Dimensions remain provisional until engineering release.")


# PAGE 1 - locked master
header(1, "APPROVED MASTER SHAPE", "Use this same machine geometry on every following page")
title("Fabric roll measuring, rewinding and camera-QC machine", 28, H - 82, 17)
wrap("This side-profile arrangement is the fixed design reference. The roll positions, measuring nip, inspection deck, QC enclosure and take-up position must not move between drawings.", 28, H - 102, W - 56, 10, 13)
panel(24, 104, W - 48, 348, white)
image_contain(MASTER, 30, 111, W - 60, 330)
note(30, 103, W - 60)
panel(24, 34, W - 48, 58, PALE)
facts = [("1470 mm", "fabric width"), ("40 kg", "maximum roll"), ("5000 m / 8 h", "production target"), ("< 1%", "length-error target"), ("1 camera", "enclosed uniform-light QC")]
cell = (W - 68) / 5
for i, (big, small) in enumerate(facts):
    x = 34 + i * cell
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 12.5); c.drawCentredString(x + cell / 2, 66, big)
    c.setFillColor(MID); c.setFont("Helvetica", 7.2); c.drawCentredString(x + cell / 2, 48, small)
c.showPage()


# PAGE 2 - path
header(2, "FABRIC PATH - SAME MASTER MACHINE", "Supply roll -> measuring nip -> enclosed inspection -> take-up roll")
panel(22, 158, W - 44, 347, white)
dx, dy, dw, dh = image_contain(MASTER, 28, 166, W - 56, 330)
badge(1, dx + dw * .17, dy + dh * .67)
badge(2, dx + dw * .49, dy + dh * .53)
badge(3, dx + dw * .69, dy + dh * .62, GREEN)
badge(4, dx + dw * .95, dy + dh * .48)
arrow(dx + dw * .27, dy + dh * .52, dx + dw * .45, dy + dh * .44)
arrow(dx + dw * .54, dy + dh * .44, dx + dw * .70, dy + dh * .44)
arrow(dx + dw * .76, dy + dh * .44, dx + dw * .92, dy + dh * .47)
note(28, 156, W - 56)
items = [
    (1, "SUPPLY ROLL", "Light brake tension only."),
    (2, "MEASURING NIP", "Length is counted here."),
    (3, "QC ENCLOSURE", "One camera views flat, evenly lit fabric."),
    (4, "TAKE-UP ROLL", "Motor rewinds onto a new tube."),
]
cw = (W - 52) / 4
for i, (n, head, body) in enumerate(items):
    x = 25 + i * cw
    panel(x, 38, cw - 9, 96, PALE)
    badge(n, x + 19, 110, GREEN if n == 3 else BLUE, 10)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(x + 37, 107, head)
    wrap(body, x + 12, 87, cw - 26, 7.8, 10)
c.showPage()


# PAGE 3 - QC enclosure close-up from same master
header(3, "QC ENCLOSURE - ONE CAMERA", "Controlled light is required for reliable colour comparison")
panel(22, 176, 514, 329, white)
dx, dy, dw, dh = image_contain(MASTER, 28, 183, 502, 312, crop=(760, 80, 1650, 720))
for n, px, py in [(1,.60,.54),(2,.60,.70),(3,.50,.31),(4,.31,.50),(5,.88,.50)]:
    badge(n, dx + dw*px, dy + dh*py, GREEN, 10)
note(28, 174, 502)
panel(550, 176, W - 572, 329, PALE)
title("Inside the box", 566, 477, 13)
details = [
    (1, "One central camera", "Height-adjustable and square to the fabric."),
    (2, "Diffuse light canopy", "Full-width, high-CRI white light surrounding the camera."),
    (3, "Neutral backing surface", "Flat, removable and non-reflective."),
    (4, "Entrance light baffle", "Blocks changing room light from entering."),
    (5, "Exit light baffle", "Same function at the take-up side."),
]
yy = 444
for n, head, body in details:
    badge(n, 570, yy + 2, GREEN, 8)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(586, yy + 4, head)
    yy = wrap(body, 586, yy - 8, W - 610, 7.3, 9) - 11
panel(22, 34, W - 44, 122, YELLOW, HexColor("#DEC35B"))
title("Lighting specification for colour QC", 38, 132, 12, HexColor("#6E5300"))
specs = [
    "High-CRI LEDs: CRI 95 or better; fixed 5000-5500 K colour temperature.",
    "Flicker-free constant-current driver; fixed camera exposure, gain and white balance.",
    "Target illumination uniformity within +/-5% across the complete camera field.",
    "Use white and neutral-grey calibration references; apply camera flat-field correction.",
]
for i, text in enumerate(specs):
    x = 40 + (i % 2) * 390; y = 105 - (i // 2) * 39
    bullet(text, x, y, 360, HexColor("#A77B00"), 7.8)
c.showPage()


# PAGE 4 - key dimensions over same master
header(4, "PROVISIONAL SIZE AND POSITIONING", "Engineer must freeze dimensions after confirming roll and floor limits")
panel(22, 214, W - 44, 291, white)
dx, dy, dw, dh = image_contain(MASTER, 28, 222, W - 56, 272)
# dimension baselines and arrows
arrow(dx + dw*.08, dy + 10, dx + dw*.94, dy + 10, RED, 2)
c.setFillColor(RED); c.setFont("Helvetica-Bold", 8); c.drawCentredString(dx + dw*.51, dy + 17, "DEPTH ALONG FABRIC PATH: 900-1000 mm PROVISIONAL")
c.setStrokeColor(RED); c.setLineWidth(1.4); c.line(dx+12,dy+5,dx+12,dy+dh*.80)
c.setFillColor(RED); c.setFont("Helvetica-Bold", 8); c.saveState(); c.translate(dx+20,dy+dh*.45); c.rotate(90); c.drawCentredString(0,0,"HEIGHT TO OPEN LID: 1050-1200 mm PROVISIONAL"); c.restoreState()
note(28, 212, W - 56)
title("Dimensions the engineer must confirm", 24, 188, 14)
rows = [
    ("Across-fabric machine width", "1750 mm provisional", "Allows 1470 mm fabric plus bearings and guards"),
    ("Maximum roll outside diameter", "350 mm assumed", "Controls shaft-centre heights and clearance"),
    ("Core bore", "76 mm assumed", "Controls removable core cones"),
    ("Flat inspection length", "500 mm provisional", "Inside the QC enclosure"),
    ("QC box inside height", "450-550 mm provisional", "Depends on final camera and lens"),
    ("Roll centre alignment", "Within 0.5 mm", "All axes parallel across full width"),
]
panel(22, 34, W - 44, 135, LIGHT)
for i, (name, value, why) in enumerate(rows):
    col, row = i % 3, i // 3
    x = 38 + col * 266; y = 137 - row * 57
    c.setFillColor(MID); c.setFont("Helvetica", 7.2); c.drawString(x, y, name)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 9.5); c.drawString(x, y - 15, value)
    wrap(why, x, y - 29, 240, 7, 9)
c.showPage()


# PAGE 5 - fabrication and purchased items
header(5, "WHAT TO MAKE AND WHAT TO BUY", "Component placement follows the approved master shape")
panel(22, 304, 394, 201, white)
image_contain(MASTER, 28, 312, 382, 184)
note(28, 302, 382)
panel(430, 304, W - 452, 201, PALE)
title("Fabricated by the welder", 446, 477, 13)
made = [
    "Base frame and six support posts",
    "Slotted bearing plates",
    "Flat QC inspection deck",
    "Blue sheet-metal QC enclosure and hinged lid",
    "Entrance and exit light baffles",
    "Removable guards for all couplings and pinch points",
]
yy = 448
for item in made:
    yy = bullet(item, 446, yy, W - 476, BLUE, 7.7) - 5
title("Purchased components", 24, 278, 14)
panel(22, 34, W - 44, 228, white)
items = [
    ("Roll supports", "6 pillow-block bearings, shafts and adjustable core cones"),
    ("Measuring pair", "100 mm measuring roller + 80 mm rubber spring-pressure roller"),
    ("Length sensing", "1024 PPR or higher encoder, flexible coupling and metre counter"),
    ("Take-up drive", "Approx. 0.55 kW gearmotor, VFD, torque limiter and guards"),
    ("QC camera", "Exactly one colour camera; line-scan preferred for continuous fabric"),
    ("QC lighting", "Full-width high-CRI diffuse canopy and flicker-free driver"),
    ("Controls", "Main isolator, protection, emergency stop and hold-to-run pedal"),
    ("Vision computer", "Receives encoder position, camera images and defect outputs"),
]
for i, (head, body) in enumerate(items):
    col, row = i % 2, i // 2
    x = 40 + col * 395; y = 227 - row * 45
    badge(i + 1, x + 10, y + 3, BLUE, 8)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(x + 26, y + 6, head)
    wrap(body, x + 26, y - 6, 350, 7.2, 9)
c.showPage()


# PAGE 6 - build order, same image used as visual anchor
header(6, "BUILD SEQUENCE", "Keep the machine tacked and adjustable until fabric tests pass")
panel(22, 341, W - 44, 164, white)
image_contain(MASTER, 28, 348, W - 56, 149)
note(28, 339, W - 56)
steps = [
    ("1", "Tack the base", "Check floor footprint and both diagonals."),
    ("2", "Fit roll supports", "Use slotted bearing plates; do not final-weld positions."),
    ("3", "Install measuring nip", "Set equal spring pressure left and right."),
    ("4", "Fit QC deck", "Keep it flat, removable and level with the fabric path."),
    ("5", "Build the enclosure", "Hinged lid, light baffles and service access."),
    ("6", "Install one camera", "Mount centrally with height and focus adjustment."),
    ("7", "Fit drive and encoder", "Align couplings before installing guards."),
    ("8", "Wire and test", "Start slowly with scrap fabric before final welding."),
]
cw, ch = 193, 110
for i, (n, head, body) in enumerate(steps):
    col, row = i % 4, i // 4
    x = 22 + col * 204; y = 205 - row * 126
    panel(x, y, cw, ch, PALE if n in ("4", "5", "6") else white)
    badge(n, x + 22, y + ch - 24, GREEN if n in ("4", "5", "6") else BLUE, 11)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.7); c.drawString(x + 40, y + ch - 27, head)
    wrap(body, x + 14, y + ch - 51, cw - 28, 7.5, 10)
c.showPage()


# PAGE 7 - controls and data
header(7, "CONTROL AND AI CONNECTION", "Length measurement remains independent of GSM and roll diameter")
title("Mechanical and electrical flow", 24, H - 82, 14)
blocks = [
    ("MEASURING\nROLLER", BLUE), ("ENCODER\nPOSITION", BLUE), ("ONE CAMERA +\nDIFFUSE LIGHT", GREEN), ("AI VISION\nCOMPUTER", NAVY), ("ALARM / MARK /\nSTOP", RED)
]
bx, by, bw, bh, gap = 28, 388, 134, 72, 32
for i, (label, color) in enumerate(blocks):
    x = bx + i * (bw + gap)
    panel(x, by, bw, bh, white, color, 5)
    c.setFillColor(color); c.setFont("Helvetica-Bold", 8.8)
    for j, part in enumerate(label.split("\n")):
        c.drawCentredString(x + bw/2, by + 43 - j*14, part)
    if i < len(blocks) - 1:
        arrow(x + bw + 4, by + bh/2, x + bw + gap - 5, by + bh/2, color, 2)
panel(22, 205, 388, 145, PALE)
title("Length counter", 38, 324, 12)
counter = [
    "Measure length from the 100 mm roller only.",
    "1024 pulses/rev gives a nominal 0.3068 mm/pulse.",
    "Calibrate using repeated measured 20 m samples.",
    "Do not derive metres from take-up diameter or roll weight.",
]
yy = 296
for item in counter:
    yy = bullet(item, 38, yy, 350, BLUE, 7.8) - 4
panel(426, 205, W - 448, 145, PALE)
title("Camera capture", 442, 324, 12)
camera = [
    "Encoder supplies position/trigger information.",
    "Lock exposure, gain, colour temperature and white balance.",
    "Store defect position in metres from roll start.",
    "Provide operator alarm, marker output or controlled stop.",
]
yy = 296
for item in camera:
    yy = bullet(item, 442, yy, W - 480, GREEN, 7.8) - 4
panel(22, 34, W - 44, 148, LIGHT)
title("Drive and safety", 38, 157, 12)
drive = [
    ("Speed", "12-15 m/min normal; 20 m/min provisional maximum"),
    ("Throughput", "5000 m / 8 h needs at least 10.42 m/min average"),
    ("Drive", "VFD controls speed; torque limiter controls fabric tension"),
    ("Stopping", "Emergency stop and hold-to-run pedal must remove drive torque"),
    ("Guards", "Cover every coupling, shaft end and reachable pinch point"),
]
for i, (head, body) in enumerate(drive):
    x = 40 + (i % 3) * 260; y = 128 - (i // 3) * 50
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8); c.drawString(x, y, head)
    wrap(body, x, y - 14, 235, 7.2, 9)
c.showPage()


# PAGE 8 - release checklist
header(8, "BEFORE THE ENGINEER RELEASES FABRICATION", "Fill the open values and complete the acceptance tests")
title("Open values", 24, H - 82, 14)
panel(22, 279, 393, 227, white)
open_rows = [
    ("Maximum roll OD", "350 mm assumed"),
    ("Core bore range", "76 mm assumed"),
    ("Available floor depth", "NOT CONFIRMED"),
    ("Maximum allowed height", "NOT CONFIRMED"),
    ("Smallest defect to detect", "NOT CONFIRMED"),
    ("Fabric colours and textures", "NOT CONFIRMED"),
    ("Required colour difference limit", "NOT CONFIRMED"),
]
for i, (name, value) in enumerate(open_rows):
    y = 475 - i * 28
    c.setFillColor(INK); c.setFont("Helvetica", 7.8); c.drawString(38, y, name)
    c.setFillColor(RED if "NOT" in value else NAVY); c.setFont("Helvetica-Bold", 7.8); c.drawString(246, y, value)
    c.setStrokeColor(HexColor("#D5DFE7")); c.line(36, y - 8, 400, y - 8)
title("Acceptance tests", 432, H - 82, 14)
panel(430, 279, W - 452, 227, PALE)
tests = [
    "Three independent 20 m measurements; each error below 1%.",
    "Repeat at 5, 12 and 20 m/min; no speed-dependent error.",
    "No fabric slip, stretch, marking or edge drift.",
    "Illumination map shows no more than +/-5% variation.",
    "Camera sees the required defect at production speed.",
    "White/grey reference readings stay stable after warm-up.",
    "Emergency stop, pedal and guards pass safety review.",
]
yy = 475
for text in tests:
    c.setStrokeColor(BLUE); c.rect(448, yy - 3, 10, 10, fill=0, stroke=1)
    yy = wrap(text, 468, yy + 4, W - 496, 7.7, 10) - 13
title("Required engineering handover", 24, 252, 14)
panel(22, 34, W - 44, 201, LIGHT)
handover = [
    ("A", "Final arrangement", "Confirmed roll centres, envelope and threading clearance."),
    ("B", "Frame drawing", "Cut lengths, welds, slots and tolerances."),
    ("C", "Shaft drawings", "Material, diameters, shoulders, threads and keyways."),
    ("D", "QC enclosure drawing", "Hinges, baffles, diffuser, camera mount and access."),
    ("E", "Purchased parts", "Bearings, drive, encoder, camera, lens, LEDs and controls."),
    ("F", "Electrical + safety", "Protection, E-stop, VFD, I/O, guards and risk review."),
]
for i, (letter, head, body) in enumerate(handover):
    col, row = i % 3, i // 3
    x = 42 + col * 262; y = 184 - row * 76
    badge(letter, x + 10, y + 3, NAVY, 11)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(x + 29, y + 7, head)
    wrap(body, x + 29, y - 7, 210, 7.2, 9)

c.save()
print(OUT)
