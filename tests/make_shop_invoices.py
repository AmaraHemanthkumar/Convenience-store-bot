"""Made-up invoices in the layout of Woolworths and Coles online-order tax invoices (no real customer details).
python tests/make_shop_invoices.py OUTDIR  ->  OUTDIR/woolworths.pdf, OUTDIR/coles.pdf"""
import sys, pathlib
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

def woolworths(out):
    c = canvas.Canvas(str(out), pagesize=A4)
    W, H = A4
    c.setFont("Helvetica-Bold", 12); c.drawString(250, H - 50, "Tax Invoice"); c.setFont("Helvetica", 9)
    c.drawString(60, H - 80, "Woolworths")
    c.drawString(330, H - 70, "Invoice/Order Number: 300000001"); c.drawString(330, H - 82, "Customer: Example Shop")
    c.drawString(330, H - 94, "Date: 15 Oct 2026")
    c.setFont("Helvetica-Bold", 9); c.drawString(50, H - 140, "Supplied")
    y = H - 160
    for x, t in [(55, "Line"), (100, "Description"), (390, "Ordered"), (450, "Supplied"), (510, "Price"), (550, "Amount")]:
        c.drawString(x, y, t)
    rows = [("cat", "Baby"), (1, "* Huggies gentle cleanse baby wipes fragrance free 80 pack", 5, 5, "2.75", "13.75"),
            ("cat", "Back to School"), (8, "Uncle tobys rolled oats quick porridge pdm 1kg", 2, 2, "4.20", "8.39"),
            ("cat", "Drinks"), (75, "* Gatorade mash ups sport drink blue bolt x watermelon 600ml", 7, 7, "2.30", "16.10"),
            (87, "Vitasoy oat milky long life milk uht 1l", 4, 4, "2.50", "10.00"),
            ("cat", "Gift Ideas"),
            (118, "* Gillette after shave splash refreshing breeze 50ml", 3, 3, "3.45", "10.35"),
            ("cat", "Pantry"), (2, "Kraft mac & cheese macaroni pasta original noodles 205g", 3, 3, "2.52", "7.55"),
            (11, "Edgell snack time chickpea olive oil garlic & rosemary 70g with a very long name that wraps", 7, 0, "1.20", "0.00")]
    y -= 18
    for r in rows:
        if r[0] == "cat":
            c.setFont("Helvetica-Bold", 9); c.drawString(100, y, r[1]); c.setFont("Helvetica", 9); y -= 13; continue
        line, desc, o, s, p, a = r
        c.drawString(60, y, str(line))
        if len(desc) > 62:
            c.drawString(100, y, desc[:62]); c.drawString(100, y - 11, desc[62:]); extra = 11
        else:
            c.drawString(100, y, desc); extra = 0
        ny = y - 7      # numbers sit lower than the description, like the real invoice
        c.drawString(400, ny, str(o)); c.drawString(460, ny, str(s)); c.drawString(510, ny, "$" + p); c.drawString(552, ny, "$" + a)
        y -= 22 + extra
    c.drawString(400, y - 10, "Delivery fee"); c.drawString(552, y - 10, "$9.00")
    c.drawString(400, y - 24, "Order Total"); c.drawString(552, y - 24, "$75.14")
    c.save()

