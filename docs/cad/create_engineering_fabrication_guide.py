from pathlib import Path
import math
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT = Path("/Users/risheeray/grav-cms-backend/output/pdf/Fabric_Roll_Meter_Engineering_Fabrication_Guide_RevA.pdf")
OUT.parent.mkdir(parents=True, exist_ok=True)
W, H = landscape(A3)

NAVY = colors.HexColor("#173B64")
BLUE = colors.HexColor("#1769AA")
ORANGE = colors.HexColor("#E87924")
RED = colors.HexColor("#C73E3E")
GREEN = colors.HexColor("#2E7D5B")
INK = colors.HexColor("#1F2933")
MID = colors.HexColor("#596675")
GRID = colors.HexColor("#AEB8C4")
LIGHT = colors.HexColor("#F4F7FA")
PALE_BLUE = colors.HexColor("#EAF2FA")
PALE_RED = colors.HexColor("#FFF0F0")
WHITE = colors.white

c = canvas.Canvas(str(OUT), pagesize=(W, H))
c.setTitle("Fabric Roll Meter - Engineering Fabrication Guide Rev A")
c.setAuthor("Engineering concept handoff")


def wrap(text, x, y, width, size=10, leading=None, font="Helvetica", color=INK, max_lines=None):
    leading = leading or size * 1.3
    words = text.split()
    lines, cur = [], ""
    for word in words:
        trial = word if not cur else cur + " " + word
        if stringWidth(trial, font, size) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        while stringWidth(lines[-1] + "...", font, size) > width and lines[-1]:
            lines[-1] = lines[-1][:-1]
        lines[-1] += "..."
    c.setFont(font, size)
    c.setFillColor(color)
    for i, line in enumerate(lines):
        c.drawString(x, y - i * leading, line)
    return y - len(lines) * leading


def box(x, y, w, h, fill=WHITE, stroke=GRID, radius=4, sw=0.8):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(sw)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def page(title, subtitle, number):
    c.setFillColor(WHITE)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, H - 70, W, 70, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(34, H - 34, title)
    c.setFont("Helvetica", 9.5)
    c.drawString(35, H - 54, subtitle)
    c.setFillColor(PALE_RED)
    c.rect(W - 290, H - 70, 290, 70, fill=1, stroke=0)
    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(W - 145, H - 30, "NOT FOR FABRICATION")
    c.setFont("Helvetica", 9)
    c.drawCentredString(W - 145, H - 49, "PROVISIONAL DIMENSIONS - ENGINEER TO VERIFY")
    c.setStrokeColor(GRID)
    c.line(30, 42, W - 30, 42)
    c.setFillColor(MID)
    c.setFont("Helvetica", 8)
    c.drawString(34, 26, "FABRIC ROLL METER | ENGINEERING FABRICATION GUIDE | REV A | 2026-10-16")
    c.drawRightString(W - 34, 26, f"SHEET {number} OF 9")


def section_title(text, x, y, width=None):
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(x, y, text)
    if width:
        c.setStrokeColor(BLUE)
        c.setLineWidth(1.5)
        c.line(x, y - 6, x + width, y - 6)


def table(x, y_top, widths, rows, row_h=25, header=True, font_size=8.5):
    total_w = sum(widths)
    total_h = row_h * len(rows)
    c.setStrokeColor(GRID)
    c.setLineWidth(0.6)
    c.rect(x, y_top - total_h, total_w, total_h, fill=0, stroke=1)
    xpos = x
    for w in widths[:-1]:
        xpos += w
        c.line(xpos, y_top, xpos, y_top - total_h)
    for i in range(1, len(rows)):
        c.line(x, y_top - i * row_h, x + total_w, y_top - i * row_h)
    if header:
        c.setFillColor(PALE_BLUE)
        c.rect(x, y_top - row_h, total_w, row_h, fill=1, stroke=0)
        c.setStrokeColor(GRID)
        c.line(x, y_top - row_h, x + total_w, y_top - row_h)
    for r, row in enumerate(rows):
        xpos = x
        for col, value in enumerate(row):
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold" if header and r == 0 else "Helvetica", font_size)
            c.drawString(xpos + 5, y_top - r * row_h - row_h + 8, str(value))
            xpos += widths[col]
    return y_top - total_h


