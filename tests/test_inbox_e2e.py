"""End-to-end test of v3.5: Gmail fetch (fake Gmail), Woolworths account invoices (fake site), a photo of a printed
invoice (read by the real OCR), Coles robot check, the one-list view across files, and Offers.
Run:  python tests/test_inbox_e2e.py"""
import base64
import json
import pathlib
import tempfile
import sys
from playwright.sync_api import sync_playwright
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT = str(ROOT / "extension")
MOCK = (ROOT / "tests" / "mock_posport.html").read_text()
sys.path.insert(0, str(ROOT / "tests"))
import make_shop_invoices  # noqa: E402

TMP = pathlib.Path(tempfile.mkdtemp())
make_shop_invoices.woolworths(TMP / "woolworths.pdf")
WW_PDF = (TMP / "woolworths.pdf").read_bytes()

# a sheet of barcodes "emailed" to the shop
wb = Workbook(); ws = wb.active
ws.append(["Barcode"]); ws.append(["9300605094703"]); ws.append(["9300682012345"])
wb.save(TMP / "barcodes.xlsx")
XLSX_B64 = base64.urlsafe_b64encode((TMP / "barcodes.xlsx").read_bytes()).decode()

GMAIL_HITS = {"list": 0, "att": 0}


def gmail(route):
    u = route.request.url
    if "/messages?" in u:
        GMAIL_HITS["list"] += 1
        return route.fulfill(json={"messages": [{"id": "m1"}, {"id": "m2"}]})
    if u.endswith("/messages/m1?format=full"):
        return route.fulfill(json={"id": "m1", "internalDate": "1792800000000", "payload": {"headers": [
            {"name": "From", "value": "Me <shop.owner@example.com>"}, {"name": "Subject", "value": "barcodes for the new shelf"}],
            "parts": [{"mimeType": "text/plain", "body": {"size": 2}}, {"filename": "new-shelf.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "body": {"attachmentId": "AX", "size": 100}}]}})
    if u.endswith("/messages/m2?format=full"):        # not an approved sender: must be ignored
        return route.fulfill(json={"id": "m2", "internalDate": "1792800001000", "payload": {"headers": [
            {"name": "From", "value": "Spam <win@prize.example.net>"}, {"name": "Subject", "value": "invoice"}],
            "parts": [{"filename": "evil.pdf", "mimeType": "application/pdf", "body": {"attachmentId": "AE"}}]}})
    if "/attachments/AX" in u:
        GMAIL_HITS["att"] += 1
        return route.fulfill(json={"data": XLSX_B64})
    route.fulfill(status=404, body="{}")


WW_ORDERS = """<html><body><header>Hi, Shop <a href="/logout">Sign out</a></header><h1>My orders</h1>
<a href="/shop/myaccount/myorders/300000001">Order 300000001 · 15 Oct</a></body></html>"""
WW_ORDER = """<html><body><header>Hi, Shop <a href="/logout">Sign out</a></header><h1>Order 300000001</h1>
<a href="/apis/ui/order/300000001/taxinvoice">Download tax invoice</a></body></html>"""
COLES_CHECK = '<html><body><iframe id="main-iframe" src="about:blank"></iframe></body></html>'


def setup_routes(ctx):
    ctx.route("https://gmail.googleapis.com/**", gmail)
    ctx.route("https://www.googleapis.com/oauth2/v3/userinfo", lambda r: r.fulfill(json={"email": "shop.owner@example.com"}))
    ctx.route("https://www.woolworths.com.au/shop/myaccount/myorders", lambda r: r.fulfill(body=WW_ORDERS, content_type="text/html"))
    ctx.route("https://www.woolworths.com.au/shop/myaccount/myorders/300000001", lambda r: r.fulfill(body=WW_ORDER, content_type="text/html"))
    ctx.route("https://www.woolworths.com.au/apis/ui/order/300000001/taxinvoice", lambda r: r.fulfill(body=WW_PDF, content_type="application/pdf",
              headers={"content-disposition": 'attachment; filename="Woolworths-300000001.pdf"'}))
    ctx.route("https://www.woolworths.com.au/apis/ui/Search/**", lambda r: r.fulfill(json={"Products": []}))
    ctx.route("https://www.coles.com.au/**", lambda r: r.fulfill(body=COLES_CHECK, content_type="text/html"))
    ctx.route("https://manager.posport.com.au/**", lambda r: r.fulfill(body=MOCK, content_type="text/html"))
    for host in ("https://world.openfoodfacts.org/**", "https://world.openbeautyfacts.org/**", "https://world.openproductsfacts.org/**"):
        ctx.route(host, lambda r: r.fulfill(json={"status": 0}))


def invoice_photo(path):
    """A printed supplier invoice, photographed (slightly grey, a little rotated)."""
    img = Image.new("RGB", (1500, 900), (238, 236, 230))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)
    fb = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
    d.text((60, 40), "Sunshine Wholesale Pty Ltd", font=fb, fill=(20, 20, 20))
    d.text((60, 100), "Tax Invoice No: 77812      Date: 20/10/2026", font=f, fill=(20, 20, 20))
    y = 200
    for line in ["Qty  Description                     Barcode          Price    Total",
                 "12   Smiths Chips Original 170g      9310015244124   $2.95   $35.40",
                 "6    Cadbury Dairy Milk 180g         9300617063520   $4.10   $24.60",
                 "24   Mars Bar 47g                    9300682058988   $1.10   $26.40",
                 "",
                 "Total inc GST  $86.40"]:
        d.text((60, y), line, font=f, fill=(25, 25, 25)); y += 60
    img.rotate(0.6, expand=True, fillcolor=(238, 236, 230)).save(path)


def wait_until(page, fn, timeout=60000):
    for _ in range(timeout // 250):
        if fn():
            return
        page.wait_for_timeout(250)
    raise AssertionError("timed out")


def main():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, channel="chromium",
                                                   args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        setup_routes(ctx)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(f"chrome-extension://{ext_id}/dashboard.html")
        page.wait_for_timeout(800)
        # the bot already knows the Back Office (as after ↻ Re-check PosPort)
        page.evaluate("""() => { state.catalogue = [
            {id: '1', name: 'Coke 1.25L', price: 4.5, barcode: '9300675003094'}, {id: '2', name: 'Sprite 1.25L', price: 4.5, barcode: '9300675003095'},
            {id: '3', name: 'Fanta Orange 1.25L', price: 4.2, barcode: '9300675003096'}, {id: '4', name: 'Solo Lemon 1.25L', price: 4.0, barcode: '9300675003097'},
            {id: '5', name: 'Coke 600ml', price: 4.99, barcode: '9300675009999'},
            {id: '6', name: 'Allens Minties 150g', price: 5.5, barcode: '9300682012345'}]; state.catalogueAt = Date.now(); state.catalogueDeclined = true; }""")

        # ---- Gmail: set up, link an account, approved sender, fetch ----
        page.click("[data-tab=inbox]")
        assert "chromiumapp.org" in page.text_content("#gmRedirect"), (page.text_content("#gmRedirect"), errors)
        page.click("#tab-inbox details summary")
        page.fill("#gmClientId", "1234-abc.apps.googleusercontent.com"); page.click("#gmSaveClient")
        page.evaluate("""() => { chrome.identity.launchWebAuthFlow = async (o) => { window.__authUrl = o.url; return 'https://x.chromiumapp.org/gmail#access_token=T1&expires_in=3600'; }; }""")
        page.click("#gmAddAccount")
        wait_until(page, lambda: "shop.owner@example.com" in page.inner_text("#gmAccounts"), 10000)
        auth = page.evaluate("window.__authUrl")
        assert "gmail.readonly" in auth and "response_type=token" in auth, auth
        page.fill("#gmNewSender", "shop.owner@example.com"); page.fill("#gmNewLabel", "Me (barcode sheets)"); page.click("#gmAddSender")
        page.click("#gmFetch")
        wait_until(page, lambda: "new file" in page.inner_text("#gmInfo"), 30000)
        print("gmail:", page.inner_text("#gmInfo"))
        assert "1 new file loaded" in page.inner_text("#gmInfo"), page.inner_text("#gmInfo")
        page.click("#gmFetch")                                     # again: nothing new, nothing loaded twice
        wait_until(page, lambda: "fetched before" in page.inner_text("#gmInfo"), 30000)
        print("gmail again:", page.inner_text("#gmInfo"))
        assert GMAIL_HITS["att"] == 1

        # ---- Woolworths account invoices ----
        page.fill("#shAccount", "Shop"); page.fill("#shMax", "5")
        page.click("#shWW")
        try:
            wait_until(page, lambda: "invoice" in page.inner_text("#shInfo") and "loaded" in page.inner_text("#shInfo"), 60000)
        except AssertionError:
            print("SHINFO:", page.inner_text("#shInfo"), "| LOG:", [l for l in page.inner_text("#log").split("\n") if "invoice" in l.lower()], errors); raise
        print("woolworths:", page.inner_text("#shInfo"))
        assert "1 invoice loaded" in page.inner_text("#shInfo")
        page.click("#shWW")
        wait_until(page, lambda: "skipped" in page.inner_text("#shInfo") or "0 invoices" in page.inner_text("#shInfo"), 60000)
        print("woolworths again:", page.inner_text("#shInfo"))
        # ---- Coles robot check: the bot stops and says so ----
        page.click("#shColes")
        wait_until(page, lambda: "robot" in page.inner_text("#shInfo"), 60000)
        print("coles:", page.inner_text("#shInfo"))

        # ---- printed invoice photo ----
        invoice_photo(TMP / "printed-invoice.png")
        page.set_input_files("#photoFile", str(TMP / "printed-invoice.png"))
        wait_until(page, lambda: "lines read" in page.inner_text("#photoInfo") or "could be read" in page.inner_text("#log"), 240000)
        print("photo:", page.inner_text("#photoInfo"))
        assert "3 lines read" in page.inner_text("#photoInfo"), page.inner_text("#photoInfo") + " | " + page.inner_text("#log")[:500]

        # ---- fetch history ----
        hist = page.inner_text("#histTable")
        print("history:", " | ".join(hist.split("\n")[1:6]))
        assert "gmail" in hist and "Woolworths" in hist and "photo" in hist and "skipped" not in hist.split("\n")[0]

        # ---- Items & prices: each file shows where it came from; one list across files ----
        page.click("[data-tab=add]")
        wait_until(page, lambda: page.locator("#addTable tr.fhead").count() == 3, 20000)
        heads = page.inner_text("#addTable")
        print("file rows:", [l for l in heads.split("\n") if "Gmail" in l or "account" in l or "photo" in l][:3])
        assert "Gmail (shop.owner@example.com)" in heads and "Woolworths account Shop" in heads
        page.click("#addFilter button[data-f=one]")
        wait_until(page, lambda: "products from 3 files" in page.inner_text("#addTable"), 30000)
        one = page.inner_text("#addTable")
        print("one list:", one.split("\n")[0][:200])

        # ---- Offers ----
        page.click("[data-tab=offers]")
        page.fill("#ofSearch", "1.25")
        wait_until(page, lambda: "4 items" in page.inner_text("#ofResults"), 5000)
        page.check("#ofAll")
        page.fill("#ofPrice", "7")
        wait_until(page, lambda: "Any 2 1.25L" in page.input_value("#ofName"), 5000)
        print("offer:", page.input_value("#ofName"), "|", page.inner_text("#ofSave"))
        page.click("#ofAdd")
        wait_until(page, lambda: "any 2 for $7.00" in page.inner_text("#ofTable"), 5000)
        assert "Coke 600ml" not in page.inner_text("#ofTable")
        page.click("#ofTickets")
        wait_until(page, lambda: "ANY 2 1.25L" in page.inner_text("#tab-tickets").upper(), 5000)
        assert errors == [], errors
        ctx.close()
    print("inbox end-to-end test passed")


if __name__ == "__main__":
    main()
