"""Builds a small made-up supplier invoice PDF in the same layout as The Distributors' invoices
(no real account details). Used by the tests: python tests/make_invoice_pdf.py out.pdf"""
import sys
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

LINES = [
    ("NES KIT KAT CHUNKY KING 70G", "1.000", "", "9300605094703", "01816", "3.65", "OUTER", "24", "10.00", "$7.200", "47.780", "", "47.780", "47.78", "4.78", "52.56"),
    ("ALLENS MINTIES 150G", "2.000", "", "9300682012345", "01455", "4.20", "OUTER", "12", "10.00", "", "54.550", "", "54.550", "109.10", "10.91", "120.01"),
    ("U/C MYSTERY SOUR BITES 99G", "1.000", "", "9300000000017", "24451", "2.72", "OUTER", "24", "10.00", "", "36.780", "", "36.780", "36.78", "3.68", "40.46"),
    ("KINDER JOY 20G T1", "0.000", "1.000", "80310891", "24851", "OUT OF STOCK", "OUTER", "24", "10.00", "", "56.300", "", "56.300", "0.00", "0.00", "0.00"),
    ("RED BULL 250ML WHITE PEACH", "1.000", "", "90486104", "40220", "4.49", "OUTER", "12", "10.00", "$4.750", "22.890", "1.720", "24.610", "24.61", "2.46", "27.07"),
    ("PANADOL 16S **TABLETS**", "3.000", "", "9300673894021", "87470", "6.36", "UNIT", "24", "10.00", "", "4.450", "", "4.450", "13.35", "1.34", "14.69"),
]
X = [40, 210, 250, 290, 360, 400, 465, 510, 540, 570, 610, 650, 680, 720, 760, 800]

def main(out):
    c = canvas.Canvas(out, pagesize=landscape(A4))
    c.setFont("Helvetica", 7)
    c.drawString(300, 560, "Example Wholesale Pty Ltd")
    c.drawString(650, 540, "Document No:    9900001")
    c.drawString(650, 530, "Transaction Date:    1 Oct 2026")
    heads = ["Item Description", "Shipped", "Short", "Barcode", "Item Code", "RRP", "Sold As", "Outer", "GST", "Promo", "ex Levy", "Levy", "inc Levy", "inc Levy", "GST $", "inc GST"]
    for x, h in zip(X, heads):
        c.drawString(x, 500, h)
    y = 480
    for row in LINES:
        for x, v in zip(X, row):
            if v:
                c.drawString(x, y, v)
        y -= 12
    total = sum(float(r[-1]) for r in LINES)
    c.drawString(650, 200, "Total Inc GST    %.2f" % total)
    c.save()

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "invoice-example.pdf")