def line(x1, y1, x2, y2, color=INK, sw=1):
    c.setStrokeColor(color)
    c.setLineWidth(sw)
    c.line(x1, y1, x2, y2)


def rect(x, y, w, h, color=INK, sw=1, fill=None):
    c.setStrokeColor(color)
    c.setLineWidth(sw)
    if fill:
        c.setFillColor(fill)
    c.rect(x, y, w, h, fill=1 if fill else 0, stroke=1)


def circ(x, y, r, color=INK, sw=1, fill=None):
    c.setStrokeColor(color)
    c.setLineWidth(sw)
    if fill:
        c.setFillColor(fill)
    c.circle(x, y, r, fill=1 if fill else 0, stroke=1)


def arrow(x1, y1, x2, y2, color=ORANGE, sw=2):
    line(x1, y1, x2, y2, color, sw)
    a = math.atan2(y2-y1, x2-x1)
    s = 10
    pts = [(x2,y2),(x2-s*math.cos(a-.5),y2-s*math.sin(a-.5)),(x2-s*math.cos(a+.5),y2-s*math.sin(a+.5))]
    p = c.beginPath(); p.moveTo(*pts[0]); p.lineTo(*pts[1]); p.lineTo(*pts[2]); p.close()
    c.setFillColor(color); c.drawPath(p, fill=1, stroke=0)


def dim_h(x1, x2, y_object, y_dim, label, color=INK):
    line(x1, y_object, x1, y_dim, color, .6); line(x2, y_object, x2, y_dim, color, .6); line(x1, y_dim, x2, y_dim, color, .8)
    line(x1, y_dim, x1+8, y_dim+4, color, .8); line(x1, y_dim, x1+8, y_dim-4, color, .8)
    line(x2, y_dim, x2-8, y_dim+4, color, .8); line(x2, y_dim, x2-8, y_dim-4, color, .8)
    c.setFillColor(color); c.setFont("Helvetica", 8); c.drawCentredString((x1+x2)/2, y_dim+5, label)


def dim_v(y1, y2, x_object, x_dim, label, color=INK):
    line(x_object, y1, x_dim, y1, color, .6); line(x_object, y2, x_dim, y2, color, .6); line(x_dim, y1, x_dim, y2, color, .8)
    line(x_dim, y1, x_dim-4, y1+8, color, .8); line(x_dim, y1, x_dim+4, y1+8, color, .8)
    line(x_dim, y2, x_dim-4, y2-8, color, .8); line(x_dim, y2, x_dim+4, y2-8, color, .8)
    c.saveState(); c.translate(x_dim-6,(y1+y2)/2); c.rotate(90); c.setFont("Helvetica",8); c.setFillColor(color); c.drawCentredString(0,0,label); c.restoreState()


def machine_side(x, y, s=1.0, labels=True):
    # 450 deep x 520 high nominal side representation.
    line(x, y, x+450*s, y, NAVY, 4)
    line(x+20*s,y,x+20*s,y+500*s,NAVY,4); line(x+430*s,y,x+430*s,y+500*s,NAVY,4)
    circ(x+330*s,y+365*s,175*s,MID,1.5,colors.HexColor("#ECEFF3")); circ(x+330*s,y+365*s,38*s,BLUE,1.2)
    circ(x+220*s,y+265*s,50*s,BLUE,1.5,colors.HexColor("#B9D7FF")); circ(x+220*s,y+365*s,40*s,BLUE,1.5,colors.HexColor("#D8E9FF"))
    circ(x+95*s,y+150*s,110*s,MID,1.5,colors.HexColor("#ECEFF3")); circ(x+95*s,y+150*s,38*s,BLUE,1.2)
    arrow(x+330*s,y+190*s,x+250*s,y+225*s); arrow(x+220*s,y+315*s,x+220*s,y+325*s); arrow(x+185*s,y+225*s,x+120*s,y+205*s)
    rect(x+20*s,y+65*s,110*s,70*s,RED,1,PALE_RED)
    if labels:
        c.setFont("Helvetica-Bold",8); c.setFillColor(INK)
        c.drawString(x+270*s,y+555*s,"SUPPLY ROLL")
        c.drawString(x+145*s,y+425*s,"NIP + MEASURING")
        c.drawString(x+38*s,y+285*s,"TAKE-UP")
        c.setFillColor(RED); c.drawString(x+42*s,y+92*s,"GEARMOTOR")


