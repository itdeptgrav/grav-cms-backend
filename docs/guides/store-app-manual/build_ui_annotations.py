from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import textwrap

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "assets" / "ui-captures"
OUT = ROOT / "assets" / "ui-annotated"
OUT.mkdir(parents=True, exist_ok=True)

BLUE = "#2457D6"
INK = "#121821"
MUTED = "#556274"
PANEL = "#F5F7FB"
LINE = "#9BB2EE"
WHITE = "#FFFFFF"

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size, bold=False):
    path = BOLD_PATH if bold else FONT_PATH
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


# Anchors are normalized coordinates within the visible application capture (0..1).
# The full capture is preserved; a separate instruction panel is added beside it.
SPECS = [
    ("01-overview", "Start the shift from Overview", [
        ("Read Needs attention before opening routine registers.", (.23, .35)),
        ("Use the Purchasing cards to open the correct filtered queue.", (.25, .48)),
        ("Use Receiving and stock for inspections, put-away and reservations.", (.25, .66)),
        ("Use the Open action on the relevant card to enter its filtered queue.", (.87, .66)),
    ]),
    ("02-request-desk", "Review approved demand in Request desk", [
        ("Use the stage cards to understand the queue before filtering.", (.25, .36)),
        ("Filter by workflow stage and request type; search by number or requester.", (.33, .45)),
        ("Read type, requester, status and fulfilment result on each row.", (.27, .55)),
        ("Choose View to inspect and classify the exact request.", (.88, .55)),
    ]),
    ("25-request-detail-open", "Inspect a request before acting", [
        ("Confirm request identity, customer and received date.", (.22, .15)),
        ("Use the tabs to review work orders and required material.", (.27, .31)),
        ("Read product, variant, quantity and current status.", (.45, .55)),
        ("Approve only the intended work order; Issue Stock is a separate operation.", (.87, .55)),
    ]),
    ("29-request-required-items", "Check required material lines", [
        ("Open Required Items from the request tabs.", (.45, .30)),
        ("Use Aggregated totals or Per-product breakdown for the question you need to answer.", (.35, .48)),
        ("Wait for the requirement calculation to finish before interpreting quantities.", (.63, .50)),
        ("If calculation remains stuck, refresh the request instead of acting on an incomplete view.", (.50, .62)),
    ]),
    ("32-issue-stock-form", "Record stock leaving Store", [
        ("Confirm the Issue Stock title and request number.", (.72, .05)),
        ("Search and add the exact material and variant being issued.", (.80, .17)),
        ("Enter a business reason for the stock leaving Store.", (.80, .26)),
        ("Review the line details, then use Submit Issue once.", (.88, .96)),
    ]),
    ("33-return-stock-form", "Return unused issued material", [
        ("Confirm the Return Stock title and original request number.", (.72, .05)),
        ("Search and add only material physically returning to Store.", (.80, .17)),
        ("Explain why the material is returning.", (.80, .26)),
        ("Review the line details, then use Submit Return once.", (.88, .96)),
    ]),
    ("03-purchase-orders", "Monitor physical-goods purchase orders", [
        ("Use New purchase order only after demand and budget gates are ready.", (.78, .15)),
        ("Read company-wide status counts separately from filtered rows.", (.30, .34)),
        ("Filter by status, supplier or search term.", (.40, .58)),
        ("When orders exist, open one from this register to issue, receive, amend or review history.", (.52, .67)),
    ]),
    ("27-new-purchase-order", "Create a purchase-order draft", [
        ("Confirm order date and purchasing context.", (.50, .41)),
        ("Choose the approved supplier and expected-delivery terms.", (.50, .54)),
        ("Add exact items, quantities, units and rates.", (.45, .70)),
        ("Review taxes, charges and vendor total.", (.84, .75)),
        ("Review notes and terms below, then save as Draft; issue only after approval.", (.45, .94)),
    ]),
    ("05-goods-receipts", "Receive goods against the purchase order", [
        ("Use this register for numbered goods receipts created against purchase orders.", (.28, .27)),
        ("Use search and status filters to find the exact receipt.", (.45, .45)),
        ("When a receipt row exists, open it to inspect, quarantine, reject or put away stock.", (.50, .58)),
        ("Use Deliveries only for older order-level records; new receipts belong here.", (.50, .38)),
    ]),
    ("04-service-orders", "Track non-stock service work", [
        ("Use status tabs to follow Draft through Accepted or Rework required.", (.38, .34)),
        ("Search by order, request or supplier.", (.79, .34)),
        ("A service order never creates a goods receipt or stock movement.", (.48, .19)),
        ("When completion is reported, the requester—not Store—accepts or asks for rework.", (.50, .44)),
    ]),
    ("06-reservations-picking", "Reserve, pick and issue material", [
        ("Use stage cards to separate ready, partial, short and completed demand.", (.40, .28)),
        ("Filter by request, department, warehouse and status.", (.43, .43)),
        ("Reserve only usable stock; shortages stay visible as backorders.", (.38, .60)),
        ("When requests appear, open a row to reserve, pick and issue from a real location.", (.50, .60)),
    ]),
    ("07-issues-returns", "Use the Issues and returns workspace", [
        ("Choose Issue or Credit stock according to the physical event.", (.84, .21)),
        ("Search for the exact material or variant before opening a record.", (.35, .49)),
        ("Use the Issues and Returns filters to confirm the movement direction.", (.83, .49)),
        ("When records exist, open the result and verify the immutable movement history.", (.52, .63)),
    ]),
    ("08-stock-counts", "Start and complete a stock count", [
        ("Choose the actual warehouse location being counted.", (.37, .26)),
        ("Choose Normal or Blind according to control policy.", (.69, .26)),
        ("Optionally narrow by item or SKU.", (.38, .34)),
        ("Start only after warehouse setup exists; later review and post differences.", (.55, .34)),
    ]),
    ("09-stock-movements", "Investigate stock movement history", [
        ("Choose the exact item before interpreting movement history.", (.35, .40)),
        ("Search by material name or SKU in the item chooser.", (.50, .46)),
        ("Variant and movement filters appear after an item is selected.", (.70, .43)),
        ("A filtered net is not the item's complete on-hand balance.", (.40, .32)),
    ]),
    ("10-stock-exceptions", "Resolve stock exceptions", [
        ("Filter by exception type, severity, warehouse or item.", (.35, .31)),
        ("Open the exception and read its evidence before acting.", (.38, .48)),
        ("Correct the source event through receipt, transfer, count, return or reversal.", (.48, .64)),
        ("Use Start stock count when the evidence requires a physical count.", (.86, .15)),
    ]),
    ("11-lot-labels", "Create traceable lot labels", [
        ("Select the item and exact variant—or Whole item / no variant.", (.25, .39)),
        ("Enter quantity per label with its unit.", (.52, .51)),
        ("Enter number of labels; this does not multiply or adjust stock.", (.52, .65)),
        ("Review the batch, then create and print once.", (.45, .83)),
    ]),
    ("12-materials", "Use the Materials register", [
        ("Search and filter by identity, stock status, category or type.", (.40, .38)),
        ("Open an item for variants, reorder policy, supplier references and movements.", (.45, .58)),
        ("Use Stock adjustment for opening or corrected stock—not the master form.", (.24, .19)),
        ("Add item creates reusable material identity only.", (.80, .19)),
    ]),
    ("28-new-material", "Create a material master record", [
        ("Enter a clear item name; the stable internal code is assigned on save.", (.40, .38)),
        ("Choose product type, category and base unit.", (.42, .76)),
        ("Confirm the base unit used for every stock quantity on this item.", (.40, .84)),
        ("Use the on-screen guide: current stock is entered through Stock adjustment, not here.", (.70, .64)),
        ("Use Add item only after reviewing the remaining sections below.", (.60, .95)),
    ]),
    ("13-finished-products", "Read finished products and BOM context", [
        ("Search the production-owned finished-product catalogue.", (.35, .42)),
        ("Choose the correct product row and then its variant.", (.25, .51)),
        ("Read BOM material requirements for planning and traceability.", (.56, .58)),
        ("Use the row's open action to inspect; make engineering changes in Production.", (.89, .70)),
    ]),
    ("15-suppliers", "Maintain supplier identity", [
        ("Search for duplicates before adding a supplier.", (.37, .44)),
        ("Open the supplier row to review legal, tax and contact information.", (.45, .58)),
        ("Use lifecycle status instead of deleting historical suppliers.", (.69, .58)),
        ("Use the row actions to open sourcing and order evidence.", (.77, .58)),
    ]),
    ("16-supplier-offers", "Compare dated supplier offers", [
        ("Separate Material, Outside service and Freight offers.", (.31, .26)),
        ("Filter by state and currency; search supplier or item identity.", (.45, .38)),
        ("Compare purchase unit, quoted price, tax basis, MOQ, lead time and validity.", (.51, .59)),
        ("Open the offer row for its complete commercial evidence.", (.90, .55)),
    ]),
    ("35-new-supplier-offer", "Record a supplier quotation", [
        ("Confirm that Step 1 is Supplier and item.", (.36, .35)),
        ("Search and select the exact supplier.", (.45, .44)),
        ("Select the exact item and variant from the master.", (.45, .54)),
        ("Record the supplier's item code and the purchase unit.", (.50, .64)),
        ("Continue through price, quantity, validity and review before saving.", (.68, .74)),
    ]),
    ("17-units", "Maintain units and conversions", [
        ("Enter the full unit name after confirming it does not already exist.", (.40, .33)),
        ("Add conversions only when another compatible unit is available.", (.40, .43)),
        ("Use the examples as guidance; every conversion is independent and must be defensible.", (.38, .57)),
        ("Review the name and conversions, then use Create unit once.", (.58, .72)),
    ]),
    ("18-warehouses", "Review warehouses and operational locations", [
        ("Switch between your company's warehouses and legacy records deliberately.", (.30, .36)),
        ("Search by warehouse name or code and filter by status.", (.50, .47)),
        ("When a row exists, open it to review receiving, inspection, usable, quarantine and returns locations.", (.50, .62)),
        ("Use Add warehouse only when the physical facility is defined.", (.76, .15)),
    ]),
    ("38-new-warehouse-form", "Create warehouse structure", [
        ("Enter a clear name and short company-unique code.", (.45, .31)),
        ("Record address and operational contact information.", (.45, .48)),
        ("Capacity describes the facility; it is not stock quantity.", (.45, .67)),
        ("Review the standard locations that will be created automatically.", (.45, .85)),
        ("Add only after the physical structure is correct.", (.61, .92)),
    ]),
    ("19-request-report", "Trace demand in the material request register", [
        ("Set status, type, source and priority filters first.", (.50, .50)),
        ("Read the population-scope sentence before using counts.", (.35, .55)),
        ("When requests exist, open their lines to follow reservations, POs, receipts or issues.", (.50, .65)),
        ("Open Request desk to start or continue live workflow.", (.86, .26)),
    ]),
    ("20-movement-report", "Use the movement report", [
        ("Choose period, transaction type and search scope.", (.48, .42)),
        ("Read movement totals and value moved as separate measures.", (.45, .50)),
        ("When rows exist, drill to source documents for unusual movements.", (.50, .75)),
        ("Do not call the filtered net movement an on-hand balance.", (.48, .72)),
    ]),
    ("21-purchase-exceptions", "Work the purchase exception queue", [
        ("Filter by search, exception, order status and attention state.", (.50, .48)),
        ("When an exception exists, open its PO, receipt, service order or voucher evidence.", (.50, .59)),
        ("Correct the actual condition instead of merely closing the warning.", (.50, .59)),
        ("Refresh and confirm the exception clears or records a remaining reason.", (.88, .15)),
    ]),
    ("22-inventory-valuation", "Review management inventory valuation", [
        ("Read the valuation-basis note before interpreting the figures.", (.50, .32)),
        ("Read known value, completeness and mismatch figures separately.", (.50, .41)),
        ("Expand an item row to inspect receipt and landed-cost evidence.", (.50, .92)),
        ("Use Partly unvalued and Indeterminate filters; missing evidence is not zero cost.", (.50, .80)),
    ]),
    ("23-settings", "Review Store operating settings", [
        ("Read which generated documents these Store details affect.", (.35, .28)),
        ("Enter the Store address in the order it should print.", (.35, .52)),
        ("Use PDF preview to verify the printed identity before saving.", (.64, .49)),
        ("Continue to Contact details below and save only verified information.", (.35, .94)),
    ]),
    ("24-legacy-purchase-forms", "Use legacy screens only for history", [
        ("Search or filter historical records when evidence is required.", (.40, .48)),
        ("Read the shown-record counts and scope honestly.", (.40, .40)),
        ("Use View or PDF on the row without creating new work.", (.87, .55)),
        ("Use the notice link to start all new demand in Request desk.", (.52, .28)),
    ]),
]


