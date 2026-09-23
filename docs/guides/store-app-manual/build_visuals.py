from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)
SCREEN = Path("/private/var/folders/5z/m3hh5ln57sx2r96nw9l845g40000gn/T/codex-clipboard-853e8658-7174-47a8-8421-5d71bafd6d7c.png")
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

INK = "#141414"
MUTED = "#646464"
HAIR = "#D9D9D9"
PALE = "#F4F6F8"
BLUE = "#1D4ED8"
GREEN = "#15803D"
AMBER = "#B45309"
RED = "#B42318"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def rounded(draw, box, fill="white", outline=HAIR, width=2, radius=20):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def fit_text(draw, text, box_w, size=30, bold=False):
    f = font(size, bold)
    words, lines, current = text.split(), [], ""
    for word in words:
        trial = (current + " " + word).strip()
        if draw.textbbox((0, 0), trial, font=f)[2] <= box_w:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines, f


def number_badge(draw, x, y, n, color=BLUE, radius=28):
    draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color, outline="white", width=4)
    t = str(n)
    f = font(26, True)
    box = draw.textbbox((0, 0), t, font=f)
    draw.text((x-(box[2]-box[0])/2, y-(box[3]-box[1])/2-2), t, fill="white", font=f)


def annotate_service_screen():
    img = Image.open(SCREEN).convert("RGB")
    img.thumbnail((1900, 1200))
    draw = ImageDraw.Draw(img)
    points = [
        (455, 166, 1),   # Purchase nav
        (117, 319, 2),   # page identity
        (1465, 388, 3),  # refresh
        (174, 497, 4),   # state filters
        (1485, 500, 5),  # search
        (426, 603, 6),   # failure banner
    ]
    sx = img.width / 1987
    sy = img.height / 1248
    for x, y, n in points:
        number_badge(draw, int(x*sx), int(y*sy), n)
    img.save(ASSETS / "service-orders-annotated.png", quality=95)

    crop = img.crop((0, 0, img.width, int(650*sy)))
    panel_h = 330
    out = Image.new("RGB", (crop.width, crop.height + panel_h), "white")
    out.paste(crop, (0, 0))
    d = ImageDraw.Draw(out)
    labels = [
        (1, "Purchase navigation", "Service orders sit beside purchase orders because services are ordered but never received into stock."),
        (2, "Page identity", "The heading explains the document and explicitly states that no goods receipt or stock movement is created."),
        (3, "Refresh", "Reloads the register. Use it after another user changes an order."),
        (4, "Status filters", "Use the business state to narrow the queue. All returns the complete accessible register."),
        (5, "Search", "Search by service order number, source request or supplier."),
        (6, "Explained failure", "A failure banner must tell you what failed. Refresh only helps when the problem is temporary."),
    ]
    col_w = out.width // 2
    y0 = crop.height + 22
    for i, (n, title, body) in enumerate(labels):
        col = i % 2
        row = i // 2
        x = 24 + col * col_w
        y = y0 + row * 96
        number_badge(d, x + 20, y + 22, n, radius=20)
        d.text((x + 52, y), title, fill=INK, font=font(23, True))
        lines, f = fit_text(d, body, col_w - 90, 19)
        for li, line in enumerate(lines[:3]):
            d.text((x + 52, y + 31 + li*23), line, fill=MUTED, font=f)
    out.save(ASSETS / "service-orders-annotated-with-key.png", quality=95)


