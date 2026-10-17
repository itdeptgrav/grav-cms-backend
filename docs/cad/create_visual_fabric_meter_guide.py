from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / "docs" / "cad" / "assets"
OUT = ROOT / "output" / "pdf" / "Fabric_Roll_Meter_Visual_Workshop_Guide_RevB.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

FULL = ASSET / "fabric_meter_qc_full_render.png"
EXPLODED = ASSET / "fabric_meter_exploded_render.png"
THREAD = ASSET / "fabric_meter_qc_threading_render.png"

W, H = landscape(A4)
NAVY = HexColor("#153B66")
BLUE = HexColor("#0C70BD")
PALE = HexColor("#EAF3FB")
LIGHT = HexColor("#F3F6F9")
INK = HexColor("#1F2A35")
MID = HexColor("#5F7080")
ORANGE = HexColor("#EA741B")
GREEN = HexColor("#23835A")
RED = HexColor("#D5413F")
YELLOW = HexColor("#FFF3CD")

c = canvas.Canvas(str(OUT), pagesize=(W, H), pageCompression=1)
c.setTitle("Fabric Roll Meter - Visual Workshop Guide - Revision B")
c.setAuthor("Concept guide for engineering review")


def header(page, title, subtitle=""):
    c.setFillColor(NAVY)
    c.rect(0, H - 54, W, 54, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(24, H - 32, title)
    if subtitle:
        c.setFont("Helvetica", 8.5)
        c.drawRightString(W - 22, H - 31, subtitle)
    c.setFillColor(MID)
    c.setFont("Helvetica", 7)
    c.drawString(22, 13, "FABRIC ROLL METER WITH CAMERA QC | VISUAL WORKSHOP GUIDE | REV B | 2026-10-16")
    c.drawRightString(W - 22, 13, f"PAGE {page} OF 8")
    c.setStrokeColor(HexColor("#B8C4CF"))
    c.line(22, 22, W - 22, 22)


def title(text, x, y, size=15, color=NAVY):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", size)
    c.drawString(x, y, text)


def wrap(text, x, y, width, size=9, leading=12, color=INK, font="Helvetica"):
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
    c.setFont(font, size)
    c.setFillColor(color)
    yy = y
    for item in lines:
        c.drawString(x, yy, item)
        yy -= leading
    return yy


def panel(x, y, w, h, fill=LIGHT, stroke=HexColor("#B7C6D4"), radius=7):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.7)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def image_contain(path, x, y, w, h):
    im = Image.open(path)
    iw, ih = im.size
    scale = min(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    dx, dy = x + (w - dw) / 2, y + (h - dh) / 2
    c.drawImage(ImageReader(im), dx, dy, dw, dh, preserveAspectRatio=True, mask="auto")
    return dx, dy, dw, dh


def badge(n, x, y, color=BLUE, r=12):
    c.setFillColor(color)
    c.circle(x, y, r, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(x, y - 3.3, str(n))


def arrow(x1, y1, x2, y2, color=ORANGE, width=4):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    a = 11
    pts = [
        (x2, y2),
        (x2 - a * math.cos(ang - 0.45), y2 - a * math.sin(ang - 0.45)),
        (x2 - a * math.cos(ang + 0.45), y2 - a * math.sin(ang + 0.45)),
    ]
    p = c.beginPath()
    p.moveTo(*pts[0]); p.lineTo(*pts[1]); p.lineTo(*pts[2]); p.close()
    c.drawPath(p, fill=1, stroke=0)


def bullet(text, x, y, width, color=BLUE, size=8.5):
    c.setFillColor(color)
    c.circle(x + 4, y + 3, 3, fill=1, stroke=0)
    return wrap(text, x + 14, y + 7, width - 14, size=size, leading=size + 3)


def image_note(x, y, w):
    c.setFillColor(HexColor("#6F7D89"))
    c.setFont("Helvetica-Oblique", 6.5)
    c.drawRightString(x + w, y, "AI-generated visual reference. Final construction must follow verified dimensions and selected components.")


# PAGE 1
header(1, "FABRIC ROLL METER + CAMERA QC", "VISUAL GUIDE FOR WELDER + EMBEDDED/SOFTWARE TEAM")
title("What you are building", 28, H - 80, 18)
wrap("A compact machine that measures fabric length, rewinds it onto another tube, and gives one camera a stable, evenly lit area for automatic quality inspection.", 28, H - 98, W - 56, 10.5, 14)
panel(24, 105, W - 48, 365, white)
dx, dy, dw, dh = image_contain(FULL, 30, 112, W - 60, 348)
image_note(30, 103, W - 60)
panel(24, 34, W - 48, 60, PALE)
facts = [
    ("1470 mm", "fabric width"),
    ("40 kg", "maximum roll mass"),
    ("5000 m / 8 h", "production target"),
    ("< 1%", "length error target"),
    ("1 camera", "central adjustable QC mount"),
]
fw = (W - 68) / len(facts)
for i, (big, small) in enumerate(facts):
    x = 34 + i * fw
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 13); c.drawCentredString(x + fw / 2, 67, big)
    c.setFillColor(MID); c.setFont("Helvetica", 7.5); c.drawCentredString(x + fw / 2, 49, small)
c.showPage()


# PAGE 2
header(2, "HOW THE FABRIC MOVES", "Follow this order when threading the machine")
panel(22, 153, W - 44, 355, white)
dx, dy, dw, dh = image_contain(THREAD, 28, 160, W - 56, 340)
# Orange arrows over the three stages.
arrow(dx + dw * 0.23, dy + dh * 0.56, dx + dw * 0.39, dy + dh * 0.47)
arrow(dx + dw * 0.48, dy + dh * 0.45, dx + dw * 0.66, dy + dh * 0.45)
arrow(dx + dw * 0.73, dy + dh * 0.44, dx + dw * 0.87, dy + dh * 0.50)
for n, px, py in [(1, .12, .77), (2, .41, .64), (3, .64, .69), (4, .91, .62)]:
    badge(n, dx + dw * px, dy + dh * py)
image_note(28, 151, W - 56)
title("Threading order", 26, 132, 14)
steps = [
    ("1", "SUPPLY ROLL", "Fabric unwinds with light brake tension."),
    ("2", "MEASURING NIP", "Fabric is pressed against the measuring roller. This is where length is counted."),
    ("3", "CAMERA QC ZONE", "Fabric lies flat over the dark backing plate while one camera inspects it."),
    ("4", "TAKE-UP ROLL", "The motor rewinds the inspected fabric onto a new tube."),
]
sw = (W - 52) / 4
for i, (n, head, body) in enumerate(steps):
    x = 25 + i * sw
    panel(x, 36, sw - 8, 84, PALE)
    badge(n, x + 18, 98, BLUE, 10)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(x + 34, 95, head)
    wrap(body, x + 12, 78, sw - 30, 7.5, 10)
c.showPage()


# PAGE 3
header(3, "THE MAIN PARTS", "Use this page while buying and arranging components")
panel(22, 222, W - 44, 285, white)
dx, dy, dw, dh = image_contain(EXPLODED, 28, 228, W - 56, 270)
positions = [(1,.20,.82),(2,.49,.60),(3,.49,.48),(4,.50,.22),(5,.10,.40),(6,.89,.22),(7,.83,.53),(8,.91,.50),(9,.76,.54)]
for n, px, py in positions:
    badge(n, dx + dw*px, dy + dh*py, BLUE, 10)
image_note(28, 220, W - 56)
items = [
    (1, "Supply shaft", "30 mm steel shaft, two bearings, two adjustable core cones."),
    (2, "Pressure roller", "80 mm rubber roller with a spring adjuster at both ends."),
    (3, "Measuring roller", "100 mm ground roller, low runout, encoder on one end."),
    (4, "Take-up shaft", "30 mm shaft, core cones and positive drive connection."),
    (5, "Frame", "50 x 50 x 3 mm square steel tube; slotted bearing plates."),
    (6, "Gearmotor", "Approx. 0.55 kW, final ratio selected after torque test."),
    (7, "Metre counter", "Displays total length and accepts encoder A/B pulses."),
    (8, "VFD + E-stop", "Variable speed, hold-to-run input and emergency stop."),
    (9, "Encoder", "1024 PPR or higher, flexible coupling, shielded cable."),
]
cols = 3; cw = (W - 56) / cols
for idx, (n, head, body) in enumerate(items):
    col, row = idx % cols, idx // cols
    x = 26 + col*cw; y = 190 - row*55
    badge(n, x + 9, y + 10, BLUE, 9)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(x + 24, y + 13, head)
    wrap(body, x + 24, y, cw - 35, 7.2, 9)
c.showPage()


# PAGE 4
header(4, "WHAT THE WELDER BUILDS", "Start with the frame; keep all roller mounts adjustable")
title("Provisional finished envelope", 24, H - 82, 14)
panel(22, 318, 360, 188, white)
image_contain(FULL, 30, 326, 344, 170)
image_note(30, 318, 344)
panel(396, 318, W - 418, 188, PALE)
title("Overall size to plan for", 414, 478, 13)
for big, small, yy in [
    ("1750 mm", "width across 1470 mm fabric", 444),
    ("900-1000 mm", "depth with inspection deck", 408),
    ("1050-1200 mm", "height including camera gantry", 372),
]:
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 15); c.drawString(416, yy, big)
    c.setFillColor(MID); c.setFont("Helvetica", 8); c.drawString(530, yy + 2, small)