# 1 - Design basis and architecture.
page("1. DESIGN BASIS AND SYSTEM ARCHITECTURE", "Confirmed requirements, provisional inputs and intended material path", 1)
section_title("Design basis", 40, 735, 500)
rows = [
    ["Parameter", "Value", "Status"],
    ["Fabric working width", "1470 mm", "CONFIRMED"],
    ["Maximum roll mass", "40 kg", "CONFIRMED"],
    ["Production target", "5000 m per 8 h", "CONFIRMED"],
    ["Normal line speed", "12-15 m/min", "DESIGN TARGET"],
    ["Maximum line speed", "20 m/min", "DESIGN TARGET"],
    ["Length accuracy", "better than 1%", "CONFIRMED"],
    ["Maximum roll OD", "350 mm", "PROVISIONAL"],
    ["Core bore", "76 mm nominal", "PROVISIONAL"],
    ["Machine envelope", "1750 x 450 x 520 mm", "PROVISIONAL"],
]
table(40, 710, [180,170,150], rows, 28, True, 9)
section_title("Functional arrangement", 590, 735, 540)
machine_side(650, 175, .9, True)
box(40, 95, 500, 230, PALE_RED, colors.HexColor("#E6BABA"))
c.setFillColor(RED); c.setFont("Helvetica-Bold",13); c.drawString(58,298,"Engineering hold points")
holds = [
    "Do not release shaft lengths until maximum complete roll width is measured.",
    "Do not release frame depth/height until maximum roll OD and available floor space are known.",
    "Confirm core bore range before designing core cones or chucks.",
    "Validate shaft deflection, bearing load, weldment stiffness and guarding before fabrication.",
]
y=270
for i,t in enumerate(holds,1):
    c.setFillColor(RED); c.setFont("Helvetica-Bold",9); c.drawString(58,y,f"H{i}")
    wrap(t,82,y,430,9,12,"Helvetica",INK,2); y-=46
c.showPage()


# 2 - General arrangement.
page("2. GENERAL ARRANGEMENT", "Front, top and side views - nominal dimensions shown in millimetres", 2)
section_title("Front elevation",40,735,700)
fx,fy=100,430; fw,fh=700,208
rect(fx,fy,fw,18,NAVY,2); rect(fx,fy,18,fh,NAVY,2); rect(fx+fw-18,fy,18,fh,NAVY,2)
for yy in [fy+68,fy+120,fy+168]:
    line(fx+35,yy,fx+fw-35,yy,BLUE,1.5); rect(fx+20,yy-15,32,30,colors.HexColor("#A12AA1"),1); rect(fx+fw-52,yy-15,32,30,colors.HexColor("#A12AA1"),1)
dim_h(fx,fx+fw,fy,fy-45,"1750 OVERALL - PROVISIONAL",RED)
dim_h(fx+70,fx+fw-70,fy+fh,fy+fh+38,"1470 CLEAR FABRIC WIDTH",INK)
dim_v(fy,fy+fh,fx,fx-35,"520 PROV.",RED)
rect(fx+fw+10,fy+45,75,55,RED,1,PALE_RED); c.setFillColor(RED); c.setFont("Helvetica-Bold",8); c.drawCentredString(fx+fw+47,fy+66,"GEARMOTOR")
section_title("Top view",40,350,700)
tx,ty=100,135; tw,td=700,180
rect(tx,ty,tw,td,NAVY,2)
for yy in [ty+45,ty+90,ty+135]: rect(tx+40,yy-12,tw-80,24,BLUE,1)
dim_h(tx,tx+tw,ty,ty-35,"1750 PROV.",RED); dim_v(ty,ty+td,tx+tw,tx+tw+35,"450 PROV.",RED)
section_title("Side section and fabric path",850,735,300)
machine_side(865,270,.55,False)
box(850,95,300,155,LIGHT)
wrap("Roll centres and roller heights must be adjusted after the actual maximum roll diameter and loading method are confirmed. Provide slotted bearing mounts during prototype commissioning.",870,220,260,10,14,"Helvetica",INK)
c.showPage()


