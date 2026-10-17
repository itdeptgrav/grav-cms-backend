from pathlib import Path
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT = Path("/Users/risheeray/grav-cms-backend/output/pdf/Fabric_Roll_Meter_Simple_Guide.pdf")
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = landscape(A4)
NAVY = colors.HexColor("#12345B")
BLUE = colors.HexColor("#1677FF")
SKY = colors.HexColor("#EAF3FF")
ORANGE = colors.HexColor("#FF8A34")
GREEN = colors.HexColor("#1E9E62")
LIGHT_GREEN = colors.HexColor("#EAF8F1")
RED = colors.HexColor("#D94747")
LIGHT_RED = colors.HexColor("#FFF0F0")
INK = colors.HexColor("#202A35")
MUTED = colors.HexColor("#64748B")
LINE = colors.HexColor("#D8E0EA")
PAPER = colors.HexColor("#F8FAFD")

c = canvas.Canvas(str(OUT), pagesize=(W, H))
c.setTitle("Fabric Roll Metre Counter - Simple Build and Use Guide")
c.setAuthor("Prepared for non-engineering review")


def rounded(x, y, w, h, fill, stroke=LINE, radius=12, width=1):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(width)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def draw_wrapped(text, x, y, max_width, size=12, color=INK, font="Helvetica", leading=None, max_lines=None):
    leading = leading or size * 1.3
    words = text.split()
    lines, current = [], ""
    for word in words:
        candidate = word if not current else current + " " + word
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while stringWidth(last + "...", font, size) > max_width and last:
            last = last[:-1]
        lines[-1] = last.rstrip() + "..."
    c.setFillColor(color)
    c.setFont(font, size)
    for i, line in enumerate(lines):
        c.drawString(x, y - i * leading, line)
    return y - len(lines) * leading


def page_header(title, subtitle, page):
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 25)
    c.drawString(42, H - 48, title)
    c.setFont("Helvetica", 11)
    c.setFillColor(MUTED)
    c.drawString(42, H - 69, subtitle)
    c.setStrokeColor(LINE)
    c.line(42, H - 82, W - 42, H - 82)


def page_footer(page):
    c.setFont("Helvetica", 9)
    c.setFillColor(MUTED)
    c.drawRightString(W - 42, 24, f"Simple fabric metre guide  |  Page {page}")


def pill(text, x, y, w, fill=SKY, color=NAVY):
    rounded(x, y, w, 34, fill, fill, 17, 0)
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(x + w / 2, y + 11, text)


def number_badge(n, x, y, fill=BLUE):
    c.setFillColor(fill)
    c.circle(x, y, 17, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 13)
    c.drawCentredString(x, y - 5, str(n))


def arrow(x1, y1, x2, y2, color=ORANGE, width=4):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    import math
    a = math.atan2(y2 - y1, x2 - x1)
    s = 12
    p1 = (x2, y2)
    p2 = (x2 - s * math.cos(a - 0.5), y2 - s * math.sin(a - 0.5))
    p3 = (x2 - s * math.cos(a + 0.5), y2 - s * math.sin(a + 0.5))
    path = c.beginPath()
    path.moveTo(*p1)
    path.lineTo(*p2)
    path.lineTo(*p3)
    path.close()
    c.drawPath(path, fill=1, stroke=0)


def machine_diagram(x, y, scale=1.0, labels=True):
    # Frame
    c.setStrokeColor(NAVY)
    c.setLineWidth(5 * scale)
    c.line(x, y, x + 520 * scale, y)
    c.line(x + 20 * scale, y, x + 20 * scale, y + 180 * scale)
    c.line(x + 500 * scale, y, x + 500 * scale, y + 180 * scale)
    # Rolls
    c.setFillColor(colors.HexColor("#F0F1F3"))
    c.setStrokeColor(MUTED)
    c.setLineWidth(2)
    c.circle(x + 120 * scale, y + 120 * scale, 72 * scale, fill=1, stroke=1)
    c.circle(x + 120 * scale, y + 120 * scale, 17 * scale, fill=0, stroke=1)
    c.circle(x + 405 * scale, y + 70 * scale, 48 * scale, fill=1, stroke=1)
    c.circle(x + 405 * scale, y + 70 * scale, 14 * scale, fill=0, stroke=1)
    # Measuring and nip rollers
    c.setFillColor(BLUE)
    c.setStrokeColor(NAVY)
    c.circle(x + 265 * scale, y + 88 * scale, 25 * scale, fill=1, stroke=1)
    c.setFillColor(colors.HexColor("#9CC4FF"))
    c.circle(x + 265 * scale, y + 143 * scale, 20 * scale, fill=1, stroke=1)
    # Fabric path
    arrow(x + 190 * scale, y + 120 * scale, x + 238 * scale, y + 101 * scale, ORANGE, 3)
    arrow(x + 265 * scale, y + 113 * scale, x + 265 * scale, y + 118 * scale, ORANGE, 3)
    arrow(x + 292 * scale, y + 100 * scale, x + 355 * scale, y + 78 * scale, ORANGE, 3)
    # Motor
    rounded(x + 447 * scale, y + 35 * scale, 55 * scale, 55 * scale, LIGHT_RED, RED, 6)
    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", max(7, 10 * scale))
    c.drawCentredString(x + 474 * scale, y + 55 * scale, "MOTOR")
    if labels:
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 10 * scale)
        c.drawCentredString(x + 120 * scale, y + 205 * scale, "FULL ROLL")
        c.drawCentredString(x + 265 * scale, y + 185 * scale, "MEASURES")
        c.drawCentredString(x + 405 * scale, y + 140 * scale, "EMPTY TUBE")