c.setFillColor(RED); c.setFont("Helvetica-Bold", 8); c.drawString(416, 340, "PROVISIONAL - CONFIRM AVAILABLE SPACE AND ROLL DIAMETER")
title("Frame material and cut plan", 24, 292, 14)
panel(22, 34, 492, 244, white)
rows = [
    ("Base long rails", "50 x 50 x 3 SHS", "2", "1750 mm"),
    ("Base cross rails", "50 x 50 x 3 SHS", "3", "900 mm provisional"),
    ("Roll support posts", "50 x 50 x 3 SHS", "6", "Cut after shaft-centre layout"),
    ("Camera gantry posts", "40 x 40 x 3 SHS", "2", "Adjustable / bolted"),
    ("Camera top beam", "40 x 40 slot or SHS", "1", "1650 mm"),
    ("Bearing plates", "8 mm mild steel", "12", "Slots for alignment"),
    ("Inspection plate", "3 mm aluminium/steel", "1", "1550 x 500 mm provisional"),
    ("Levelling feet", "M16", "4", "Purchased item"),
]
cx = [34, 180, 326, 370]
for i, head in enumerate(["ITEM", "MATERIAL", "QTY", "LENGTH / NOTE"]):
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8); c.drawString(cx[i], 255, head)
for r, row in enumerate(rows):
    yy = 232 - r*25
    c.setStrokeColor(HexColor("#D6DEE5")); c.line(30, yy-7, 502, yy-7)
    for i, val in enumerate(row):
        c.setFillColor(INK); c.setFont("Helvetica", 7.3); c.drawString(cx[i], yy, val)