# 3 - Frame fabrication.
page("3. FRAME WELDMENT AND CUT LIST", "Provisional square-tube frame; engineer to confirm member size and bearing support stiffness", 3)
section_title("Weldment layout",40,735,720)
fx,fy=80,355; fw,fd,fh=720,220,230
rect(fx,fy,fw,fd,NAVY,2); rect(fx+25,fy+25,fw-50,fd-50,NAVY,1)
for xx in [fx,fx+fw-18]:
    rect(xx,fy,18,fh,NAVY,2); rect(xx,fy+fd-18,18,fh,NAVY,2)
line(fx,fy,fx+fw,fy+fd,NAVY,1); line(fx,fy+fd,fx+fw,fy,NAVY,1)
dim_h(fx,fx+fw,fy,fy-40,"1750"); dim_v(fy,fy+fd,fx+fw,fx+fw+35,"450"); dim_v(fy,fy+fh,fx,fx-35,"520")
section_title("Provisional cut list - 40 x 40 x 2 mm MS SHS",850,735,300)
cut_rows=[
    ["Item","Description","Qty","Cut length"],
    ["F1","Long base rail","2","1750"],
    ["F2","Depth rail","4","450"],
    ["F3","Vertical post","4","520"],
    ["F4","Bearing cross-member","6","450"],
    ["F5","Guard bracket","as req.","site fit"],
]
table(850,705,[45,135,55,80],cut_rows,31,True,8.5)
box(850,390,300,120,PALE_BLUE)
c.setFillColor(NAVY); c.setFont("Helvetica-Bold",11); c.drawString(868,480,"Weld notes")
wrap("4 mm fillet welds unless calculated otherwise. Tack complete frame, verify diagonals and bearing centre alignment, then finish weld symmetrically to limit distortion.",868,455,265,9.5,13,"Helvetica",INK)
box(40,95,1110,190,LIGHT)
c.setFillColor(NAVY); c.setFont("Helvetica-Bold",12); c.drawString(58,255,"Required checks before drilling bearing holes")
checks=["Frame diagonals within 1 mm.","Opposed bearing centre heights within 0.5 mm.","Shaft axes parallel within 0.5 mm over full span.","Use slotted bearing plates for prototype adjustment.","Provide levelling feet and floor anchoring points.","Trial assemble before paint or powder coating."]
for i,t in enumerate(checks):
    col=i%3; row=i//3; x=58+col*355; y=220-row*58
    c.setFillColor(BLUE); c.circle(x+5,y+4,4,fill=1,stroke=0); wrap(t,x+18,y+8,315,9.5,13,"Helvetica",INK,2)
c.showPage()