# Page 1: cover and purpose.
page_header("A simple fabric roll metre counter", "A plain-language guide for the owner, welder, operator and electronics person", 1)
c.setFillColor(NAVY)
c.setFont("Helvetica-Bold", 37)
c.drawString(48, 452, "Measure fabric accurately")
c.drawString(48, 410, "while rewinding it")
draw_wrapped("The fabric passes through one measuring roller. An encoder counts the roller turns and displays metres. This avoids estimating length from roll diameter, thickness or GSM.", 50, 365, 350, 15, INK, "Helvetica", 20)
pill("1470 mm fabric", 50, 250, 135)
pill("40 kg roll", 195, 250, 105, LIGHT_GREEN, GREEN)
pill("0-20 m/min", 310, 250, 110, colors.HexColor("#FFF2E9"), ORANGE)
pill("Target: under 1% error", 50, 205, 205, LIGHT_RED, RED)
pill("5000 m per 8-hour shift", 265, 205, 195)
machine_diagram(440, 205, 0.65, True)
rounded(48, 78, 744, 78, colors.white)
c.setFillColor(ORANGE)
c.setFont("Helvetica-Bold", 14)
c.drawString(68, 124, "Important")
draw_wrapped("This is a practical concept guide, not permission to fabricate immediately. Dimensions marked provisional must be checked before shafts and the frame are cut.", 150, 126, 620, 12, INK, "Helvetica", 16)
page_footer(1)
c.showPage()


# Page 2: core principle.
page_header("The one idea that makes it accurate", "Length comes from the measuring roller - not from the size or weight of the roll", 2)
machine_diagram(120, 245, 1.08, True)
rounded(55, 105, 350, 105, SKY, colors.HexColor("#B9D7FF"))
c.setFillColor(BLUE)
c.setFont("Helvetica-Bold", 17)
c.drawString(75, 175, "What controls the reading")
draw_wrapped("A rubber measuring roller with known circumference and an encoder attached directly to it.", 75, 145, 305, 13, INK, leading=17)
rounded(435, 105, 350, 105, LIGHT_RED, colors.HexColor("#FFD0D0"))
c.setFillColor(RED)
c.setFont("Helvetica-Bold", 17)
c.drawString(455, 175, "What does NOT control it")
draw_wrapped("GSM, fluffy fabric, roll diameter and packing tightness. They change roll size and weight, but not the roller count.", 455, 145, 305, 13, INK, leading=17)
page_footer(2)
c.showPage()


# Page 3: who builds what.
page_header("Who does what", "Two people can build this: a welder/fabricator and a software-electronics person", 3)
rounded(48, 105, 354, 385, colors.white)
rounded(438, 105, 354, 385, colors.white)
c.setFillColor(NAVY)
c.setFont("Helvetica-Bold", 23)
c.drawString(72, 446, "Welder / fabricator")
c.drawString(462, 446, "Electronics / software")
welder = [
    ("Build the frame", "Square-tube base and two side supports."),
    ("Mount bearings", "Keep left and right bearings aligned."),
    ("Fit rollers", "Supply shaft, measuring roller, nip and take-up."),
    ("Add guards", "Cover every chain, coupling and pinch point."),
]
electronics = [
    ("Fit the encoder", "Directly couple it to the measuring roller."),
    ("Connect the display", "Show metres, reset and direction."),
    ("Control the motor", "VFD speed knob plus hold-to-run pedal."),
    ("Wire safety", "E-stop and isolator must stop the drive."),
]
for col_x, items, col in [(72, welder, GREEN), (462, electronics, BLUE)]:
    y = 385
    for i, (head, body) in enumerate(items, 1):
        number_badge(i, col_x + 18, y + 6, col)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(col_x + 48, y + 7, head)
        draw_wrapped(body, col_x + 48, y - 15, 270, 11, MUTED, leading=14, max_lines=2)
        y -= 82