panel(528, 34, W - 550, 244, YELLOW, HexColor("#E2C86A"))
title("Rules that prevent rework", 546, 252, 13, HexColor("#765600"))
rules = [
    "Tack the frame first. Check it is square before final welding.",
    "Use slotted bearing plates. Do not weld bearing positions permanently at the first attempt.",
    "Keep opposing bearing centres level and parallel.",
    "Make the camera gantry removable so the fabric can be threaded and serviced.",
    "Add guards only after shaft, coupling and motor alignment is confirmed.",
]
yy = 222
for rule in rules:
    yy = bullet(rule, 546, yy, W - 578, HexColor("#B17C00"), 8) - 8
c.showPage()


# PAGE 5
header(5, "CAMERA QC STATION", "Mechanical provision for AI inspection - camera model remains provisional")
panel(22, 205, 500, 300, white)
dx, dy, dw, dh = image_contain(FULL, 28, 212, 488, 282)
# Visual QC callouts.
for n, px, py in [(1,.43,.77),(2,.43,.68),(3,.51,.43),(4,.70,.61),(5,.57,.83)]:
    badge(n, dx+dw*px, dy+dh*py, GREEN, 10)
image_note(28, 205, 488)
panel(536, 205, W - 558, 300, PALE)
title("What to provide now", 552, 476, 13)
qc = [
    (1, "Adjustable camera mount", "Slots must allow the single camera to move left-right and up-down."),
    (2, "One downward camera", "Prefer a line-scan camera for continuous web inspection; an area camera can be used for trials."),
    (3, "Dark flat backing plate", "Removable matte surface improves contrast and keeps fabric flat."),
    (4, "Two diffuse LED bars", "Angle the lights to reveal texture without glare."),
    (5, "Covered cable route", "Separate camera/data wiring from the VFD and motor cable."),
]
yy = 445
for n, head, body in qc:
    badge(n, 562, yy+2, GREEN, 8)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold", 8.5); c.drawString(578, yy+3, head)
    yy = wrap(body, 578, yy-8, W-600, 7.2, 9) - 10
title("How inspection connects to the machine", 24, 180, 14)
blocks = [
    ("MEASURING\nENCODER", BLUE),
    ("TRIGGER /\nPOSITION", GREEN),
    ("ONE CAMERA +\nLED LIGHTS", GREEN),
    ("AI INSPECTION\nCOMPUTER", NAVY),
    ("ALARM / MARK /\nSTOP OUTPUT", RED),
]
bx, by, bw, bh, gap = 30, 83, 130, 64, 33
for i, (lab, col) in enumerate(blocks):
    x = bx + i*(bw+gap)
    panel(x, by, bw, bh, white, col, 5)
    c.setFillColor(col); c.setFont("Helvetica-Bold", 9)
    parts = lab.split("\n")
    for j, part in enumerate(parts): c.drawCentredString(x+bw/2, by+39-j*14, part)
    if i < len(blocks)-1: arrow(x+bw+4, by+bh/2, x+bw+gap-5, by+bh/2, col, 2)
