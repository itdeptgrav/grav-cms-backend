from pathlib import Path
from datetime import date
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.section import WD_SECTION_START
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "GRAV-Store-and-Purchase-Complete-User-Guide.docx"

INK = "171717"
MUTED = "5F6368"
BLUE = "1D4ED8"
BLUE_PALE = "EEF2FF"
GREEN = "15803D"
AMBER = "B45309"
RED = "B42318"
HAIR = "D9DDE3"
WHITE = "FFFFFF"
FONT = "Arial"


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=90, start=110, bottom=90, end=110):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for m, v in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{m}"))
        if node is None:
            node = OxmlElement(f"w:{m}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(v))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def keep_row(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def add_page_field(paragraph):
    run = paragraph.add_run()
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.extend([fld_char1, instr, fld_char2])


def add_alt_text(shape, text):
    doc_pr = shape._inline.docPr
    doc_pr.set("descr", text)
    doc_pr.set("title", text[:80])


def setup_document():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Inches(8.5)
    sec.page_height = Inches(11)
    # Extra running-edge clearance prevents long split tables/lists from
    # colliding with the header and footer in LibreOffice's DOCX renderer.
    sec.top_margin = Inches(0.86)
    sec.bottom_margin = Inches(0.86)
    sec.left_margin = Inches(0.78)
    sec.right_margin = Inches(0.72)
    sec.header_distance = Inches(0.28)
    sec.footer_distance = Inches(0.28)
    sec.different_first_page_header_footer = False
    # A single running header/footer is intentional. LibreOffice can crop the
    # leading edge of image-heavy alternating pages when odd/even parts are
    # enabled, even if both parts contain identical text.
    doc.settings.odd_and_even_pages_header_footer = False

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(10.4)
    normal.font.color.rgb = RGBColor.from_string(INK)
    normal.paragraph_format.space_after = Pt(5.5)
    normal.paragraph_format.line_spacing = 1.08

    for name, size, color, before, after in [
        ("Title", 34, INK, 0, 16),
        ("Subtitle", 15, MUTED, 0, 10),
        ("Heading 1", 22, INK, 14, 8),
        ("Heading 2", 15, BLUE, 10, 5),
        ("Heading 3", 11.5, INK, 7, 3),
    ]:
        st = styles[name]
        st.font.name = FONT
        st.font.size = Pt(size)
        st.font.color.rgb = RGBColor.from_string(color)
        st.font.bold = name != "Subtitle"
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True

    for name in ("List Bullet", "List Number"):
        st = styles[name]
        st.font.name = FONT
        st.font.size = Pt(10.2)
        st.paragraph_format.left_indent = Inches(0.23)
        st.paragraph_format.first_line_indent = Inches(-0.15)
        st.paragraph_format.space_after = Pt(3)

    if "Lead" not in styles:
        lead = styles.add_style("Lead", WD_STYLE_TYPE.PARAGRAPH)
        lead.font.name = FONT
        lead.font.size = Pt(12.2)
        lead.font.color.rgb = RGBColor.from_string(MUTED)
        lead.paragraph_format.space_after = Pt(10)
        lead.paragraph_format.line_spacing = 1.12

    if "Caption Custom" not in styles:
        cap = styles.add_style("Caption Custom", WD_STYLE_TYPE.PARAGRAPH)
        cap.font.name = FONT
        cap.font.size = Pt(8.8)
        cap.font.color.rgb = RGBColor.from_string(MUTED)
        cap.font.italic = True
        cap.paragraph_format.space_before = Pt(4)
        cap.paragraph_format.space_after = Pt(8)
        cap.paragraph_format.keep_with_next = False

    # Populate every available part for compatibility, while the document-level
    # setting above keeps Word and LibreOffice on the single-header path.
    for header in (sec.header, sec.even_page_header, sec.first_page_header):
        para = header.paragraphs[0]
        para.text = "GRAV Store & Purchase · Complete user guide"
        para.style = doc.styles["Normal"]
        para.runs[0].font.size = Pt(8)
        para.runs[0].font.color.rgb = RGBColor.from_string(MUTED)
        para.alignment = WD_ALIGN_PARAGRAPH.RIGHT

    for footer in (sec.footer, sec.even_page_footer, sec.first_page_footer):
        para = footer.paragraphs[0]
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = para.add_run("Internal operating guide  ·  ")
        r.font.name = FONT
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor.from_string(MUTED)
        add_page_field(para)
    return doc


doc = setup_document()


def p(text="", style=None, bold_prefix=None, align=None):
    para = doc.add_paragraph(style=style)
    if bold_prefix and text.startswith(bold_prefix):
        para.add_run(bold_prefix).bold = True
        para.add_run(text[len(bold_prefix):])
    else:
        para.add_run(text)
    if align is not None:
        para.alignment = align
    return para


def lead(text):
    return p(text, "Lead")


def h1(text):
    return doc.add_heading(text, 1)


def h2(text):
    return doc.add_heading(text, 2)


def h3(text):
    return doc.add_heading(text, 3)


def bullets(items):
    for item in items:
        p(item, "List Bullet")


def steps(items):
    # Word's built-in List Number style may continue numbering across unrelated
    # procedures after LibreOffice renders the document. Each procedure in this
    # handbook must restart at 1, so use explicit numerals with a hanging indent.
    for idx, item in enumerate(items, 1):
        para = doc.add_paragraph()
        para.paragraph_format.space_after = Pt(3)
        n = para.add_run(f"{idx}.  ")
        n.bold = True
        para.add_run(item)


def table(headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False if widths else True
    t.style = "Table Grid"
    hr = t.rows[0]
    set_repeat_table_header(hr)
    keep_row(hr)
    for i, value in enumerate(headers):
        c = hr.cells[i]
        c.text = str(value)
        shade(c, INK)
        set_cell_margins(c)
        c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        for run in c.paragraphs[0].runs:
            run.font.bold = True
            run.font.color.rgb = RGBColor.from_string(WHITE)
            run.font.size = Pt(9)
    for ridx, row in enumerate(rows):
        tr = t.add_row()
        keep_row(tr)
        for i, value in enumerate(row):
            c = tr.cells[i]
            c.text = str(value)
            set_cell_margins(c)
            c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
            if ridx % 2:
                shade(c, "F6F7F9")
            for run in c.paragraphs[0].runs:
                run.font.size = Pt(8.7)
        if widths:
            for i, width in enumerate(widths):
                tr.cells[i].width = Inches(width)
    if widths:
        for i, width in enumerate(widths):
            hr.cells[i].width = Inches(width)
    p("")
    return t


def figure(filename, caption, alt, width=6.9):
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run()
    shape = run.add_picture(str(ASSETS / filename), width=Inches(width))
    add_alt_text(shape, alt)
    cp = p(caption, "Caption Custom")
    cp.alignment = WD_ALIGN_PARAGRAPH.CENTER


def note(label, text):
    para = doc.add_paragraph()
    para.paragraph_format.space_before = Pt(4)
    para.paragraph_format.space_after = Pt(7)
    r = para.add_run(label + "  ")
    r.bold = True
    r.font.color.rgb = RGBColor.from_string(BLUE)
    para.add_run(text)
    return para


def page_break():
    doc.add_page_break()


def photo_plate(number, title, filename, context, outcome, width=6.85):
    page_break()
    h2(f"{number}. {title}")
    p(context)
    figure(
        f"ui-annotated/{filename}",
        f"Actual Store & Purchase interface. Follow the numbered markers in order. Expected outcome: {outcome}",
        f"Annotated screenshot of the GRAV Store & Purchase interface for {title}. Numbered markers identify the controls and information used in the procedure.",
        width,
    )


def screen(name, nav, purpose, use_when, workflow, verify, mistakes, notes=None):
    h2(name)
    p(f"Where to find it: {nav}", bold_prefix="Where to find it:")
    p(purpose)
    h3("Use this screen when")
    bullets(use_when)
    h3("How to use it")
    steps(workflow)
    h3("Before you consider the work complete")
    bullets(verify)
    h3("Avoid")
    bullets(mistakes)
    if notes:
        note("Important", notes)


# Cover
p("GRAV", "Subtitle")
title = p("Store & Purchase", "Title")
title.paragraph_format.space_before = Pt(42)
p("Complete user guide", "Title")
lead("From an approved need to supplier order, receipt, location control, issue, return, valuation and the hand-off to Budget and Accounting.")
figure(
    "workflow-demand-to-payment.png",
    "The complete business chain. Store & Purchase owns the operational middle; it does not replace Requests, Budget or Accounting.",
    "Diagram showing request, Store decision, supplier sourcing, order, receiving, put-away, accounting match and payment.",
    6.7,
)
p("Prepared from the current GRAV Store & Purchase navigation and workflows", "Subtitle", align=WD_ALIGN_PARAGRAPH.CENTER)
p("Version date: 6 September 2026", align=WD_ALIGN_PARAGRAPH.CENTER)
p("Audience: Store team, buyers, requesters, department approvers, Finance, Accounting, auditors and system administrators", align=WD_ALIGN_PARAGRAPH.CENTER)
page_break()

# Front matter
h1("How to use this guide")
lead("Read Part I once to understand the system. Then use the workflow chapters while doing live work. The screen reference is for quick lookup; the checklists are for daily control.")
table(
    ["If you are…", "Start with", "Then keep open"],
    [
        ("Store operator", "Quick start; stock fulfilment; receiving; inventory operations", "Daily Store checklist"),
        ("Buyer", "Purchase goods; services; suppliers and offers", "Purchase-order and supplier-offer references"),
        ("Requester or department approver", "Requests; service acceptance; quantity/status vocabulary", "Request Desk and Service Orders"),
        ("Finance or Budget user", "Budget and Accounting connection", "Budget trace and exception reports"),
        ("Accountant", "Receipt/service evidence and supplier-voucher hand-off", "Accounting boundary and matching checklist"),
        ("Administrator", "Masters, locations, permissions and setup checklist", "Troubleshooting and legacy policy"),
    ],
    [1.45, 2.4, 3.1],
)
note("Scope", "This guide describes the Store & Purchase application as it exists now. It distinguishes current operational screens from legacy records and does not pretend that Store is the accounting ledger or the costing engine.")

h2("Ten rules that prevent most mistakes")
bullets([
    "Start demand in Request Desk. Do not create disconnected purchasing or stock activity when a request already exists.",
    "Choose the correct fulfilment path per line: reserve and issue existing stock, buy a physical item, or order a service.",
    "Use Materials for stock-tracked inputs, Finished products & BOM for the production catalogue, and Service master for non-stock work.",
    "Never type an opening or corrected stock balance into an item master. Stock changes through receipts, issues, returns, transfers, counts or adjustments.",
    "Never add quantities with different units. Metres, kilograms and pieces are separate measures unless a valid conversion exists.",
    "A purchase order orders goods; a goods receipt records what physically arrived and was accepted. They are not the same event.",
    "A service order never creates a goods receipt or stock movement. Completion must be reported and accepted.",
    "On hand is not available. Available is on hand less active reservations; picked stock has been prepared but not yet issued.",
    "Store supplies evidence to Budget and Accounting. Budget controls planned spend; Accounting posts the supplier voucher and payment.",
    "Use legacy screens only to read historical records or complete explicitly supported old work. Start new work in the current workflow.",
])

h2("Contents")
table(
    ["Part", "What it covers"],
    [
        ("I · System model", "Purpose, ownership, vocabulary, navigation, roles and setup"),
        ("II · Complete workflows", "Stock fulfilment, goods purchasing, service purchasing, receiving, returns and counts"),
        ("III · Screen-by-screen guide", "Every current navigation entry, including reports, settings and legacy"),
        ("IV · Cross-application control", "Budget, Accounting, costing, audit and exception handling"),
        ("V · Operating reference", "Status meanings, troubleshooting, checklists, glossary and route map"),
        ("VI · Photo-guided workflows", "Actual authenticated Store screens with numbered, step-by-step annotations"),
    ],
    [1.65, 5.3],
)
page_break()

# Part I
h1("Part I · Understand the system")
h2("1. What Store & Purchase is for")
p("Store & Purchase is the operational record of physical materials and procured services. It connects an approved business need to a supplier order, records what arrived or what work was accepted, and maintains the movement and location evidence needed to know what the company can use.")
h3("The application owns")
bullets([
    "Material identity, variants, units, reorder policy and stock-tracking attributes.",
    "Supplier identity and dated supplier offers for items, services and freight.",
    "Purchase orders for physical goods and service orders for non-stock work.",
    "Goods receipts, inspection outcomes, quarantine, put-away and supplier returns.",
    "Reservations, picking, issues, internal returns, transfers, cycle counts and immutable stock movements.",
    "Operational reports for movement, purchasing exceptions and management inventory valuation.",
])
h3("The application does not own")
bullets([
    "The employee's original need or department approval — Requests owns that.",
    "The definition of budget heads, appropriations and available budget — Budget owns that.",
    "Supplier invoices, recoverable GST, payables and payment — Accounting owns that.",
    "Finished-product engineering and BOM authoring — Production owns that; Store reads the catalogue.",
    "Final product profitability or income tax — Central Costing and Accounting own those calculations.",
])

h2("2. Navigation map")
figure(
    "service-orders-annotated-with-key.png",
    "Annotated current screen. The same top navigation pattern is used throughout Store & Purchase.",
    "Annotated Service Orders screen identifying the Purchase navigation, page heading, Refresh, status filters, search and explained error banner.",
    7.0,
)
table(
    ["Group", "Screens", "Question answered"],
    [
        ("Overview", "Overview", "What needs attention now?"),
        ("Requests", "Request desk", "What does the business need, and how will each line be fulfilled?"),
        ("Purchase", "Purchase orders; Service orders; Purchase forms — legacy", "What have we ordered from suppliers?"),
        ("Receive", "Goods receipts; Deliveries (legacy)", "What arrived, what was accepted and where did it go?"),
        ("Inventory", "Reservations & picking; Issues & returns; Stock counts; Stock movements; Stock exceptions; Lot labels & barcodes", "What stock is promised, moving, uncertain or traceable?"),
        ("Masters", "Materials; Finished products & BOM; Service master; Suppliers; Supplier offers; Units; Warehouses", "What reusable records define our items, services, suppliers and locations?"),
        ("Reports", "Request register; Movement report; Purchase exceptions; Inventory valuation", "What happened, what is late and what is the management value?"),
        ("Settings", "Store settings", "Which defaults and operating policies apply?"),
        ("Legacy & production", "Old PO sheets and production-linked screens", "How can historical/production records be read without using them as the new workflow?"),
    ],
    [1.1, 3.1, 2.75],
)

h2("3. Roles and separation of duties")
table(
    ["Role", "Normal work", "Must not do"],
    [
        ("Requester", "Describe the need, quantity, required date and justification; accept completed services", "Choose a supplier or alter stock"),
        ("Department approver", "Confirm need and priority", "Treat approval as proof of receipt"),
        ("Store operator", "Classify, reserve, pick, issue, receive, inspect, put away, return and count", "Post supplier bills or payments"),
        ("Buyer", "Source offers, compare terms and issue orders", "Invent item identity or bypass approved demand"),
        ("Finance/Budget", "Resolve heads, approve planned spend and monitor commitments", "Edit quantities received"),
        ("Accounting", "Match evidence, post supplier vouchers and settle suppliers", "Create warehouse movements"),
        ("Administrator", "Maintain access, company context and controlled masters", "Perform operational work merely to overcome a user's missing permission"),
        ("Auditor/reader", "Read records, history and reports", "Use read access to perform transitions"),
    ],
    [1.25, 3.15, 2.55],
)
note("Permission behaviour", "The screens and actions visible to a user depend on assigned capabilities. Being signed in is not the same as being authorised. Some mutations also need a linked staff identity because the history must name the person who acted.")

h2("4. Core vocabulary")
table(
    ["Term", "Exact meaning", "Common confusion"],
    [
        ("Material", "A physical, stock-tracked input or consumable.", "Not a finished product or service."),
        ("Variant", "A controlled version of a material, such as colour, size or grade.", "Variant quantities may use different units and must not be summed blindly."),
        ("Request", "The employee's need and approval record.", "Not an order to a supplier."),
        ("Supplier offer", "A dated, comparable price and terms from a supplier.", "Not a live master price and not a purchase order."),
        ("Purchase order", "The issued order for physical goods.", "Does not prove delivery or acceptance."),
        ("Service order", "The issued order for non-stock work.", "Never creates stock."),
        ("Goods receipt", "The factual record of goods received against a PO.", "Not the supplier invoice."),
        ("Inspection", "The decision to accept, quarantine or reject received quantity.", "Not optional when the receipt requires control."),
        ("Put-away", "Moving accepted stock into a usable warehouse location.", "Unassigned stock is on hand but has no location."),
        ("Reservation", "A promise of on-hand stock to approved demand.", "Does not reduce on-hand quantity."),
        ("Pick", "Preparing reserved stock for issue.", "Picked stock has not left Store."),
        ("Issue", "Confirming stock has left Store for the request/work.", "This changes stock."),
        ("Supplier return", "Sending rejected or damaged receipt quantity back to the supplier.", "Different from unused issued material returning to Store."),
        ("Stock movement", "Immutable evidence of a quantity change.", "Corrections are compensating movements, not silent edits."),
    ],
    [1.3, 3.25, 2.4],
)
figure(
    "inventory-quantity-states.png",
    "Quantity states. Quarantine and unassigned stock require their own operational decisions; they are not automatically available.",
    "Diagram defining on hand, reserved, available, picked, issued, returned, quarantine and unassigned inventory states.",
    6.9,
)

h2("5. Before the first transaction")
steps([
    "Confirm the company and site context shown by the application are correct. A record from another company must never be selected to solve a missing-data problem.",
    "Create or verify units of measure and only the conversions the business can defend.",
    "Create warehouses and locations, including receiving, inspection/quarantine, usable storage, returns and scrap locations as needed.",
    "Create material records with a stable internal item code, base unit, category, reorder policy and variants.",
    "Create services separately for non-stock work, subscriptions and charges; record the billing unit and classification.",
    "Create suppliers and record their approved/active state.",
    "Capture supplier offers so buyers compare dated facts rather than memory.",
    "Confirm Finance has mapped item, service or category identities to budget heads. This mapping is not maintained on the material editor.",
    "Confirm operational users have the capabilities for their duties and a linked staff identity where an action must be attributed.",
])
note("Existing data", "If a register is unexpectedly empty after company scoping is enabled, do not recreate hundreds of masters. First check whether historical records lack company identity and require a controlled migration.")
page_break()

# Part II workflows
h1("Part II · Complete workflows")
h2("6. Decide how to fulfil an approved request")
lead("The most important Store decision is made line by line. A single request may contain stockable materials, items that must be purchased and services that must be ordered.")
steps([
    "Open Requests → Request desk and find the approved request by number, requester, department or status.",
    "Open the record and read the need, quantity, unit, required date, notes and attachments before selecting an action.",
    "For each line, identify whether it is a stock-tracked material, a non-stock service or an unresolved description that still needs classification.",
    "For a material, select the exact material and variant. Check base unit, requested unit, on hand, active reservations and available quantity.",
    "If enough usable stock is available, choose the stock-fulfilment path. The application should create or expose a reservation rather than treating approval as an issue.",
    "If stock is insufficient or the item must be bought, choose the purchasing path and source/select an offer before creating the purchase order.",
    "For non-stock work, match the line to Service master and create a service order after the required approvals.",
    "Resolve the budget allocation before the approval gate that creates a commitment. An unresolved head is an exception, not a reason to assign an arbitrary head.",
    "Confirm each line has one visible outcome and no duplicate operational document.",
])
h3("Decision guide")
table(
    ["Question", "Yes", "No"],
    [
        ("Is it physical and stock tracked?", "Material path", "Service path"),
        ("Is usable available stock sufficient?", "Reserve → pick → issue", "Purchase path"),
        ("Is there a current comparable supplier offer?", "Use it as sourcing evidence", "Capture offers before selection"),
        ("Has the budget identity resolved?", "Proceed to the appropriate approval", "Stop and resolve mapping/allocation"),
        ("Has an order already been created for the same request line?", "Open the existing order", "Create only after all gates pass"),
    ],
    [2.45, 2.2, 2.2],
)

h2("7. Fulfil from existing stock")
steps([
    "From Request Desk, open the approved material line and inspect availability by item, variant and location.",
    "Create a reservation for the approved quantity. If only part is available, reserve only that part and keep the shortage visible.",
    "Open Inventory → Reservations & picking. Filter to the request or reservation and review its state.",
    "Select a source location containing usable stock. Quarantine, scrap and unassigned quantity must not be treated as freely available.",
    "Pick the quantity. Picking records preparation; it does not yet reduce on hand.",
    "Confirm issue only when the material physically leaves Store. This creates the stock movement and closes or reduces the reservation.",
    "If unused material comes back, record an internal return against the issue. Do not create an unrelated positive adjustment.",
    "Verify the request line, reservation, movement and location balances agree.",
])
h3("What can go wrong")
bullets([
    "Available becomes lower between reservation and pick because another valid transaction posted; refresh and resolve the shortage.",
    "Requested and base units differ without an approved conversion; stop rather than assuming 1:1.",
    "The line is linked to the wrong variant; correct the classification before issue.",
    "A user tries to edit the original movement; use a reversal/corrective movement with a reason.",
])

h2("8. Purchase physical goods")
figure(
    "masters-and-documents.png",
    "Masters define identity; documents freeze the dated business event. A supplier offer belongs to sourcing, while a purchase order belongs to commitment and fulfilment.",
    "Diagram separating Materials, Finished products, Service master and Suppliers from supplier offers, warehouses, purchase orders and service orders.",
    6.8,
)
steps([
    "Confirm the request line is an exact material/variant with a defensible quantity and unit.",
    "Open Masters → Supplier offers and compare active offers for price, quoted unit, taxes/terms where recorded, lead time and validity.",
    "Select the supplier based on the approved commercial decision. Record the reason when the lowest price is not selected.",
    "Create the purchase order from the approved demand so request-line identity, item identity, quantity, unit, price and budget identity remain connected.",
    "Review the draft: supplier, delivery destination, dates, lines, units, rate, taxes/charges as supported, terms and references.",
    "Issue the purchase order. An issued order is a historical commercial commitment; do not silently overwrite it. Use cancellation or amendment where supported.",
    "Monitor status and expected delivery. Use Purchase exceptions for overdue or inconsistent orders.",
    "When goods arrive, receive against the purchase order. Never increase item stock directly to simulate a receipt.",
])
h3("Purchase-order completion check")
bullets([
    "The supplier and company match.",
    "Every line points to the intended material and variant.",
    "Quantities and price units are explicit and convertible where necessary.",
    "The delivery warehouse/location is valid.",
    "The request line and budget allocation remain traceable.",
    "Issued, partially received, completed, cancelled or amended state is honest.",
])

h2("9. Receive, inspect and put away goods")
steps([
    "Open Receive → Goods receipts, or use Receive from the purchase-order detail.",
    "Choose the correct purchase order and verify supplier, item, variant and outstanding quantity.",
    "Enter what physically arrived per PO line. Record quantity and unit at line level; never rely on a receipt-wide number that mixes units.",
    "Record supplier invoice/delivery references, receipt date and destination as requested by the screen.",
    "Submit the receipt once. If the response is uncertain, use the same retry path; do not create another receipt to be safe.",
    "Inspect controlled goods. Mark accepted, quarantined/rejected and damaged quantities explicitly.",
    "Put accepted stock into its actual usable location. Resolve any unassigned quantity instead of leaving it invisible to warehouse control.",
    "Create a supplier return for rejected/damaged quantity when it is physically returned.",
    "Verify the receipt lines, PO outstanding quantities, location balances and stock movements agree.",
])
h3("Partial, excess and mixed-unit receipts")
bullets([
    "A partial receipt leaves an outstanding quantity on the PO; it does not close the line.",
    "An over-receipt is shown as quantity received beyond ordered, not as a negative remaining quantity.",
    "Two lines with no recorded unit are counted as two incomplete lines; their numbers are not totalled.",
    "A receipt with metres, kilograms and pieces has no meaningful receipt-wide quantity. Review each line or totals by unit.",
])

h2("10. Purchase and accept a service")
steps([
    "Classify the request line against an active Service master record before Finance approval.",
    "Confirm service code, name, billing unit, SAC/classification where recorded, supplier requirements and budget head.",
    "Capture and compare service offers if the purchase requires sourcing.",
    "Create the service order from the approved request. No stock item, warehouse or goods receipt is involved.",
    "Issue the service order to the supplier and monitor Draft → Issued → In progress.",
    "When the supplier reports completion, review the evidence, deliverable, period and quantity/rate basis.",
    "The requesting department accepts the work or marks Rework required. Acceptance is the factual evidence Accounting needs.",
    "Accounting matches the accepted service to the supplier voucher. Payment remains outside Store.",
])
h3("Service-order states")
table(
    ["State", "Meaning", "Normal next action"],
    [
        ("Draft", "Prepared but not sent as a binding order", "Review and issue"),
        ("Issued", "Sent to the supplier", "Supplier starts/acknowledges work"),
        ("In progress", "Work has started", "Monitor delivery"),
        ("Completion reported", "Supplier says the work is complete", "Requester verifies outcome"),
        ("Accepted", "Business accepts the delivered service", "Accounting match"),
        ("Rework required", "Delivered work is not accepted", "Supplier corrects and reports again"),
        ("Cancelled", "Order will not proceed", "Record reason; no acceptance"),
    ],
    [1.4, 3.15, 2.3],
)
note("Identity requirement", "Reading company-scoped Service Orders should depend on read permission. Mutating a service order still requires a linked staff record because the transition history must name the actor.")

h2("11. Transfer stock between locations")
steps([
    "Confirm the source location, destination location, material, variant, quantity and unit.",
    "Check that the source has sufficient usable on-hand quantity after active reservations.",
    "Use the location transfer workflow; do not create a negative adjustment at the source and a positive adjustment at the destination.",
    "Submit once and retain the operation reference. A retry must replay the same result, not post a second transfer.",
    "Verify the paired movement evidence and both location balances.",
])

h2("12. Count and correct stock")
steps([
    "Open Inventory → Stock counts and create a count for the intended warehouse/location and scope.",
    "Choose normal or blind counting according to policy. In a blind count, counters should not be influenced by system quantity.",
    "Record each observed item/variant with quantity and unit. Add unexpected stock explicitly rather than attaching it to a similar SKU.",
    "Save progress, then submit for review. Review differences, unit issues, reservations and movement timing.",
    "Approve/post the count only after the cut-off and evidence are sound.",
    "Posting creates adjustment movements for accepted differences. It must not rewrite movement history.",
    "Investigate material differences through Stock exceptions and document the reason.",
])
h3("Count controls")
bullets([
    "Freeze or control movement timing around the count.",
    "Count by location and item identity, not by description alone.",
    "Do not convert missing units or variants by assumption.",
    "A zero count is an observation; a blank quantity is incomplete data.",
    "Recount large differences before posting.",
])

h2("13. Return flows")
table(
    ["Return type", "When used", "Operational effect"],
    [
        ("Internal material return", "Unused material returns from a department/work order", "Adds usable stock back against the original issue"),
        ("Supplier return", "Rejected or damaged received goods go back to supplier", "Reduces the appropriate received/quarantine quantity and preserves PO/receipt lineage"),
        ("Cancellation before movement", "A prepared action should not proceed", "Changes document state; no stock movement should be invented"),
        ("Correction after movement", "A posted movement was wrong", "Append a compensating/reversal movement with actor, time and reason"),
    ],
    [1.6, 3.0, 2.25],
)
page_break()

# Part III screens
h1("Part III · Screen-by-screen guide")
screen(
    "14. Overview",
    "Overview",
    "The operational landing page. It should surface work that needs a decision instead of behaving as a decorative dashboard.",
    ["Beginning a Store or buyer shift", "Checking pending requests, receipts, shortages or exceptions", "Navigating to the next operational queue"],
    [
        "Read every attention card and its population/date scope.",
        "Open the highest-risk queue first: blocked receipts, stock exceptions, overdue orders or approved demand without fulfilment.",
        "Use links on the cards rather than recreating a filtered search manually.",
        "Refresh after another user completes related work.",
    ],
    ["Every urgent card is either acted on, assigned or acknowledged", "Counts reconcile with the destination register and filters"],
    ["Treating the cards as accounting totals", "Ignoring the date or loaded-record scope of a figure"],
)

screen(
    "15. Request desk",
    "Requests → Request desk",
    "The working queue for approved demand. Store classifies each line and decides whether it will be fulfilled from stock, purchased as goods or ordered as a service.",
    ["An approved request reaches Store", "A request line is unresolved", "You need to inspect fulfilment, budget or downstream document lineage"],
    [
        "Search by request number, requester or department and narrow by status.",
        "Open the request drawer/detail and read the requirement before choosing a master record.",
        "Match each line to one material/variant or one service.",
        "Review available stock and reservations for material lines.",
        "Select the correct fulfilment action and retain the source request-line identity.",
        "Resolve missing budget allocation with Finance before the commitment gate.",
        "Confirm the downstream reservation, PO or service order is visible.",
    ],
    ["Every active line has an honest classification and outcome", "Shortage and unresolved budget states remain visible", "No line was converted twice"],
    ["Choosing a similar SKU because the exact material is missing", "Classifying a service as a material", "Using a legacy purchase form for new work"],
)

screen(
    "16. Purchase orders",
    "Purchase → Purchase orders",
    "The register and detail workspace for physical-goods orders.",
    ["Preparing, issuing or monitoring a PO", "Receiving against an order", "Reviewing partial receipt, cancellation or exception history"],
    [
        "Filter by status, supplier or search term.",
        "Open the order and verify source request, supplier, item lines, units, rate, delivery destination and dates.",
        "Issue only after commercial and budget gates are satisfied.",
        "Use Receive for actual delivery; use cancellation/amendment actions for a changed commitment.",
        "Review receipts and remaining quantities line by line.",
    ],
    ["Issued document is historically stable", "Received/outstanding quantities make sense per unit", "Order and receipt references remain linked"],
    ["Editing an issued commercial fact silently", "Recording services on a PO", "Treating All orders minus other statuses as a cancelled count"],
)

screen(
    "17. Service orders",
    "Purchase → Service orders",
    "The register for non-stock work from an approved service request through supplier completion and requester acceptance.",
    ["Ordering repairs, subscriptions, consulting, freight-like non-stock work or other services", "Monitoring completion or rework", "Providing acceptance evidence to Accounting"],
    [
        "Use status filters or search by order number, request or supplier.",
        "Open the order and confirm service identity, scope, supplier, value/basis and requester.",
        "Issue the order and move it to In progress when work starts.",
        "Record completion evidence when the supplier reports completion.",
        "Have the requesting department accept or require rework.",
        "Refresh after another participant completes a transition.",
    ],
    ["Accepted service has identifiable evidence and actor", "No goods receipt or stock movement exists", "The supplier voucher can trace the accepted service"],
    ["Creating a GRN for a service", "Accepting work merely because an invoice arrived", "Retrying an explained staff-link blocker"],
    "The screen annotation earlier shows status filters, search and error behaviour. A temporary server failure may merit Refresh; an explained account or data blocker needs correction, not repeated retries.",
)

screen(
    "18. Purchase forms — legacy",
    "Purchase → Purchase forms — legacy",
    "A historical register for purchase forms and petty-cash records created through the earlier material-request workflow.",
    ["Looking up an old form", "Downloading historical evidence", "Following a source-request link from an old record"],
    [
        "Search or filter the historical register.",
        "Open a form to review line items, recorded petty cash, linked request and any linked PO.",
        "Download the record if documentary evidence is required.",
        "For new demand, leave this screen and use Request Desk.",
    ],
    ["Historical figures are read with their register scope", "A converted form without a linked PO is not presented as if a PO exists"],
    ["Creating new purchasing work here", "Assuming the first 200 loaded forms are the complete history", "Treating blank petty cash as zero"],
    "Legacy means retained historical workflow, not invalid data. New transactions should not be initiated through it.",
)

screen(
    "19. Goods receipts",
    "Receive → Goods receipts",
    "The authoritative line-level register of physical goods received against purchase orders.",
    ["Receiving a PO", "Inspecting or putting away received goods", "Reviewing partial, excess, damaged, quarantined or returned quantity"],
    [
        "Start from the correct PO or select it in the receipt flow.",
        "Enter actual quantity per line with unit and references.",
        "Review before submitting; a receipt changes operational evidence.",
        "Complete required inspection decisions.",
        "Put accepted stock away into the actual location.",
        "Open the receipt later to review line allocation, returns and movement evidence.",
    ],
    ["Every number has an item and unit", "Accepted, rejected/quarantined and returned quantities reconcile", "No duplicate receipt was created on retry"],
    ["Typing one total for mixed units", "Receiving the ordered quantity instead of the arrived quantity", "Leaving accepted stock unassigned indefinitely"],
)

screen(
    "20. Deliveries (legacy)",
    "Receive → Deliveries (legacy)",
    "A read-oriented view of older delivery records. Some historical rows contain only a receipt-wide quantity that cannot identify which PO lines arrived.",
    ["Investigating an old delivery", "Reading historical order-lifetime information", "Following return evidence on a legacy record"],
    [
        "Search and filter the register.",
        "Expand a record and distinguish receipt contents from order-lifetime lines.",
        "Where the screen says Not itemised, do not infer which items arrived.",
        "Use the current Goods receipts workflow for new receiving.",
    ],
    ["Mixed or missing units are not totalled", "Over-receipt is visible where computable", "Unitemised history remains labelled honestly"],
    ["Using the unit-less aggregate as a reconciled receipt quantity", "Creating new work through the legacy screen"],
)

screen(
    "21. Reservations & picking",
    "Inventory → Reservations & picking",
    "The fulfilment queue between approved material demand and confirmed issue.",
    ["Allocating stock to a request", "Picking from locations", "Resolving shortage, expiry or cancellation"],
    [
        "Filter the queue to the request, status, item or date.",
        "Open the reservation and check item, variant, requested quantity, reserved quantity and available stock.",
        "Reserve from usable stock; keep any shortage explicit.",
        "Pick from a real source location.",
        "Confirm issue only when stock physically leaves.",
        "Cancel/expire only with the recorded business reason.",
    ],
    ["Reservation and pick never make stock negative", "Issue creates one immutable movement", "Request-line identity remains present"],
    ["Treating reserved as issued", "Picking quarantine stock", "Submitting twice after an uncertain response"],
)

screen(
    "22. Issues & returns",
    "Inventory → Issues & returns",
    "The operational workspace for stock leaving Store and unused issued material returning.",
    ["Confirming an approved issue", "Recording an internal return", "Reviewing the history of an issue"],
    [
        "Prefer the reservation/picking path for request fulfilment.",
        "Select exact material, variant, quantity, unit and source location.",
        "Confirm the linked demand and recipient.",
        "Submit the issue once.",
        "For a return, reference the original issue and record the quantity physically returned.",
    ],
    ["On-hand and location movements reconcile", "The request/issue/return chain is visible", "Correction evidence is append-only"],
    ["Using a standalone issue to bypass a request", "Returning to an arbitrary SKU", "Editing the original movement"],
)

screen(
    "23. Stock counts",
    "Inventory → Stock counts",
    "The controlled cycle-count and stocktake workflow.",
    ["Starting a location count", "Recording observations", "Reviewing and posting count differences"],
    [
        "Create the count with warehouse, location, scope and count method.",
        "Enter observations by exact item/variant and unit.",
        "Save incomplete work; do not post it.",
        "Submit for review and investigate differences.",
        "Approve/post accepted differences to create movements.",
        "Cancel an invalid count rather than manipulating observations to make it agree.",
    ],
    ["Count status is correct", "Unexpected items and zero counts are explicit", "Every posted difference has actor, time and reason"],
    ["Counting while uncontrolled movements continue", "Copying system quantity into a blind count", "Posting unexplained major differences"],
)

screen(
    "24. Stock movements",
    "Inventory → Stock movements",
    "The item/variant movement ledger used to explain how stock changed over time.",
    ["Investigating a balance", "Following receipt, issue, return, transfer or adjustment history", "Reviewing a corrective movement"],
    [
        "Search and select the exact item.",
        "Choose All variants or one valid variant.",
        "Apply direction/type/date filters and read the scope sentence.",
        "Review each movement's date, type, quantity, unit, reference and location context.",
        "Open the source document where available.",
    ],
    ["Filtered rows are not mistaken for the whole balance", "Variant filters genuinely match the item", "Corrections point back to their originals"],
    ["Calling a filtered net figure the current stock balance", "Summing across units", "Assuming row order proves an unbroken sequence"],
)

screen(
    "25. Stock exceptions",
    "Inventory → Stock exceptions",
    "The queue for inventory conditions requiring investigation or an operational correction.",
    ["Finding negative/uncertain balances, location gaps, blocked movements or control mismatches", "Assigning and resolving inventory follow-up"],
    [
        "Filter by exception type, severity, status, warehouse or item.",
        "Open the exception and read the evidence and suggested next step.",
        "Follow the source record rather than repairing the displayed symptom blindly.",
        "Perform the legitimate receipt, transfer, return, count or corrective movement.",
        "Resolve the exception only when evidence and balances agree.",
    ],
    ["Resolution names the root cause and action", "No history was deleted", "Related exceptions are not left contradictory"],
    ["Posting a manual adjustment before understanding the cause", "Closing an exception because the current balance looks plausible"],
)

screen(
    "26. Lot labels & barcodes",
    "Inventory → Lot labels & barcodes",
    "Creates traceable physical labels for received or stored quantities. Printing a label does not receive or adjust stock.",
    ["Labelling a lot, container or stored quantity", "Reprinting the latest created batch"],
    [
        "Select the item.",
        "Choose a variant or explicitly choose Whole item / no variant.",
        "Enter Quantity per label with unit.",
        "Enter Number of labels and optional purchase-order reference.",
        "Review item, SKU, variant, quantity per label, label count and PO reference.",
        "Create and print. Use Reprint to reuse created IDs; Create another batch starts fresh.",
    ],
    ["A label quantity is not multiplied into stock", "Every label carries the intended identity and unit", "A partial creation failure is understood before retry"],
    ["Reading Number of labels as a stock quantity", "Printing a label to fix stock", "Recreating a successful batch because the print dialog failed"],
)

screen(
    "27. Materials",
    "Masters → Materials",
    "The stock-tracked item master for raw materials, consumables and other physical inputs used across purchase, Store and production.",
    ["Creating/editing a material", "Reviewing variants, reorder policy, supplier references or stock history", "Opening stock adjustment or PO actions from an item"],
    [
        "Search the register by item identity and use stock-status filters where needed.",
        "Open an item to review base unit, category, reorder points, variants, supplier references and movements.",
        "For a new item, enter name, category, base unit, reorder minimum and target maximum; the internal code is assigned on save.",
        "Add controlled attributes/variants only when they change operational identity.",
        "Save the item with zero stock. Enter opening or corrected quantity through a stock operation.",
    ],
    ["Stable internal item code exists", "Base unit and category are correct", "Variants are counted, not added across mixed units", "Budget mapping is resolved in Finance, not assumed from this form"],
    ["Creating duplicates for spelling differences", "Putting finished goods or services here", "Typing opening stock into the master", "Expecting budget-head fields on the item editor"],
)

screen(
    "28. Finished products & BOM",
    "Masters → Finished products & BOM",
    "A Store-facing, read-only view of the production catalogue and bill-of-material context.",
    ["Confirming the finished product a material demand belongs to", "Reading BOM context for issue, planning or costing traceability"],
    [
        "Search/select the finished product.",
        "Review product identity, variants and BOM lines.",
        "Follow production-owned links for engineering changes.",
        "Use material masters and stock operations for physical inputs.",
    ],
    ["The correct product/BOM version is being read", "No Store action is mistaken for BOM authoring"],
    ["Editing production engineering from Store", "Using finished-product identity as a raw-material SKU"],
)

screen(
    "29. Service master",
    "Masters → Service master",
    "The reusable catalogue for non-stock work, subscriptions and charges.",
    ["Creating a service identity", "Classifying a service request", "Maintaining billing and tax classification"],
    [
        "Create a unique service code and clear business name.",
        "Choose the billing unit that suppliers and requesters understand.",
        "Record SAC/tax classification and default commercial information where supported.",
        "Activate only when the service is ready for selection.",
        "Retire/deactivate obsolete services without erasing historical orders.",
    ],
    ["Requests can match the service before Finance approval", "The service never appears as on-hand stock", "Historical orders retain their frozen identity"],
    ["Creating a material for non-stock work", "Using free text after a master exists", "Deleting a service used by history"],
)

screen(
    "30. Suppliers",
    "Masters → Suppliers",
    "The controlled master for organisations that provide goods or services.",
    ["Onboarding or reviewing a supplier", "Checking status, contacts or assessment", "Opening sourcing/order history"],
    [
        "Search for duplicates by legal/trade name and tax identity before creating.",
        "Record legal identity, contact and commercial information.",
        "Complete approval/assessment fields required by company policy.",
        "Activate the supplier for new sourcing only after checks pass.",
        "Deactivate rather than delete a supplier with history.",
    ],
    ["Supplier belongs to the correct company", "Active status is justified", "Sensitive changes retain audit history"],
    ["Creating one supplier per spelling or branch without policy", "Treating an inactive supplier as selectable", "Using supplier master price as a dated quotation"],
)

screen(
    "31. Supplier offers",
    "Masters → Supplier offers",
    "Dated sourcing evidence for materials, services and freight.",
    ["Comparing suppliers", "Recording a quoted unit/rate, lead time, terms or validity", "Selecting evidence for a PO or service order"],
    [
        "Choose Item, Service or Freight according to the thing quoted.",
        "Select the supplier and exact master identity.",
        "Record quoted quantity/unit, rate, currency/terms, lead time and validity where supported.",
        "Compare like with like; convert units only through valid conversions.",
        "Select the offer for the order and retain its snapshot.",
    ],
    ["The offer was valid at selection time", "Quoted unit and order unit reconcile", "Selection reason is defensible"],
    ["Overwriting old offers to make them current", "Comparing rates in incompatible units", "Treating an offer as proof of order or delivery"],
)

screen(
    "32. Units of measure",
    "Masters → Units of measure",
    "The controlled vocabulary and conversions used by items, offers, orders, receipts and movements.",
    ["Adding a unit", "Defining a conversion", "Diagnosing a unit mismatch"],
    [
        "Use an unambiguous name and symbol.",
        "Define conversions only within a defensible measurement family or item-specific rule supported by the system.",
        "Test both directions and zero/decimal behaviour.",
        "Review affected item and offer records before changing an active conversion.",
    ],
    ["Missing conversion causes a refusal, not silent 1:1", "Zero or invalid factors cannot pass", "Rendered quantities always show a unit or say it is missing"],
    ["Converting metre to piece without an item-specific basis", "Reusing a symbol for different meanings", "Changing a factor to fix one transaction"],
)

screen(
    "33. Warehouses & locations",
    "Masters → Warehouses",
    "The physical hierarchy for receiving, inspection, usable storage, returns, quarantine and other controlled stock locations.",
    ["Creating warehouse structure", "Putting away, transferring or counting stock", "Reviewing capacity and location history"],
    [
        "Create the warehouse and its locations with clear codes and operational purpose.",
        "Distinguish receiving/inspection/quarantine from usable pick locations.",
        "Configure capacity only with compatible units and a defensible basis.",
        "Use transfers/put-away to move stock between locations.",
        "Retire locations only after active stock and work are resolved.",
    ],
    ["Every on-hand quantity has a valid location or is explicitly Unassigned", "Quarantine cannot be picked as usable", "Location history is preserved"],
    ["Using a warehouse total as a bin location", "Comparing capacity across incompatible units", "Deleting a location with stock/history"],
)

screen(
    "34. Material request register",
    "Reports → Material request register",
    "A report view of request demand and fulfilment status.",
    ["Reviewing request throughput", "Tracing a line to reservation, PO, receipt or issue", "Finding unresolved demand"],
    [
        "Set the required date/status/department filters.",
        "Read the scope and loaded-result limit.",
        "Open source or downstream documents for evidence.",
        "Export only after filters and units are understood.",
    ],
    ["Counts use the visible population", "Mixed units remain separate", "Unresolved lines are not hidden by summary totals"],
    ["Calling a filtered count the all-time total", "Using the report to mutate source records"],
)

screen(
    "35. Movement report",
    "Reports → Movement report",
    "The reporting view of receipts, issues, returns, transfers, counts and adjustments.",
    ["Period review", "Movement-type analysis", "Audit support"],
    [
        "Choose company/site, period, item/variant and movement type as required.",
        "Read quantity with unit and value basis separately.",
        "Drill to source documents for unusual movements.",
        "Export the filtered population with its scope.",
    ],
    ["Opening/closing logic and filters are understood", "Correction pairs are included", "No filtered net is called on-hand balance"],
    ["Summing quantities across units", "Assuming report order proves no missing movement"],
)

screen(
    "36. Purchase exceptions",
    "Reports → Purchase exceptions",
    "The control queue for overdue, blocked, inconsistent or incomplete purchasing activity.",
    ["Chasing late orders", "Finding unmatched receipt/order conditions", "Prioritising buyer follow-up"],
    [
        "Filter by exception type, age, supplier or owner.",
        "Open the source PO/service order/receipt.",
        "Resolve the actual operational condition.",
        "Refresh and confirm the exception clears or records the remaining reason.",
    ],
    ["Each exception has an owner and next action", "False completion is not used to make the queue green"],
    ["Closing an order simply because it is old", "Treating a supplier delay as a stock adjustment"],
)

screen(
    "37. Inventory valuation",
    "Reports → Inventory valuation",
    "A management valuation based on accepted operational movements, including landed-cost overlays where available.",
    ["Reviewing inventory value", "Explaining base versus landed value", "Identifying missing valuation evidence"],
    [
        "Choose the valuation date and required scope.",
        "Review quantity, base value and landed/effective value separately.",
        "Drill to receipt and landed-cost allocation evidence.",
        "Treat missing or unavailable inputs as exceptions, not zero cost.",
    ],
    ["Values use accepted/applied movements only", "Variant and receipt identity are distinguishable", "Management valuation is not presented as statutory closing stock"],
    ["Using off-bill manual charges as landed cost", "Allocating recoverable GST into product cost", "Calling an estimate the accounting ledger"],
)

screen(
    "38. Settings",
    "Settings",
    "Company/site defaults and Store operating preferences.",
    ["Reviewing configuration before go-live", "Changing a documented operating default"],
    [
        "Read the current value and the business process it controls.",
        "Confirm who will be affected.",
        "Change one policy at a time with approval.",
        "Test the downstream request/order/receipt behaviour.",
    ],
    ["The change is documented and effective from a known date", "Historical records retain their original facts"],
    ["Using settings to repair one bad transaction", "Changing defaults without testing live workflow"],
)

h2("39. Legacy & production group")
p("This group is deliberately separated from the current operational journey. It includes PO sheets (legacy print), work-order sheets, machine operations, devices & machines and assigned team.")
table(
    ["Screen type", "Use it for", "Do not use it for"],
    [
        ("PO sheets — legacy print", "Printing or reading older PO sheet formats", "Starting a new purchasing workflow"),
        ("Work-order sheets", "Reading/printing production-linked work information", "Replacing Request Desk or Store reservations"),
        ("Machine operations", "Production execution context", "Recording supplier purchases"),
        ("Devices & machines", "Production equipment records", "Material item identity"),
        ("Assigned team", "Production staffing context", "Store access administration"),
    ],
    [1.8, 2.6, 2.4],
)
note("Legacy policy", "Legacy records remain valid history. Restrict new creation, retain read/search/export needed for audit, and migrate outstanding work deliberately. Do not delete old records merely because the current workflow is better.")
page_break()

# Part IV
h1("Part IV · Budget, Accounting and costing")
h2("40. Where budget sits")
figure(
    "budget-accounting-connection.png",
    "The item-wise budget chain. The budget allocation belongs to the request/commitment identity; the Store item editor is not the budget-maintenance screen.",
    "Diagram showing request line, budget allocation, commitment, purchase or service order, accepted receipt/service, supplier voucher, budget settlement and payment.",
    6.9,
)
p("Budget is the financial control layer around planned spend. Store supplies the operational identity — item or service, quantity, supplier order and acceptance evidence — but the budget application decides which head and period fund the line and whether enough budget is available.")
h3("Item-wise and service-wise allocation")
steps([
    "A material or service is mapped to a default budget head through Finance-controlled mapping. A more specific item override takes precedence over a category/default mapping.",
    "When a request line is created/classified, the system resolves the allocation and stores the chosen head, period and resolution evidence.",
    "Approval creates or updates a commitment against that budget. The commitment is planned/approved spend, not an accounting actual.",
    "The PO or service order carries the request-line and allocation identity downstream.",
    "An accepted receipt or accepted service establishes the factual operational quantity.",
    "Accounting posts the supplier voucher. That posting is the actual financial event; recoverable GST remains separate from product/service cost.",
    "The budget commitment releases or settles against the posted actual according to Budget rules.",
])
note("Why you do not see budget on Add item", "The material editor defines reusable stock identity. Putting a budget head there as an editable Store field would let Store redefine Finance policy. Budget mapping and exceptions belong in Finance/Budget screens; Store should show the resolved result on the request/order trace where it matters.")

h2("41. Store to Accounting hand-off")
table(
    ["Evidence", "Store responsibility", "Accounting use"],
    [
        ("Purchase order", "Approved supplier, item/service, quantity, rate and terms", "Commercial match"),
        ("Goods receipt", "Actual physical quantity received and accepted/rejected", "Quantity match and accrual evidence"),
        ("Service acceptance", "Requester confirms delivered work", "Service quantity/completion match"),
        ("Supplier return", "Quantity and reason returned", "Debit-note/credit adjustment evidence"),
        ("Landed-cost allocation", "Traceable allocation to eligible receipts", "Management valuation support; accounting treatment remains Accounting's"),
        ("Supplier voucher", "Not created by Store", "Posted payable, tax and actual expense/inventory"),
        ("Payment", "Not created by Store", "Supplier ledger settlement"),
    ],
    [1.55, 3.0, 2.25],
)
h3("Three-way match for goods")
bullets([
    "PO: what the company authorised and ordered.",
    "Accepted receipt: what physically arrived and was accepted.",
    "Supplier voucher: what the supplier billed and Accounting posted.",
])
h3("Two-way operational match for services")
bullets([
    "Service order: authorised scope/rate/basis.",
    "Service acceptance: what the requesting department accepted.",
    "Accounting then matches the supplier voucher to both.",
])

h2("42. Relationship to full product costing")
p("Store provides material quantity and valuation evidence, service/freight/procurement context and receipt-level landed cost. Central Costing combines this with operations, labour, packaging, freight, duty, financing, development and overhead policy to estimate and freeze product cost. Income tax is assessed after profit; it is not hidden inside product cost.")
table(
    ["Question", "Owning answer"],
    [
        ("What material and quantity is required?", "BOM/production plus material master"),
        ("What did it cost to acquire?", "Accepted receipt valuation plus eligible landed-cost allocation"),
        ("What service/freight was consumed?", "Service order/acceptance and costing policy"),
        ("What overhead should the product absorb?", "Central Costing policy and coverage"),
        ("What was actually invoiced and paid?", "Accounting"),
        ("What budget funded it?", "Budget allocation, commitment and settlement"),
        ("Is selling price minus cost cash in pocket?", "No. Profitability must also consider overhead, financing, tax and timing; Accounting confirms realised results."),
    ],
    [3.1, 3.7],
)

# Part V
h1("Part V · Operating reference")
h2("43. Status and next-action reference")
table(
    ["Object/state", "What it tells you", "Next action"],
    [
        ("Request · approved", "Need is authorised", "Store classifies and chooses fulfilment"),
        ("Reservation · active", "Stock is promised", "Pick when ready"),
        ("Pick · prepared", "Stock is staged", "Confirm issue when it leaves"),
        ("PO · draft", "Not yet a binding issued order", "Review and issue"),
        ("PO · issued", "Supplier order is live", "Monitor/receive/amend/cancel"),
        ("PO · partly received", "Some quantity arrived", "Receive balance or resolve exception"),
        ("Receipt · pending inspection", "Goods arrived but usability is undecided", "Inspect"),
        ("Receipt · accepted", "Quantity may be put away/valued", "Put away and match"),
        ("Receipt · quarantined/rejected", "Not usable stock", "Review, rework or supplier return"),
        ("Service · completion reported", "Supplier says work is complete", "Requester accepts or requires rework"),
        ("Service · accepted", "Operational delivery is confirmed", "Accounting match"),
        ("Count · review", "Observations differ or await approval", "Investigate and post/cancel"),
        ("Exception · open", "Control condition is unresolved", "Follow evidence and correct root cause"),
    ],
    [2.0, 2.75, 2.0],
)

h2("44. Troubleshooting")
table(
    ["What you see", "Likely cause", "What to do"],
    [
        ("Register is empty, but records used to exist", "Filters, company scoping, or historical rows without company identity", "Clear filters; verify company/site; ask admin to audit migration—do not recreate masters"),
        ("Access denied / action hidden", "Capability is missing", "Confirm assigned Store role/capability; do not use another person's login"),
        ("Account is not linked to staff", "Login has no Employee record for attributable mutations", "Ask admin to link the account to the correct employee"),
        ("Service orders could not be loaded", "Temporary API error or explained data blocker", "Read the banner; Refresh only for a temporary failure"),
        ("Unit conversion unavailable", "No valid conversion exists", "Correct the master/transaction unit; never assume 1:1"),
        ("Insufficient available stock", "On hand is reserved, quarantined or in another location", "Review Reservations, location stock and shortage path"),
        ("Stock exists but cannot be picked", "Wrong variant/location/status or unassigned/quarantine state", "Use exact identity and put-away/inspection workflow"),
        ("Receipt quantity looks wrong", "Mixed units, legacy aggregate or over-receipt", "Review line-level figures by unit"),
        ("Save/submit result was uncertain", "Connection dropped after request started", "Use the same retry action/key and check history before creating anything new"),
        ("Record changed while open", "Another user updated it", "Refresh, reread and retry the decision from current state"),
        ("Budget head unresolved", "No valid item/service/category mapping", "Finance resolves mapping or an authorised override"),
        ("Inventory value missing", "Receipt/value/landed-cost evidence is incomplete", "Follow the valuation exception; do not substitute zero"),
        ("Old screen says legacy", "Historical workflow", "Read/export old records; begin new work in current screens"),
    ],
    [2.0, 2.35, 2.4],
)

h2("45. Daily Store checklist")
bullets([
    "Open Overview and Stock exceptions; assign urgent blockers.",
    "Process approved requests due soon.",
    "Review reservations waiting to be picked and picks waiting to be issued.",
    "Receive scheduled deliveries against the correct POs.",
    "Complete inspections and put-away; clear unassigned accepted stock.",
    "Record internal returns and supplier returns promptly.",
    "Review negative/uncertain/location exceptions before shift close.",
    "Confirm no uncertain retry created a duplicate transaction.",
])
h2("46. Daily buyer checklist")
bullets([
    "Review purchase shortages and approved demand awaiting sourcing.",
    "Capture/refresh dated supplier offers.",
    "Issue approved POs and service orders.",
    "Follow overdue or at-risk orders in Purchase exceptions.",
    "Resolve supplier, unit, rate or validity anomalies before issue.",
    "Coordinate receipt/service acceptance without marking it complete on another team's behalf.",
])
h2("47. Weekly control checklist")
bullets([
    "Review slow/open requests, partial POs and old reservations.",
    "Reconcile quarantined, unassigned and returns locations.",
    "Run movement and purchase-exception reports with documented scope.",
    "Review material reorder policy and supplier-offer expiry.",
    "Perform scheduled cycle counts and investigate differences.",
    "Review inactive/duplicate suppliers, materials and services without deleting history.",
    "Review unresolved budget mappings and accounting match blockers.",
])
h2("48. Month-end checklist")
bullets([
    "Ensure all goods received by cut-off have line-level receipts and inspection outcomes.",
    "Ensure accepted services have acceptance evidence.",
    "Complete or explain open supplier returns and material internal returns.",
    "Reconcile material/location movements and investigate exceptions.",
    "Provide Accounting the PO–receipt/service acceptance trail.",
    "Review management inventory valuation and missing-cost exceptions.",
    "Separate operational estimates from posted Accounting actuals.",
])

h2("49. Administrator setup checklist")
bullets([
    "Company and site context resolves for every Store user.",
    "Operational users have least-privilege capabilities and linked staff identities for mutations.",
    "Materials, services and finished products remain separate masters with clear ownership.",
    "Units and conversions are controlled and tested.",
    "Warehouse/location hierarchy reflects real physical flow.",
    "Suppliers have lifecycle status and audit history.",
    "Budget mappings cover active item/service/category identities.",
    "Historical records are migrated to company scope before legacy fallback is removed.",
    "Legacy creation paths are restricted; historical read/export remains available.",
    "Backups, audit retention and period-end controls are documented outside this user guide.",
])

h2("50. Glossary")
table(
    ["Abbreviation/term", "Meaning"],
    [
        ("BOM", "Bill of materials: the product's defined material requirements."),
        ("GRN / Goods receipt", "Goods receipt note/record for physical arrival against a PO."),
        ("MRF / Material request", "A department's request for material; current work is handled through Request Desk."),
        ("PO", "Purchase order for physical goods."),
        ("SO / Service order", "Order for non-stock work; not a sales order in this context."),
        ("SKU / Item code", "Stable internal identifier for a material or variant."),
        ("SAC", "Service accounting classification used for service tax/accounting context."),
        ("On hand", "Physical quantity recorded in Store."),
        ("Available", "On hand less active reservations, subject to usability/location rules."),
        ("Landed cost", "Eligible acquisition charges allocated to accepted receipts for management valuation."),
        ("Commitment", "Approved planned spend reserved against a budget."),
        ("Actual", "Financial amount posted by Accounting, normally through the supplier voucher."),
        ("Idempotent retry", "Repeating the same operation safely without duplicating its business effect."),
        ("Immutable movement", "A posted stock fact that is corrected by a linked compensating movement, not overwritten."),
    ],
    [2.0, 4.75],
)

h2("51. Route and ownership map")
table(
    ["Navigation", "Typical path", "Owner"],
    [
        ("Overview", "/store/dashboard/overview", "Store operations"),
        ("Request desk", "/store/dashboard/order-requests", "Requests + Store decision"),
        ("Purchase orders", "/store/dashboard/operations/purchase-order", "Purchase"),
        ("Service orders", "/store/dashboard/operations/service-orders", "Purchase + requester acceptance"),
        ("Purchase forms — legacy", "/store/dashboard/operations/requisitions", "Historical"),
        ("Goods receipts", "/store/dashboard/operations/goods-receipts", "Receive/Store"),
        ("Deliveries (legacy)", "/store/dashboard/operations/delivery", "Historical"),
        ("Reservations & picking", "/store/dashboard/operations/reservations", "Store"),
        ("Issues & returns", "/store/dashboard/raw-items/stock-adjustments", "Store"),
        ("Stock counts", "/store/dashboard/raw-items/stock-count", "Store control"),
        ("Stock movements", "/store/dashboard/operations/stock-ledger", "Store/audit"),
        ("Stock exceptions", "/store/dashboard/operations/stock-exceptions", "Store control"),
        ("Lot labels & barcodes", "/store/dashboard/operations/barcode-generator", "Store"),
        ("Materials", "/store/dashboard/raw-items", "Item master"),
        ("Finished products & BOM", "/store/dashboard/products", "Production-owned; Store read"),
        ("Service master", "/store/dashboard/services", "Service master"),
        ("Suppliers", "/store/dashboard/vendors-buyer/vendors", "Supplier master"),
        ("Supplier offers", "/store/dashboard/supplier-offers", "Sourcing"),
        ("Units of measure", "/store/dashboard/configurations/units-packaging", "Master data"),
        ("Warehouses", "/store/dashboard/configurations/warehouse", "Warehouse master"),
        ("Reports", "/store/dashboard/reports/…", "Read/control"),
        ("Settings", "/store/dashboard/settings", "Administration"),
    ],
    [1.75, 3.25, 1.75],
)

h2("52. Final operating test")
p("A user is ready to operate the application only if they can answer all of the following without guessing:")
bullets([
    "Where does a new need start, and who approves it?",
    "How do I decide between stock fulfilment, a purchase order and a service order?",
    "What is the difference between on hand, reserved, available, picked and issued?",
    "How do I receive a mixed-unit PO without inventing a meaningless total?",
    "What makes a service complete, and why is there no GRN?",
    "Where do material, service, supplier, offer, unit and warehouse masters live?",
    "Why is budget mapping not edited on the material form?",
    "Which event is the Accounting actual, and who records payment?",
    "How do I correct a posted stock error without editing history?",
    "Which screens are legacy, and what work may still be done there?",
])
p("If any answer is unclear, return to the corresponding workflow chapter before performing the transaction. In Store & Purchase, correct identity and correct sequence are more valuable than a fast but disconnected entry.")

# Part VI
page_break()
h1("Part VI · Photo-guided workflows")
lead("This section uses the actual authenticated Store & Purchase interface captured on 6 September 2026. Each plate places numbered markers on the live screen and explains the corresponding action beside it.")
note("How to use the plates", "Read the short context above a plate, then follow markers 1, 2, 3 and onward. A screenshot is evidence of the screen and its controls, not permission to bypass approvals. The records and counts shown are examples from the captured company state and will change as work progresses.")
bullets([
    "Do not copy an example request, supplier, quantity or amount into a new transaction unless it is factually correct for your work.",
    "A missing or empty section may be a prerequisite state—not a reason to invent data. Follow the caption and the troubleshooting chapter.",
    "Actions such as Add, Issue, Accept, Post, Cancel and Save change company records. Recheck identity, quantity, unit, location, budget result and supporting document before using them.",
    "The captured session was used read-only for this guide: forms and dialogs were opened for explanation, but nothing was submitted.",
])

h2("53. Workflow map for the photo section")
table(
    ["Work you need to do", "Photo sequence"],
    [
        ("Start the shift and find urgent work", "54.1"),
        ("Review and fulfil an approved request", "54.2–54.7"),
        ("Buy and receive physical goods", "55.1–55.3"),
        ("Buy and accept a service", "56.1"),
        ("Control reservations, issues, counts and corrections", "57.1–57.5"),
        ("Create traceable lot labels", "58.1"),
        ("Maintain materials, products, suppliers, offers, units and warehouses", "59.1–59.9"),
        ("Read operational and valuation reports", "60.1–60.4"),
        ("Use settings and historical registers correctly", "61.1–61.2"),
    ],
    [3.75, 2.9],
)

photo_plate("54.1", "Start the shift from Overview", "01-overview-annotated.png",
            "Open Overview first. It condenses the queues that require action and links each card to the relevant filtered workspace.",
            "you know what must be handled first and which register owns it")
photo_plate("54.2", "Find approved demand in Request desk", "02-request-desk-annotated.png",
            "Use the stage and type controls to narrow the register, then open the exact request rather than starting disconnected purchasing work.",
            "the correct request is open with its current fulfilment state visible")
photo_plate("54.3", "Read the request before deciding", "25-request-detail-open-annotated.png",
            "Confirm requester, reason, required date, approval state and line identities before choosing how Store will fulfil each line.",
            "each line has a fact-based fulfilment decision")
photo_plate("54.4", "Classify required items", "29-request-required-items-annotated.png",
            "Work from the Required items section. Match the requested description to the real material/variant and verify the unit; do not rely on similar names.",
            "the request lines point to the correct master identities")
photo_plate("54.5", "Issue available stock", "32-issue-stock-form-annotated.png",
            "Use this form only for quantity that is physically available and permitted for issue. The unit and destination must describe the real movement.",
            "the request is fulfilled by a traceable stock-out movement")
photo_plate("54.6", "Record an internal return", "33-return-stock-form-annotated.png",
            "Use Return stock when issued material comes back internally. Select the original context, returned quantity, unit, destination and reason.",
            "usable or non-usable returned material is recorded in the correct location")
photo_plate("54.7", "Recheck the request outcome", "25-request-detail-open-annotated.png",
            "Return to the request after reserving, issuing or sending lines to purchase. Read its fulfilment summary rather than assuming a successful button click completed the need.",
            "the request shows the intended stock, purchase or service result")

photo_plate("55.1", "Work the purchase-order register", "03-purchase-orders-annotated.png",
            "Use Purchase orders to monitor drafts, issued orders, receipts and exceptions. Search by the business identity you are reconciling.",
            "the correct order and its next operational action are identified")
photo_plate("55.2", "Create a purchase order", "27-new-purchase-order-annotated.png",
            "Create a PO from approved demand where possible. Verify supplier, ordered items, quantities, units, rates, taxes, dates and terms before issue.",
            "a reviewable draft exists; issue it only after commercial approval")
photo_plate("55.3", "Inspect and accept a goods receipt", "05-goods-receipts-annotated.png",
            "Open the receipt queue when physical goods arrive. Match the PO line, record what arrived by unit, inspect it and put only accepted stock away.",
            "accepted, quarantined and rejected quantities are separated and traceable")

photo_plate("56.1", "Monitor service-order delivery", "04-service-orders-annotated.png",
            "Service orders control non-stock work. Move from issued to in progress to completion reported; the requesting department—not Store—accepts the result.",
            "accepted work is ready for Accounting match without creating stock or a goods receipt")

photo_plate("57.1", "Reserve and pick stock", "06-reservations-picking-annotated.png",
            "Reserve stock against approved demand before picking it. Treat on hand, reserved, available, picked and issued as different states.",
            "promised stock is staged and issued once, against the correct request")
photo_plate("57.2", "Use the issues and returns workspace", "07-issues-returns-annotated.png",
            "Choose the correct mode for a stock-out or internal stock-in. Search and verify the exact material/variant before opening the form.",
            "the movement direction, identity, unit and reason are correct")
photo_plate("57.3", "Run a controlled stock count", "08-stock-counts-annotated.png",
            "Start a count only after warehouse structure exists. Count by assigned scope, investigate differences, then post or cancel according to authority.",
            "observations and any approved correction remain auditable")
photo_plate("57.4", "Trace stock movements", "09-stock-movements-annotated.png",
            "Use the ledger to investigate an item, variant, movement type or reference. A filtered net is not the item's full stock balance.",
            "the movement chain and source document explain the quantity")
photo_plate("57.5", "Resolve stock exceptions", "10-stock-exceptions-annotated.png",
            "Work negative balances, unassigned accepted stock, placement mismatches and broken evidence chains from the exception register.",
            "the root cause is corrected without rewriting posted history")

photo_plate("58.1", "Create lot labels and barcodes", "11-lot-labels-annotated.png",
            "Select the item/variant and state what one label represents. Number of labels is print quantity—it does not multiply stock or receive goods.",
            "each printed label identifies a real stored quantity without changing inventory")

photo_plate("59.1", "Use the Materials register", "12-materials-annotated.png",
            "Materials is the master for stock-tracked inputs. Search, filter and open the item; use operational screens for stock quantity changes.",
            "the correct material identity is found without creating a duplicate")
photo_plate("59.2", "Create a material master record", "28-new-material-annotated.png",
            "Create reusable identity and policy—not stock. Complete classification, base unit, budget-classification result, reorder policy and meaningful variants.",
            "a stable material record exists with no invented opening balance")
photo_plate("59.3", "Read the finished-product catalogue", "13-finished-products-annotated.png",
            "Finished products and BOMs are production-owned outputs. Store reads them for identity and material demand; it does not merge them into Materials.",
            "the correct output/BOM context is understood without duplicating the master")
photo_plate("59.4", "Maintain supplier identity", "15-suppliers-annotated.png",
            "Search before adding. Keep one supplier identity with lifecycle, contact and compliance facts rather than creating spelling variants.",
            "purchasing documents refer to a controlled supplier master")
photo_plate("59.5", "Review supplier offers", "16-supplier-offers-annotated.png",
            "Offers are dated commercial evidence, not permanent master cost. Compare current material, service and freight offers before selecting one.",
            "the sourcing decision is supported by a current comparable offer")
photo_plate("59.6", "Capture a new supplier offer", "35-new-supplier-offer-annotated.png",
            "Choose the correct offer type and supplier, then enter the exact item/service, unit basis, currency, validity and commercial terms.",
            "a dated, attributable offer can support purchasing or costing")
photo_plate("59.7", "Maintain units of measure", "17-units-annotated.png",
            "Use controlled units and valid conversions. If no conversion exists, correct the master or transaction—never assume one-to-one.",
            "quantities retain a valid and explainable measurement basis")
photo_plate("59.8", "Review warehouse structure", "18-warehouses-annotated.png",
            "Warehouses and locations must reflect the physical flow used for receiving, inspection, usable stock, quarantine, returns and staging.",
            "transactions can point to the place where stock actually is")
photo_plate("59.9", "Create warehouse structure", "38-new-warehouse-form-annotated.png",
            "Enter a company-unique code, address and operational contact. Capacity describes the facility; it is not a stock balance.",
            "the warehouse and its standard operational locations are ready for controlled use")

photo_plate("60.1", "Read the request report", "19-request-report-annotated.png",
            "Set a clear date and status scope before reading the figures. Use the report to find ageing and incomplete fulfilment.",
            "the result can be explained by its visible filters and source requests")
photo_plate("60.2", "Read the movement report", "20-movement-report-annotated.png",
            "Filter by period, material, variant and movement type. Keep unlike units separate and trace suspicious rows to their references.",
            "movement activity is reconciled without presenting mixed units as one total")
photo_plate("60.3", "Review purchase exceptions", "21-purchase-exceptions-annotated.png",
            "Use this report for overdue orders, receipt/billing mismatches and other purchasing blockers; assign the next action to the owning team.",
            "commercial and document-chain exceptions have an accountable resolution path")
photo_plate("60.4", "Read inventory valuation", "22-inventory-valuation-annotated.png",
            "Choose valuation scope and read missing-cost coverage before relying on totals. This is management valuation, not the posted Accounting ledger.",
            "the value is interpreted with its method, evidence coverage and limitations")

photo_plate("61.1", "Use Store settings safely", "23-settings-annotated.png",
            "Settings change future operational defaults and policies. Review downstream request, order, receipt and reporting effects before saving.",
            "the controlled setting is documented and effective from a known point")
photo_plate("61.2", "Read legacy purchase forms", "24-legacy-purchase-forms-annotated.png",
            "The legacy register remains for history and supported old work. It is not the starting point for a new request or purchase.",
            "historical records remain readable while new work begins in Request desk",
            4.45)

doc.core_properties.title = "GRAV Store & Purchase — Complete User Guide"
doc.core_properties.subject = "Ultra-detailed operating manual for the GRAV Store & Purchase application"
doc.core_properties.author = "GRAV"
doc.core_properties.keywords = "Store, Purchase, Inventory, Procurement, Goods Receipt, Service Order, Budget, Accounting"
doc.save(OUT)
print(OUT)