page_footer(3)
c.showPage()


# Page 4: operator steps.
page_header("How the operator uses it", "The normal job should feel like loading a roll, pressing a pedal and reading the display", 4)
steps = [
    ("Load", "Place the full fabric roll on the supply shaft."),
    ("Thread", "Pass fabric between the measuring roller and spring nip."),
    ("Attach", "Fix the fabric end to an empty take-up tube."),
    ("Reset", "Set the metre display to zero."),
    ("Run", "Hold the foot pedal and increase speed gradually."),
    ("Stop", "Release the pedal, cut the fabric and read metres."),
]
for i, (head, body) in enumerate(steps):
    row, col = divmod(i, 3)
    x = 48 + col * 258
    y = 310 - row * 190
    rounded(x, y, 232, 155, colors.white)
    number_badge(i + 1, x + 30, y + 120, BLUE if i < 5 else RED)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(x + 60, y + 114, head)
    draw_wrapped(body, x + 24, y + 78, 184, 12, INK, leading=16, max_lines=3)
page_footer(4)
c.showPage()


# Page 5: parts and layout.
page_header("What needs to be purchased", "Plain shopping list - exact brands and final lengths can be selected later", 5)
groups = [
    ("Frame and rotating parts", GREEN, ["40 x 40 x 2 mm mild-steel square tube", "Two 35 mm EN8/C45 shafts", "Six UCP207 pillow-block bearings", "100 mm measuring roller", "80 mm spring-loaded nip roller", "Adjustable core cones"]),
    ("Drive and controls", BLUE, ["About 0.55 kW geared motor", "Matching VFD speed controller", "Torque limiter or slip clutch", "Hold-to-run foot pedal", "Large emergency-stop button", "Main electrical isolator and enclosure"]),
    ("Measurement", ORANGE, ["Incremental encoder - 1024 PPR or higher", "Flexible encoder coupling", "Six-digit metre display", "Reset button", "Shielded encoder cable"]),
]
for idx, (head, col, items) in enumerate(groups):
    x = 48 + idx * 258
    rounded(x, 115, 232, 365, colors.white)
    c.setFillColor(col)
    c.rect(x, 430, 232, 50, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 15)
    c.drawCentredString(x + 116, 448, head)
    y = 395
    for item in items:
        c.setFillColor(col)
        c.circle(x + 22, y + 3, 4, fill=1, stroke=0)
        y = draw_wrapped(item, x + 38, y + 8, 172, 11.5, INK, leading=15, max_lines=2) - 15
page_footer(5)
c.showPage()


# Page 6: safety and calibration.
page_header("Before anyone runs the machine", "Safety and calibration are part of the machine - not optional extras", 6)
rounded(48, 245, 354, 245, LIGHT_RED, colors.HexColor("#FFD0D0"))
c.setFillColor(RED)
c.setFont("Helvetica-Bold", 22)
c.drawString(72, 450, "Safety checklist")
safety = ["E-stop immediately cuts motor drive", "Foot pedal must be held to run", "No exposed chain or coupling", "Hands cannot reach roller pinch points", "Frame is electrically earthed", "Torque limiter prevents violent pulling"]
for i, item in enumerate(safety):
    c.setFillColor(RED)
    c.circle(78, 405 - i * 30, 5, fill=1, stroke=0)
    c.setFillColor(INK)
    c.setFont("Helvetica", 12)
    c.drawString(94, 400 - i * 30, item)
rounded(438, 245, 354, 245, LIGHT_GREEN, colors.HexColor("#BFEBD5"))
c.setFillColor(GREEN)
c.setFont("Helvetica-Bold", 22)
c.drawString(462, 450, "Simple calibration")
cal = ["Thread fabric with low tension.", "Reset the display to zero.", "Run exactly 10 measured metres.", "Correct the roller constant in the display.", "Test three separate 20 m runs.", "Each result must be within 1 percent."]
for i, item in enumerate(cal, 1):
    number_badge(i, 475, 407 - (i - 1) * 30, GREEN)
    c.setFillColor(INK)
    c.setFont("Helvetica", 12)
    c.drawString(500, 402 - (i - 1) * 30, item)
rounded(48, 95, 744, 110, colors.white)
c.setFillColor(NAVY)
c.setFont("Helvetica-Bold", 17)
c.drawString(68, 164, "Do not fabricate these final dimensions yet")
draw_wrapped("Maximum roll diameter, core-hole range, complete roll width and available floor space are still provisional. Once those four values are known, the final frame and shaft drawings can be issued.", 68, 135, 700, 12.5, INK, leading=17)
page_footer(6)
c.showPage()

c.save()
print(OUT)