# 4 - shafts and rollers.
page("4. SHAFTS, ROLLERS AND BEARINGS", "Nominal rotating-component specification and machining requirements", 4)
section_title("Measuring roller assembly",40,735,1110)
rx,ry=150,590; rw,rh=760,55
rect(rx,ry,rw,rh,BLUE,1.5,colors.HexColor("#DCEBFA")); rect(rx-55,ry+19,55,17,RED,1); rect(rx+rw,ry+19,55,17,RED,1)
dim_h(rx,rx+rw,ry+rh,ry+rh+45,"1550 FACE"); dim_v(ry,ry+rh,rx+rw,rx+rw+45,"100 OD")
c.setFillColor(INK); c.setFont("Helvetica",9); c.drawString(350,555,"Rubber lagged aluminium roller | Runout <= 0.20 mm TIR")
box(970,550,180,125,LIGHT)
wrap("Encoder end: flexible coupling to the roller shaft. Do not use belt or fabric roll rotation for length measurement.",990,650,145,9,12,"Helvetica",INK)
section_title("Supply and take-up shaft",40,505,1110)
sx,sy=120,390; sw=850
rect(sx,sy,sw,20,RED,1,colors.HexColor("#FFF4F4")); rect(sx+45,sy-25,55,70,colors.HexColor("#A12AA1"),1); rect(sx+sw-100,sy-25,55,70,colors.HexColor("#A12AA1"),1)
dim_h(sx,sx+sw,sy+20,sy+65,"1650 SHAFT LENGTH - PROVISIONAL",RED)
c.setFillColor(INK); c.setFont("Helvetica-Bold",10); c.drawCentredString(sx+sw/2,350,"35 mm DIA EN8 / C45 SOLID SHAFT - PROVISIONAL")
section_title("Nominal parts",40,290,500)
part_rows=[
    ["Part","Nominal specification","Qty"],
    ["Supply shaft","35 dia solid EN8/C45","1"],
    ["Take-up shaft","35 dia solid EN8/C45","1"],
    ["Measuring roller","100 OD x 1550 face","1"],
    ["Nip roller","80 OD x 1550 face","1"],
    ["Bearings","UCP207, 35 mm bore","6"],
    ["Core cones","76 mm nominal, adjustable","2 pairs"],
]
table(40,265,[120,280,70],part_rows,25,True,8.5)
box(560,95,590,195,PALE_RED,colors.HexColor("#E4BABA"))
c.setFillColor(RED); c.setFont("Helvetica-Bold",12); c.drawString(580,260,"Engineer validation required")
notes=["Check shaft deflection using actual unsupported span and worst roll load.","Check bearing dynamic/static rating and shaft shoulder arrangement.","Specify keyways, retaining collars and coupling fits after motor/clutch selection.","Balance measuring and nip rollers for the selected maximum speed.","Confirm core-cone range from the smallest and largest actual core bores."]
y=232
for n in notes:
    c.setFillColor(RED); c.circle(585,y+3,3,fill=1,stroke=0); wrap(n,597,y+7,530,9,12,"Helvetica",INK,2); y-=31
c.showPage()


# 5 - measuring station.
page("5. MEASURING STATION AND ENCODER", "Accuracy depends on controlled roller contact, low slip and correct encoder scaling", 5)
section_title("Cross-section through nip",40,735,520)
cx,cy=280,470
circ(cx,cy,90,BLUE,2,colors.HexColor("#CFE3FA")); circ(cx,cy+165,70,BLUE,2,colors.HexColor("#E2EFFB"))
line(cx-190,cy+80,cx+190,cy+80,ORANGE,5)
arrow(cx-150,cy+80,cx+140,cy+80,ORANGE,4)
line(cx,cy+235,cx,cy+250,INK,2); rect(cx-70,cy+250,140,40,INK,1,LIGHT)
c.setFillColor(INK); c.setFont("Helvetica-Bold",10); c.drawCentredString(cx,cy+264,"SPRING ADJUSTER")
c.setFont("Helvetica",9); c.drawString(cx+105,cy+165,"80 OD NIP"); c.drawString(cx+105,cy-5,"100 OD MEASURING")
box(40,95,520,250,LIGHT)
c.setFillColor(NAVY); c.setFont("Helvetica-Bold",12); c.drawString(58,315,"Mechanical requirements")
reqs=["Uniform nip pressure across 1470 mm width.","Independent left/right spring adjustment.","Roller axes parallel within 0.5 mm.","Rubber surface selected for grip without marking fabric.","Roller runout <= 0.20 mm TIR.","Provide quick release for threading and jam clearing."]
y=286
for r in reqs:
    c.setFillColor(BLUE); c.circle(64,y+3,3,fill=1,stroke=0); wrap(r,76,y+7,455,9.5,12,"Helvetica",INK,1); y-=31