def coles(out):
    c = canvas.Canvas(str(out), pagesize=A4)
    W, H = A4
    c.setFont("Helvetica-Bold", 14); c.drawString(60, H - 60, "coles for business"); c.setFont("Helvetica", 8)
    c.drawString(420, H - 55, "Online order tax invoice"); c.drawString(420, H - 66, "Invoice number: 200000002")
    c.drawString(60, H - 90, "Customer name: EXAMPLE SHOP")
    c.drawString(380, H - 120, "Order placed"); c.drawString(380, H - 132, "Monday 05 October, 12:16am")
    y = H - 180
    sections = [("Health & Beauty", [("%Blistex Lip Balm Conditioning 4.25g", 3, 3, "3.25", "9.75"),
                                     ("%Pantene Collagen Intense Repair & Shine Hair Mask", 2, 2, "7.50", "15.00")]),
                ("Cleaning & Laundry", [("%Bref Power Active Toilet Cleaner Gel Eucalyptus 70", 4, 4, "3.50", "14.00"),
                                        ("Finish Rinse & Shine Dishwasher Aid Regular 250mL", 4, 3, "4.50", "13.50")]),
                ("Chips, Chocolates & Snacks", [("%Cadbury Curly Wurly Sharepack 135g", 8, 8, "3.75", "30.00")])]
    for title, items in sections:
        c.setFont("Helvetica-Bold", 10); c.drawString(60, y, title); y -= 14
        c.setFont("Helvetica-Bold", 8)
        for x, t in [(60, "Product"), (330, "Ordered"), (390, "Picked"), (440, "Unit Price"), (500, "Total charged")]:
            c.drawString(x, y, t)
        c.setFont("Helvetica", 8); y -= 16
        for d, o, p, up, tot in items:
            c.drawString(60, y, d)
            ny = y - 4
            c.drawString(340, ny, str(o)); c.drawString(395, ny, str(p)); c.drawString(445, ny, "$" + up); c.drawString(505, ny, "$" + tot)
            y -= 16
        y -= 10
    c.drawString(380, y - 10, "Total charged"); c.drawString(505, y - 10, "$82.25")
    c.save()

def ccep(out):
    """Coca-Cola Europacific Partners style (narrow receipt layout, wrapped descriptions)."""
    c = canvas.Canvas(str(out), pagesize=(300, 760))
    c.setFont("Courier", 7)
    y = 740
    for t in ["Coca-Cola Europacific Partners Australia PTY LTD", "TAX INVOICE ABN: 00 000 000 000", "",
              "Customer Number   1000000      Tax Invoice    240000001", "Date          14/10/2026", "",
              "Material                       CDS   Price   Extended", "Number  Description      Qty  P/C   Net     Price"]:
        c.drawString(10, y, t); y -= 10
    rows = [("955734 *", "600Ml PET X24 Fanta Orange", None, "1", "$3.29", "$59.67", "$59.67"),
            ("958134 *", "500 CAN X24 Mother Rainbow", "Sherbet", "1", "$3.29", "$49.57", "$49.57"),
            ("954907 *", "500 CAN 6X4 Monster Mango", "Loco", "1", "$3.29", "$53.45", "$53.45"),
            ("953945  ", "600Ml PET X24 Mount", "Franklin Still Water", "1", "$3.29", "$46.97", "$46.97"),
            ("950971 *", "375Ml CAN Ib24", "Coca-Cola", "2", "$3.29", "$26.19", "$52.38"),
            ("880926  ", "Promo Pricing Error-Non", "Taxable", "-3100", "$0.00", "$0.01", "-$31.00")]
    for mat, d1, d2, q, cds, net, ext in rows:
        c.drawString(10, y, mat); c.drawString(55, y, d1); c.drawString(170, y, q); c.drawString(190, y, cds); c.drawString(222, y, net); c.drawString(258, y, ext)
        y -= 10
        if d2: c.drawString(55, y, d2); y -= 10
    for t in ["        Total Quantity   6", "Product total before GST, WET and CDS $242.87", "",
              "Payment Type        Total Taxable    $215.07", "                    Total GST         $21.51",
              "                    Total Non-Taxable $15.97", "                    Total Price      $252.55"]:
        c.drawString(10, y, t); y -= 10
    c.save()

if __name__ == "__main__":
    d = pathlib.Path(sys.argv[1]); d.mkdir(parents=True, exist_ok=True)
    woolworths(d / "woolworths.pdf"); coles(d / "coles.pdf"); ccep(d / "ccep.pdf")
