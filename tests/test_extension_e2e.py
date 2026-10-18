"""End-to-end test of the Chrome extension with fake Woolworths, Coles and PosPort sites.
Network calls are answered locally, so nothing real is touched.
Run:  python tests/test_extension_e2e.py"""
import json
import pathlib
import tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT = str(ROOT / "extension")
MOCK = (ROOT / "tests" / "mock_posport.html").read_text()
SAMPLE = str(ROOT / "samples" / "barcodes-template.xlsx")

WW = {"Products": [{"Products": [{
    "Stockcode": 123, "Name": "Allen's Minties Lollies Bag", "DisplayName": "Allen's Minties Lollies Bag 150g",
    "PackageSize": "150g", "Barcode": "9300682012345", "Price": 3.0, "WasPrice": 4.2, "IsOnSpecial": True,
    "AdditionalAttributes": {"sapdepartmentname": "CONFECTIONERY"}}]}]}
COLES_HOME = '<html><body><script id="__NEXT_DATA__" type="application/json">{"buildId":"abc"}</script></body></html>'
COLES = {"pageProps": {"searchResults": {"results": [{
    "_type": "PRODUCT", "id": 1, "name": "Minties Lollies Bag", "brand": "Allen's", "size": "150g",
    "pricing": {"now": 4.5, "was": 0}}]}}}


def setup_routes(ctx):
    ctx.route("https://www.woolworths.com.au/apis/**", lambda r: r.fulfill(json=WW))
    ctx.route("https://www.woolworths.com.au/", lambda r: r.fulfill(body="<html>ww</html>", content_type="text/html"))
    ctx.route("https://www.coles.com.au/_next/**", lambda r: r.fulfill(json=COLES))
    ctx.route("https://www.coles.com.au/", lambda r: r.fulfill(body=COLES_HOME, content_type="text/html"))
    ctx.route("https://manager.posport.com.au/**", lambda r: r.fulfill(body=MOCK, content_type="text/html"))


def save_xlsx(download):
    path = pathlib.Path(tempfile.mkdtemp()) / download.suggested_filename
    download.save_as(path)
    assert path.suffix == ".xlsx", path
    return path