def diagram(title, subtitle, nodes, arrows, filename, columns=4):
    w, h = 1800, 1040
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    d.text((80, 60), title, fill=INK, font=font(46, True))
    d.text((80, 125), subtitle, fill=MUTED, font=font(24))
    top = 230
    card_w = 350 if columns == 4 else 470
    card_h = 170
    gap_x = (w - 160 - card_w * columns) / max(1, columns - 1)
    positions = {}
    for idx, node in enumerate(nodes):
        row, col = divmod(idx, columns)
        x = int(80 + col * (card_w + gap_x))
        y = top + row * 260
        positions[node[0]] = (x, y, x+card_w, y+card_h)
        rounded(d, positions[node[0]], fill=node[3] if len(node) > 3 else PALE, radius=24)
        d.text((x+22, y+18), node[1], fill=INK, font=font(27, True))
        lines, f = fit_text(d, node[2], card_w-44, 21)
        for li, line in enumerate(lines[:4]):
            d.text((x+22, y+62+li*27), line, fill=MUTED, font=f)
    for a, b, label in arrows:
        a_box, b_box = positions[a], positions[b]
        same_row = abs(a_box[1] - b_box[1]) < 20
        if same_row:
            left_to_right = a_box[0] < b_box[0]
            ax = a_box[2] if left_to_right else a_box[0]
            bx = b_box[0] if left_to_right else b_box[2]
            ay = by = (a_box[1] + a_box[3]) // 2
            points = [(ax, ay), (bx, by)]
            label_x, label_y = (ax + bx) // 2, ay
        else:
            target_below = b_box[1] > a_box[1]
            ax = (a_box[0] + a_box[2]) // 2
            bx = (b_box[0] + b_box[2]) // 2
            ay = a_box[3] if target_below else a_box[1]
            by = b_box[1] if target_below else b_box[3]
            bend_y = (ay + by) // 2
            points = [(ax, ay), (ax, bend_y), (bx, bend_y), (bx, by)]
            label_x, label_y = (ax + bx) // 2, bend_y
        d.line(points, fill=BLUE, width=5, joint="curve")
        import math
        ang = math.atan2(by-ay, bx-ax)
        for delta in (2.55, -2.55):
            d.line((bx, by, bx+18*math.cos(ang+delta), by+18*math.sin(ang+delta)), fill=BLUE, width=5)
        if label:
            mx, my = label_x, label_y
            tw = d.textbbox((0, 0), label, font=font(18, True))[2]
            d.rounded_rectangle((mx-tw//2-10, my-16, mx+tw//2+10, my+15), 10, fill="white")
            d.text((mx-tw//2, my-12), label, fill=BLUE, font=font(18, True))
    img.save(ASSETS / filename, quality=95)


def build_diagrams():
    diagram(
        "Demand to payment",
        "Each application owns one part of the chain; Store and Purchase connect the operational documents.",
        [
            ("request", "Request", "Employee need and department approval", "#EEF2FF"),
            ("classify", "Store decision", "Issue from stock, buy an item, or order a service", "#EFF6FF"),
            ("source", "Supplier sourcing", "Capture comparable dated supplier offers", "#F0FDF4"),
            ("order", "Order", "Purchase order for goods or service order for work", "#F0FDF4"),
            ("receive", "Receive and inspect", "Goods receipt, acceptance, quarantine and rejection", "#FFF7ED"),
            ("putaway", "Put away", "Move accepted goods into a usable location", "#FFF7ED"),
            ("match", "Accounting match", "Match PO, accepted receipt and posted supplier bill", "#FDF2F8"),
            ("settle", "Payment", "Accounting owns the payable and payment", "#FDF2F8"),
        ],
        [("request", "classify", "approve"), ("classify", "source", "buy"), ("source", "order", "select"),
         ("order", "receive", "deliver"), ("receive", "putaway", "accept"), ("putaway", "match", "evidence"),
         ("match", "settle", "post")],
        "workflow-demand-to-payment.png",
    )
    diagram(
        "Inventory quantity states",
        "Do not treat these figures as synonyms. Every operational decision depends on the distinction.",
        [
            ("onhand", "On hand", "Physical quantity recorded in Store", "#EFF6FF"),
            ("reserved", "Reserved", "On-hand quantity promised to approved demand", "#FFF7ED"),
            ("available", "Available", "On hand minus active reservations", "#F0FDF4"),
            ("picked", "Picked", "Prepared for issue; stock has not left yet", "#F5F3FF"),
            ("issued", "Issued", "Transferred to the requesting work or department", "#FDF2F8"),
            ("returned", "Returned", "Unused issued material returned to a usable location", "#EEF2FF"),
            ("quarantine", "Quarantine", "Received but not accepted as usable", "#FEF2F2"),
            ("unassigned", "Unassigned", "On hand but not yet placed in a location", "#FFFBEB"),
        ],
        [("onhand", "reserved", "promise"), ("reserved", "available", "subtract"),
         ("available", "picked", "prepare"), ("issued", "returned", "return surplus")],
        "inventory-quantity-states.png",
    )
    diagram(
        "Masters and documents",
        "Masters define reusable identity. Documents record dated business events and keep historical snapshots.",
        [
            ("material", "Materials", "Physical stock-tracked inputs and variants", "#EFF6FF"),
            ("product", "Finished products and BOM", "Read-only production catalogue in Store", "#EEF2FF"),
            ("service", "Service master", "Non-stock work, subscriptions and charges", "#F5F3FF"),
            ("supplier", "Suppliers", "Who the company buys goods or services from", "#F0FDF4"),
            ("offer", "Supplier offers", "Dated price, unit, terms, lead time and validity", "#FFF7ED"),
            ("warehouse", "Warehouses and locations", "Where physical stock is received and held", "#FFFBEB"),
            ("po", "Purchase order", "Binding order for physical goods", "#FDF2F8"),
            ("so", "Service order", "Binding order for non-stock work", "#FDF2F8"),
        ],
        [],
        "masters-and-documents.png",
    )
    diagram(
        "Budget and Accounting connection",
        "Budget controls planned spend. Accounting owns posted actuals and payments. Store retains operational context.",
        [
            ("line", "Request line", "Item or service and required quantity", "#EEF2FF"),
            ("allocation", "Budget allocation", "Resolved head, period and allocation identity", "#F5F3FF"),
            ("commitment", "Commitment", "Approved amount reserved against budget", "#FFF7ED"),
            ("po", "PO or service order", "Operational order carries the request-line identity", "#F0FDF4"),
            ("accept", "Accepted receipt or service", "Factual quantity accepted by the business", "#EFF6FF"),
            ("voucher", "Posted supplier voucher", "Accounting actual; recoverable GST remains separate", "#FDF2F8"),
            ("settle", "Budget settlement", "Commitment releases or settles against posted actual", "#FFF7ED"),
            ("payment", "Payment", "Accounting settles the supplier ledger", "#FDF2F8"),
        ],
        [("line", "allocation", "resolve"), ("allocation", "commitment", "approve"),
         ("commitment", "po", "carry id"), ("po", "accept", "fulfil"),
         ("accept", "voucher", "match"), ("voucher", "settle", "post"),
         ("voucher", "payment", "pay")],
        "budget-accounting-connection.png",
    )


if __name__ == "__main__":
    annotate_service_screen()
    build_diagrams()
    print(ASSETS)