panel(24, 33, W-48, 38, YELLOW, HexColor("#E2C86A"), 4)
wrap("Important: the design uses one camera. Its type, resolution, lens, mounting height and lighting cannot be frozen until you specify the smallest defect that must be detected and test real fabric samples at working speed.", 38, 55, W-76, 8.2, 10, HexColor("#6B5200"), "Helvetica-Bold")
c.showPage()


# PAGE 6
header(6, "LENGTH MEASUREMENT + MOTOR CONTROL", "This stays independent of fabric GSM and roll weight")
title("Length measurement", 24, H-82, 14)
panel(22, 302, 390, 204, white)
image_contain(EXPLODED, 30, 310, 374, 186)
badge("A", 286, 413, BLUE, 10); badge("B", 355, 387, GREEN, 10)
panel(426, 302, W-448, 204, PALE)
title("A - measuring roller", 444, 478, 12)
wrap("Use a 100 mm outside-diameter roller with a non-slip surface. The roller must turn only when fabric moves.", 444, 460, W-480, 8.2, 11)
title("B - encoder", 444, 409, 12)
wrap("Couple a 1024 PPR or higher incremental encoder directly to the measuring roller. Do not calculate length from the take-up roll because its diameter changes continuously.", 444, 391, W-480, 8.2, 11)
panel(444, 324, W-480, 48, white, GREEN)
c.setFillColor(GREEN); c.setFont("Helvetica-Bold", 10); c.drawString(458, 350, "Nominal starting value")
c.setFillColor(INK); c.setFont("Helvetica", 8.5); c.drawString(458, 334, "100 mm roller + 1024 pulses/rev = 0.3068 mm/pulse")
title("Simple control wiring", 24, 276, 14)
labels = [
    ("230 V AC", NAVY), ("ISOLATOR +\nPROTECTION", NAVY), ("VFD", BLUE), ("GEARMOTOR", BLUE)
]
bx, by, bw, bh, gap = 30, 184, 130, 58, 39
for i,(lab,col) in enumerate(labels):
    x=bx+i*(bw+gap); panel(x,by,bw,bh,white,col,5)
    c.setFillColor(col); c.setFont("Helvetica-Bold",9)
    for j,p in enumerate(lab.split("\n")): c.drawCentredString(x+bw/2,by+35-j*13,p)
    if i<len(labels)-1: arrow(x+bw+4,by+bh/2,x+bw+gap-5,by+bh/2,BLUE,2)