def wait_until(page, fn, timeout=60000):
    """Poll from Python (extension pages forbid string eval)."""
    for _ in range(timeout // 250):
        if fn():
            return
        page.wait_for_timeout(250)
    raise AssertionError("timed out")


def main():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), headless=True, channel="chromium",
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        setup_routes(ctx)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        # open the three sites first so the fake routes apply to their tabs
        for url in ("https://www.woolworths.com.au/", "https://www.coles.com.au/", "https://manager.posport.com.au/catalog/items"):
            ctx.new_page().goto(url)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(f"chrome-extension://{ext_id}/dashboard.html")
        page.set_input_files("#addFile", SAMPLE)
        page.click("#addLookup")
        wait_until(page, lambda: page.locator("#addTable .pill.idle").count() == 0)
        first = page.locator("#addTable tbody tr").first
        price = first.locator("input.price").input_value()
        name = first.locator("input.name").input_value()
        cat = first.locator("select.cat").input_value()
        print("row 1:", name, price, cat)
        assert price == "6.00", price           # highest = Coles 4.50 (Woolies normal 4.20) + 1.50
        assert name == "Allens Minties Lollies 150g" or name.startswith("Allens Minties"), name
        assert cat == "CONFECTIONERY", cat

        # markup can be changed on the Add tab
        page.fill("#addMarkup", "2")
        page.click("#addApplyMarkup")
        assert page.locator("#addTable tbody tr").first.locator("input.price").input_value() == "6.50"
        page.fill("#addMarkup", "1.5")
        page.click("#addApplyMarkup")

        # Create: fills the (mock) Bulk Create page, then waits for the user to press Create
        page.click("#addCreate")
        page.wait_for_selector("#banner:not(.hidden)", timeout=60000)
        pos = [pg for pg in ctx.pages if "posport" in pg.url][0]
        filled = pos.evaluate("""() => Array.from(document.querySelectorAll('#rows .row')).map(r =>
            [r.querySelector('[placeholder="Enter Item Name"]').value, r.querySelector('.price').value, r.querySelector('.val').textContent])""")
        print("PosPort rows:", filled)
        assert filled[0][1] == "6.00" and filled[0][2] == "CONFECTIONERY"
        assert len(filled) == 2 and filled[1][0] == ""  # 1 valid item + 1 spare empty row (other sample barcodes fail the check digit)
        page.click("#bannerContinue")
        wait_until(page, lambda: page.locator("#addTable .pill.ok").count() >= 1)

        # Labels: search + tick + Print labels on the mock list
        page.click("[data-tab=labels]")
        page.fill("#lblNames", "A2 Full Cream 2L\n9300682012345\nMystery Snack 99g")
        page.click("#lblRun")
        wait_until(page, lambda: "Print labels" in page.inner_text("#lblLog"))
        print("labels log:", page.inner_text("#lblLog").replace("\n", " | "))
        assert "✓ A2 Full Cream 2L" in page.inner_text("#lblLog")
        assert "✓ 9300682012345 → ALLENS MINTIES 150G" in page.inner_text("#lblLog")  # barcode -> Woolworths name -> keyword search

        # "Download failed items" on Labels and Add tabs
        from openpyxl import load_workbook
        with page.expect_download() as dl:
            page.click("#lblFailed")
        ws = load_workbook(save_xlsx(dl.value)).active
        head = [c.value for c in ws[1]]
        print("labels failed sheet:", head, [c.value for c in ws[2]][:5])
        assert ws.max_row == 2 and ws.cell(2, 1).value == "Mystery Snack 99g" and "Why it failed" in head
        # "Not ticked" panel: send the missing product to Add new items
        assert page.locator("#lblIssues tr[data-i]").count() == 1
        before = page.locator("#addTable tbody tr").count()
        page.click("#lblIssues .add1")
        assert "in Add items" in page.inner_text("#lblIssues")
        assert page.locator("#addTable tbody tr").count() == before + 1
        page.click("[data-tab=add]")
        with page.expect_download() as dl:
            page.click("#addFailed")
        ws = load_workbook(save_xlsx(dl.value)).active
        head = [c.value for c in ws[1]]
        print("add failed sheet:", ws.max_row - 1, "rows,", len(head), "columns")
        assert "Woolworths other results" in head and "Coles normal $" in head and ws.max_row >= 2

        # Not sure which item -> pick one in the panel -> run again
        page.click("[data-tab=labels]")
        page.fill("#lblNames", "Minties")
        page.click("#lblRun")
        wait_until(page, lambda: "Nothing was ticked" in page.inner_text("#lblLog") or "Print labels" in page.inner_text("#lblLog"))
        print("pick run log:", page.inner_text("#lblLog").replace("\n", " | "), "| issues:", page.inner_text("#lblIssues")[:300])
        page.locator("#lblIssues .pick", has_text="ALLENS MINTIES 150G").locator("input").check()
        page.click("#issRerun")
        wait_until(page, lambda: "Print labels (1 items)" in page.inner_text("#lblLog"))
        assert "✓ ALLENS MINTIES 150G" in page.inner_text("#lblLog"), page.inner_text("#lblLog")
        # My tickets: bring new items in, preview and print to a 2.5 x 1 in page
        page.click("[data-tab=tickets]")
        page.fill("#tkPaste", "Kit Kat Chunky King 70g | 3.99 | 9300605094703")
        page.click("#tkAddLines")
        assert page.locator("#tkPreview .ticket").count() == 1
        assert "$3.99 per 100g" not in page.inner_text("#tkPreview") and "$5.70 per 100g" in page.inner_text("#tkPreview")
        page.evaluate("window.print = () => {}")
        page.click("#tkPrint")
        page.emulate_media(media="print")
        pdf = pathlib.Path(tempfile.mkdtemp()) / "t.pdf"
        page.pdf(path=str(pdf), prefer_css_page_size=True)
        page.emulate_media(media="screen")
        from pypdf import PdfReader
        box = PdfReader(str(pdf)).pages[0].mediabox
        assert (round(float(box.width) / 72, 2), round(float(box.height) / 72, 2)) == (2.5, 1.0), box
        page.click("[data-tab=labels]")
        # Price check: scan the mock list, then compare a name-only sheet
        page.click("[data-tab=check]")
        page.click("#chkScan")
        wait_until(page, lambda: "items ·" in page.inner_text("#chkScanInfo"))
        print("scan:", page.inner_text("#chkScanInfo"))
        assert errors == [], errors
        ctx.close()
    print("extension end-to-end test passed")


if __name__ == "__main__":
    main()