section_title("Encoder arrangement",620,735,530)
rect(670,540,330,80,BLUE,1.5,colors.HexColor("#DCEBFA")); rect(1000,568,45,24,RED,1); circ(1090,580,48,GREEN,1.5,colors.HexColor("#E5F5EE"))
arrow(1045,580,1042,580,BLUE,1)
line(1045,580,1042,580,BLUE,2); line(1045,580,1042,580,BLUE,2)
c.setFillColor(INK); c.setFont("Helvetica-Bold",10); c.drawCentredString(835,575,"MEASURING ROLLER")
c.drawCentredString(1090,575,"ENCODER")
c.setFont("Helvetica",9); c.drawCentredString(1022,622,"FLEXIBLE COUPLING")
box(620,360,530,125,PALE_BLUE)
c.setFillColor(NAVY); c.setFont("Helvetica-Bold",11); c.drawString(640,455,"Nominal encoder selection")
wrap("Incremental A/B encoder, 1024 PPR or higher, industrial shaft coupling, shielded cable and a totaliser that accepts the selected pulse convention.",640,430,490,9.5,13,"Helvetica",INK)
section_title("Scaling calculation",620,320,530)
calc=[
    "Nominal roller circumference = pi x 100 = 314.159 mm",
    "At 1024 pulses/rev: 0.3068 mm per pulse",
    "At 12 m/min: roller speed = 38.2 rpm",
    "At 15 m/min: roller speed = 47.7 rpm",
    "At 20 m/min: roller speed = 63.7 rpm",
]
box(620,95,530,195,WHITE)
y=260
for t in calc:
    c.setFillColor(GREEN); c.circle(642,y+2,3,fill=1,stroke=0); c.setFillColor(INK); c.setFont("Helvetica",10); c.drawString(654,y-2,t); y-=31
c.showPage()


# 6 - drive assembly.
page("6. TAKE-UP DRIVE AND TENSION CONTROL", "VFD sets speed; torque limiter prevents the take-up roll from over-pulling the fabric", 6)
section_title("Mechanical power train",40,735,1110)
blocks=[("0.55 kW\nGEARMOTOR",70,560,150),("FLEXIBLE\nCOUPLING",270,560,140),("TORQUE LIMITER /\nSLIP CLUTCH",460,560,170),("TAKE-UP SHAFT",680,560,160),("EMPTY CORE / ROLL",890,560,190)]
for label,x,y,w in blocks:
    box(x,y,w,90,PALE_BLUE,BLUE,5,1.2)
    lines=label.split("\n"); c.setFillColor(NAVY); c.setFont("Helvetica-Bold",11)
    for i,t in enumerate(lines): c.drawCentredString(x+w/2,y+55-i*18,t)
for i in range(len(blocks)-1): arrow(blocks[i][1]+blocks[i][3],605,blocks[i+1][1],605,BLUE,2)
box(40,345,540,155,LIGHT)
c.setFillColor(NAVY); c.setFont("Helvetica-Bold",12); c.drawString(58,470,"Required speed range")
speed_rows=[
    ["Take-up diameter","RPM at 12 m/min","RPM at 20 m/min"],
    ["76 mm core","50.3","83.8"],
    ["200 mm roll","19.1","31.8"],
    ["350 mm roll","10.9","18.2"],
]
table(58,445,[160,150,150],speed_rows,27,True,8.5)
box(610,345,540,155,PALE_RED,colors.HexColor("#E4BABA"))
c.setFillColor(RED); c.setFont("Helvetica-Bold",12); c.drawString(628,470,"Drive selection notes")
wrap("Motor rating and gearbox ratio are provisional. Select gearbox/VFD to cover approximately 10-85 rpm at the take-up shaft. Set the torque limiter during commissioning using the most delicate fabric. Do not rely on VFD speed alone to control web tension as roll diameter increases.",628,445,500,9.5,13,"Helvetica",INK)
section_title("Mounting and guarding",40,300,1110)
guard_notes=["Mount gearmotor on a slotted plate for coupling alignment.","Use a flexible coupling; do not rigidly couple misaligned shafts.","Guard the motor coupling, clutch and all rotating projections.","Provide a removable guard with interlock if required by the engineer's risk assessment.","Keep manual jog speed low for threading.","Provide mechanical shaft retention at both bearings."]
for i,t in enumerate(guard_notes):
    col=i%2; row=i//2; x=50+col*555; y=255-row*58
    c.setFillColor(BLUE); c.circle(x+5,y+3,4,fill=1,stroke=0); wrap(t,x+18,y+7,510,9.5,13,"Helvetica",INK,2)
