import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OBJ = ROOT / "fabric_roll_meter_40kg.obj"
OUT = ROOT / "fabric_roll_meter_40kg_preview.png"

COLORS = {
    "frame_blue": (28, 92, 198),
    "steel": (158, 166, 177),
    "bearing": (48, 57, 70),
    "rubber": (55, 59, 66),
    "fabric": (235, 231, 211),
    "fabric_sheet": (247, 243, 224),
    "cardboard": (160, 112, 62),
    "printed_black": (33, 38, 47),
}


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(v):
    length = math.sqrt(dot(v, v)) or 1.0
    return tuple(x / length for x in v)


vertices = []
faces = []
material = "steel"
for line in OBJ.read_text().splitlines():
    if line.startswith("v "):
        vertices.append(tuple(map(float, line.split()[1:4])))
    elif line.startswith("usemtl "):
        material = line.split(maxsplit=1)[1]
    elif line.startswith("f "):
        ids = [int(part.split("/")[0]) - 1 for part in line.split()[1:]]
        faces.append((ids, material))

center = tuple(sum(v[i] for v in vertices) / len(vertices) for i in range(3))
view = norm((1.0, -1.35, 0.85))
right = norm(cross((0.0, 0.0, 1.0), view))
up = norm(cross(view, right))
projected = []
for v in vertices:
    p = tuple(v[i] - center[i] for i in range(3))
    projected.append((dot(p, right), dot(p, up), dot(p, view)))

width, height = 1600, 900
margin_x, margin_top, margin_bottom = 95, 125, 105
xs = [p[0] for p in projected]
ys = [p[1] for p in projected]
scale = min((width - 2 * margin_x) / (max(xs) - min(xs)), (height - margin_top - margin_bottom) / (max(ys) - min(ys)))
cx = width / 2 - scale * (min(xs) + max(xs)) / 2
cy = margin_top + (height - margin_top - margin_bottom) / 2 + scale * (min(ys) + max(ys)) / 2

img = Image.new("RGB", (width, height), (246, 248, 252))
draw = ImageDraw.Draw(img)

# Subtle workshop-style ground grid.
for x in range(0, width, 50):
    draw.line((x, 0, x, height), fill=(229, 233, 240), width=1)
for y in range(0, height, 50):
    draw.line((0, y, width, y), fill=(229, 233, 240), width=1)

light = norm((-0.4, -0.7, 1.0))
ordered = []
for ids, mat in faces:
    depth = sum(projected[i][2] for i in ids) / len(ids)
    ordered.append((depth, ids, mat))

for _, ids, mat in sorted(ordered, key=lambda item: item[0]):
    pts3 = [vertices[i] for i in ids]
    a = tuple(pts3[1][i] - pts3[0][i] for i in range(3))
    b = tuple(pts3[2][i] - pts3[0][i] for i in range(3))
    normal = norm(cross(a, b))
    shade = 0.68 + 0.32 * abs(dot(normal, light))
    base = COLORS.get(mat, (150, 150, 150))
    fill = tuple(max(0, min(255, int(c * shade))) for c in base)
    pts2 = [(cx + projected[i][0] * scale, cy - projected[i][1] * scale) for i in ids]
    draw.polygon(pts2, fill=fill, outline=(28, 35, 48))

try:
    title_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 42)
    body_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 23)
except OSError:
    title_font = ImageFont.load_default()
    body_font = ImageFont.load_default()

draw.rounded_rectangle((45, 32, 1555, 102), radius=18, fill=(18, 43, 82))
draw.text((75, 47), "40 kg COMPACT HAND-CRANK FABRIC METER — CAD CONCEPT", fill="white", font=title_font)
draw.rounded_rectangle((50, 803, 1550, 867), radius=14, fill=(255, 255, 255), outline=(43, 74, 122), width=2)
draw.text((75, 821), "Envelope: 1750 × 450 × 520 mm   |   Fabric: 1470 mm   |   40 × 40 mm steel frame   |   35 mm roll shafts", fill=(23, 47, 78), font=body_font)

img.save(OUT)
print(OUT)
