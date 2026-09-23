from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SRC = Path(__file__).resolve().parent / "assets"
OUT = Path(__file__).resolve().parent / "contact-sheet.png"
files = sorted(SRC.glob("*.png"))
thumb_w, thumb_h = 520, 340
label_h = 44
canvas = Image.new("RGB", (thumb_w * 2, (thumb_h + label_h) * ((len(files) + 1) // 2)), "white")
draw = ImageDraw.Draw(canvas)
font = ImageFont.load_default()
for idx, path in enumerate(files):
    image = Image.open(path).convert("RGB")
    image.thumbnail((thumb_w - 20, thumb_h - 20))
    x = (idx % 2) * thumb_w + (thumb_w - image.width) // 2
    y0 = (idx // 2) * (thumb_h + label_h)
    y = y0 + (thumb_h - image.height) // 2
    canvas.paste(image, (x, y))
    draw.text((10 + (idx % 2) * thumb_w, y0 + thumb_h + 6), path.name, fill="black", font=font)
canvas.save(OUT)
print(OUT)