c.showPage()


# 7 - electrical.
page("7. ELECTRICAL CONTROL SCHEMATIC", "Functional design only - qualified electrician to select protection, wire sizes and enclosure", 7)
section_title("Power circuit",40,735,1110)
pblocks=[("230 V AC",55,590,130),("MAIN\nISOLATOR",235,590,130),("PROTECTION",415,590,130),("VFD",595,590,130),("GEARMOTOR",775,590,150)]
for lab,x,y,w in pblocks:
    box(x,y,w,80,WHITE,BLUE,3,1.2); c.setFillColor(NAVY); c.setFont("Helvetica-Bold",11)
    for i,t in enumerate(lab.split("\n")): c.drawCentredString(x+w/2,y+47-i*16,t)
for i in range(len(pblocks)-1): arrow(pblocks[i][1]+pblocks[i][3],630,pblocks[i+1][1],630,BLUE,2)
line(850,590,850,535,GREEN,2); c.setFillColor(GREEN); c.setFont("Helvetica-Bold",9); c.drawCentredString(850,515,"PE / FRAME EARTH")
section_title("Control circuit",40,495,1110)
cblocks=[("E-STOP NC",55,370,150),("HOLD-TO-RUN\nFOOT PEDAL",255,370,160),("VFD RUN / ENABLE",465,370,175),("SPEED POT",690,370,140)]
for lab,x,y,w in cblocks:
    fill=PALE_RED if "E-STOP" in lab else PALE_BLUE
    stroke=RED if "E-STOP" in lab else BLUE
    box(x,y,w,80,fill,stroke,3,1.2); c.setFillColor(stroke); c.setFont("Helvetica-Bold",10)
    for i,t in enumerate(lab.split("\n")): c.drawCentredString(x+w/2,y+47-i*16,t)
for i in range(len(cblocks)-1): arrow(cblocks[i][1]+cblocks[i][3],410,cblocks[i+1][1],410,INK,1.5)
section_title("Measurement circuit",40,315,1110)
mb=[("ENCODER A/B",55,205,155),("SHIELDED CABLE",260,205,155),("METRE TOTALISER",465,205,175),("RESET BUTTON",690,205,150)]
for lab,x,y,w in mb:
    box(x,y,w,70,LIGHT,GREEN,3,1.2); c.setFillColor(GREEN); c.setFont("Helvetica-Bold",10); c.drawCentredString(x+w/2,y+31,lab)
for i in range(len(mb)-1): arrow(mb[i][1]+mb[i][3],240,mb[i+1][1],240,GREEN,1.5)
box(880,165,270,305,PALE_RED,colors.HexColor("#E4BABA"))
c.setFillColor(RED); c.setFont("Helvetica-Bold",12); c.drawString(900,440,"Electrical requirements")
elect=["E-stop removes drive torque using the selected safety architecture.","Foot pedal is hold-to-run, not toggle-run.","Provide short-circuit and overload protection.","Earth frame, motor and enclosure.","Separate encoder cable from motor/VFD cable.","Provide low-speed jog for threading.","Confirm local electrical and machinery requirements before build."]
y=410
for t in elect:
    c.setFillColor(RED); c.circle(906,y+2,3,fill=1,stroke=0); wrap(t,918,y+6,212,8.8,11,"Helvetica",INK,2); y-=38
c.showPage()