panel(696, 174, 120, 78, HexColor("#FFF0F0"), RED)
c.setFillColor(RED); c.setFont("Helvetica-Bold", 9); c.drawCentredString(756, 225, "E-STOP")
c.drawCentredString(756, 210, "+ HOLD-TO-RUN")
c.setFont("Helvetica", 7.2); c.drawCentredString(756, 189, "must remove drive torque")
panel(22, 34, W-44, 122, LIGHT)
title("Targets for the selected motor and gearbox", 38, 132, 12)
data=[("Normal web speed","12-15 m/min"),("Minimum average for 5000 m / 8 h","10.42 m/min"),("Maximum design speed","20 m/min provisional"),("Motor","0.55 kW provisional"),("Take-up shaft speed","about 11-84 rpm across roll diameters")]
for i,(k,v) in enumerate(data):
    x=40+(i%3)*260; y=105-(i//3)*40
    c.setFillColor(MID); c.setFont("Helvetica",7.5); c.drawString(x,y,k)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold",10); c.drawString(x,y-15,v)
c.showPage()


# PAGE 7
header(7, "BUILD IT IN THIS ORDER", "Do not start with final welding or permanent guards")
steps = [
    ("1", "TACK THE FRAME", "Tack only. Check diagonals, level and the available floor space."),
    ("2", "FIT BEARING PLATES", "Use slots so each shaft can be aligned and adjusted."),
    ("3", "INSTALL SHAFTS", "Supply, measuring and take-up shafts must rotate freely."),
    ("4", "FIT THE NIP ROLLER", "Add equal spring adjustment at left and right."),
    ("5", "ADD QC DECK", "Fit the flat dark backing plate and removable camera gantry."),
    ("6", "FIT MOTOR + ENCODER", "Align couplings, then add physical guards."),
    ("7", "WIRE CONTROLS", "VFD, E-stop, pedal, counter, lights and camera trigger."),
    ("8", "TEST WITH SCRAP FABRIC", "Run slowly, align fabric, calibrate length and tune camera lighting."),
]
cardw, cardh = 190, 101
for i,(n,head,body) in enumerate(steps):
    col=i%4; row=i//4
    x=23+col*204; y=365-row*126
    panel(x,y,cardw,cardh,white)
    badge(n,x+24,y+cardh-25,BLUE,13)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold",9.5); c.drawString(x+44,y+cardh-28,head)
    wrap(body,x+15,y+cardh-52,cardw-30,8,11)
panel(22, 34, W-44, 177, PALE)
title("Three checks before moving to the next stage", 40, 184, 13)
checks=[
    ("SQUARE", "Frame diagonals match and all feet sit flat."),
    ("PARALLEL", "All roller axes are parallel across the full 1470 mm width."),
    ("FREE", "Every shaft turns without binding; no coupling pushes sideways on a bearing."),
]
for i,(head,body) in enumerate(checks):
    x=42+i*260
    c.setFillColor(GREEN); c.circle(x+23,128,22,fill=1,stroke=0)
    c.setFillColor(white); c.setFont("Helvetica-Bold",16); c.drawCentredString(x+23,122,"OK")
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold",11); c.drawString(x+56,138,head)
    wrap(body,x+56,121,185,8.2,11)
c.showPage()


# PAGE 8
header(8, "BEFORE FINAL FABRICATION", "Fill these blanks, then the engineer can freeze the drawings")
title("Still provisional", 24, H-82, 14)
panel(22, 286, 392, 220, white)
open_items=[
    ("Maximum roll outside diameter", "350 mm assumed"),
    ("Smallest / largest core bore", "76 mm assumed"),
    ("Maximum complete roll width", "1550 mm assumed"),
    ("Available floor depth", "900-1000 mm needed with QC deck"),
    ("Maximum permitted height", "1050-1200 mm needed for camera"),
    ("Smallest defect to detect", "NOT YET KNOWN"),
    ("Fabric colours / texture range", "NOT YET KNOWN"),
]
for i,(item,val) in enumerate(open_items):
    yy=477-i*27
    c.setFillColor(INK); c.setFont("Helvetica",8); c.drawString(38,yy,item)
    c.setFillColor(RED if "NOT" in val else NAVY); c.setFont("Helvetica-Bold",8); c.drawString(246,yy,val)
    c.setStrokeColor(HexColor("#D6DEE5")); c.line(36,yy-8,398,yy-8)
title("Acceptance tests", 432, H-82, 14)
panel(430, 286, W-452, 220, PALE)
tests=[
    "Run three separate measured 20 m samples. Each error must be below 1%.",
    "Repeat at 5, 12 and 20 m/min; error must not change with speed.",
    "Test light and heavy fabric without visible slip, stretch or edge drift.",
    "Verify emergency stop and hold-to-run control remove drive torque.",
    "Record camera images at working speed; confirm the required defect is visible.",
    "Run an extended scrap roll and check motor, bearings and fabric temperature.",
]
yy=474
for test in tests:
    c.setStrokeColor(BLUE); c.rect(448,yy-3,10,10,fill=0,stroke=1)
    yy=wrap(test,468,yy+4,W-494,8,11)-13
title("Minimum handover pack from the engineer", 24, 260, 14)
panel(22, 34, W-44, 210, LIGHT)
deliver=[
    ("A", "Final general arrangement", "Confirmed overall size, roll centres and fabric path."),
    ("B", "Frame fabrication drawing", "Cut lengths, weld sizes, bearing plate slots and tolerances."),
    ("C", "Shaft drawings", "Diameters, shoulders, threads, keyways, cones and material."),
    ("D", "Purchased-parts list", "Bearing, motor, gearbox, VFD, encoder, coupling, camera, lens and lights."),
    ("E", "Electrical drawing", "Protection, E-stop, pedal, VFD, encoder counter and camera I/O."),
    ("F", "Risk assessment + guards", "All nip points, rotating couplings, shafts and electrical hazards."),
]
for i,(letter,head,body) in enumerate(deliver):
    col=i%3; row=i//3
    x=40+col*263; y=182-row*78
    badge(letter,x+12,y+8,NAVY,11)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold",9); c.drawString(x+31,y+13,head)
    wrap(body,x+31,y-2,210,7.5,10)
c.save()
print(OUT)