def wrap_lines(draw, text, fnt, width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        trial = word if not current else current + " " + word
        if draw.textlength(trial, font=fnt) <= width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


QUADRANT_CAPTURES = {
    "25-request-detail-open",
    "29-request-required-items",
    "32-issue-stock-form",
    "33-return-stock-form",
}


def visible_capture(stem, im):
    """Return the actual visible browser pixels.

    Earlier CUA captures were written into the upper-left quadrant of a 2x
    backing canvas.  Newer captures already contain only the visible viewport.
    Normalising here prevents blank backing-canvas space from becoming part of
    a guided screenshot.
    """
    w, h = im.size
    if stem in QUADRANT_CAPTURES and w >= 1700 and h >= 950:
        return im.crop((0, 0, w // 2, min(h // 2, 560)))
    return im


def annotate(stem, title, steps):
    src = SRC / f"{stem}.png"
    if not src.exists():
        return None
    source = visible_capture(stem, Image.open(src).convert("RGB"))

    # Build a fresh plate.  The complete visible viewport is scaled into the
    # left column; the instruction legend occupies a separate right column.
    # This is intentionally not drawn over half of the application screenshot.
    canvas_w, canvas_h = 2000, 1000
    ui_x, ui_y, ui_w, ui_h = 24, 24, 1230, 952
    panel_x, panel_y = 1280, 24
    panel_w, panel_h = canvas_w - panel_x - 24, canvas_h - 48

    scale = min(ui_w / source.width, ui_h / source.height)
    shown_w = max(1, round(source.width * scale))
    shown_h = max(1, round(source.height * scale))
    shown = source.resize((shown_w, shown_h), Image.Resampling.LANCZOS)
    shown_x = ui_x + (ui_w - shown_w) // 2
    shown_y = ui_y + (ui_h - shown_h) // 2

    im = Image.new("RGB", (canvas_w, canvas_h), WHITE)
    im.paste(shown, (shown_x, shown_y))
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle((ui_x, ui_y, ui_x + ui_w, ui_y + ui_h), radius=18, outline="#DDE4F2", width=2)
    draw.rounded_rectangle((panel_x, panel_y, panel_x + panel_w, panel_y + panel_h), radius=24, fill=PANEL, outline="#DDE4F2", width=2)
    title_font = font(31, True)
    body_font = font(22)
    num_font = font(23, True)
    draw.text((panel_x + 34, panel_y + 32), title, font=title_font, fill=INK)
    top = panel_y + 95
    gap = max(82, (panel_h - 145) // max(len(steps), 1))
    bubble_r = 21
    for idx, (copy, anchor) in enumerate(steps, 1):
        cy = top + (idx - 1) * gap + bubble_r
        cx = panel_x + 38
        draw.ellipse((cx - bubble_r, cy - bubble_r, cx + bubble_r, cy + bubble_r), fill=BLUE)
        n = str(idx)
        box = draw.textbbox((0, 0), n, font=num_font)
        draw.text((cx - (box[2]-box[0])/2, cy - (box[3]-box[1])/2 - 2), n, font=num_font, fill=WHITE)
        lines = wrap_lines(draw, copy, body_font, panel_w - 105)
        ty = cy - bubble_r + 1
        for line in lines:
            draw.text((cx + bubble_r + 16, ty), line, font=body_font, fill=MUTED)
            ty += int(body_font.size * 1.28)
        # Anchors are defined against the visible application viewport.  Map
        # them through the exact scale and offset used above so each marker is
        # physically attached to a real on-screen control or section.
        ax = shown_x + int(anchor[0] * shown_w)
        ay = shown_y + int(anchor[1] * shown_h)
        pin_r = bubble_r
        draw.line((ax, ay, panel_x - 10, cy), fill=LINE, width=3)
        draw.ellipse((ax-pin_r, ay-pin_r, ax+pin_r, ay+pin_r), fill=BLUE, outline=WHITE, width=3)
        pbox = draw.textbbox((0, 0), n, font=num_font)
        draw.text((ax-(pbox[2]-pbox[0])/2, ay-(pbox[3]-pbox[1])/2-2), n, font=num_font, fill=WHITE)
    out = OUT / f"{stem}-annotated.png"
    im.save(out, quality=94)
    return out


made = [annotate(*spec) for spec in SPECS]
made = [p for p in made if p]
print(f"Created {len(made)} annotated Store screenshots in {OUT}")