# 8 - assembly sequence.
page("8. ASSEMBLY, ALIGNMENT AND COMMISSIONING", "Recommended build sequence to minimise rework and measurement error", 8)
steps=[
    ("1","Tack frame","Tack the base and posts. Check diagonals and level before finish welding."),
    ("2","Fit bearing plates","Use slotted plates. Keep opposing bearing centres level and parallel."),
    ("3","Install shafts","Verify free rotation and axial retention before adding rolls or motor."),
    ("4","Install measuring pair","Set roller parallelism and equal spring adjustment left/right."),
    ("5","Fit drive","Align motor, flexible coupling and torque limiter. Install guards."),
    ("6","Fit encoder","Direct couple to measuring roller; verify no binding or shaft load."),
    ("7","Wire controls","Electrician installs isolator, protection, E-stop, pedal, VFD and earth."),
    ("8","Dry test","Run without fabric at low speed. Check vibration, noise and stopping."),
    ("9","Fabric test","Thread low-value fabric, set low torque and perform calibration tests."),
]
for i,(num,head,body) in enumerate(steps):
    col=i%3; row=i//3; x=40+col*380; y=565-row*190
    box(x,y,350,150,WHITE,GRID,8,1)
    c.setFillColor(BLUE); c.circle(x+32,y+112,20,fill=1,stroke=0)
    c.setFillColor(WHITE); c.setFont("Helvetica-Bold",12); c.drawCentredString(x+32,y+108,num)
    c.setFillColor(NAVY); c.setFont("Helvetica-Bold",13); c.drawString(x+65,y+108,head)
    wrap(body,x+24,y+72,300,9.5,13,"Helvetica",INK,4)
c.showPage()


# 9 - calibration and release checklist.
page("9. CALIBRATION, ACCEPTANCE AND OPEN INPUTS", "Complete these tests and confirm the missing dimensions before releasing fabrication drawings", 9)
section_title("Length calibration and acceptance test",40,735,540)
tests=[
    ["Step","Action","Acceptance"],
    ["1","Measure actual roller circumference","Record at working nip pressure"],
    ["2","Enter initial counter constant","Match encoder pulse mode"],
    ["3","Run measured 10 m sample","Correct scale factor"],
    ["4","Run three separate 20 m tests","Each error < 1%"],
    ["5","Repeat at 5, 12 and 20 m/min","No speed-dependent error"],
    ["6","Repeat with light and heavy fabric","No unacceptable slip/stretch"],
    ["7","Emergency stop test","Drive torque removed promptly"],
    ["8","Guard and pinch-point inspection","No accessible moving hazard"],
]
table(40,710,[55,300,220],tests,31,True,8.5)
section_title("Open inputs required for final drawings",650,735,500)
inputs=[
    ["Input","Current provisional value","Final value"],
    ["Maximum complete roll width","1550 mm","____________"],
    ["Maximum roll outside diameter","350 mm","____________"],
    ["Smallest core bore","76 mm","____________"],
    ["Largest core bore","76 mm","____________"],
    ["Available floor length","1750 mm","____________"],
    ["Available floor depth","450 mm","____________"],
    ["Maximum permitted height","520 mm","____________"],
    ["Fabric extremes / stretch","unknown","____________"],
]
table(650,710,[190,165,135],inputs,31,True,8.2)
box(40,95,1110,250,LIGHT)
section_title("Release checklist for responsible engineer",58,315,1060)
release=[
    "Verify actual dimensions above and update GA, shafts, core cones and guards.",
    "Complete shaft deflection, bearing life, frame stiffness and weld checks.",
    "Select gearmotor ratio, VFD, torque limiter and couplings from calculated loads.",
    "Complete machinery risk assessment and guarding design.",
    "Issue final part drawings with tolerances, fits, materials and finishes.",
    "Approve electrical schematic, protection, E-stop architecture and enclosure.",
    "Witness calibration and acceptance tests before production use.",
]
y=280
for i,t in enumerate(release,1):
    c.setStrokeColor(BLUE); c.rect(60,y-5,12,12,fill=0,stroke=1)
    c.setFillColor(INK); c.setFont("Helvetica",10); c.drawString(85,y-2,f"{i}. {t}")
    y-=30
c.showPage()

c.save()
print(OUT)
