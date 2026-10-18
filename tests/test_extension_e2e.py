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

        # Create: fills the (mock) Bulk Create page, then waits for the user to press Create
        page.click("#addCreate")
        page.wait_for_selector("#banner:not(.hidden)", timeout=60000)
        pos = [pg for pg in ctx.pages if "posport" in pg.url][0]
        filled = pos.evaluate("""() => Array.from(document.querySelectorAll('#rows .row')).map(r =>
            [r.querySelector('[placeholder="Enter Item Name"]').value, r.querySelector('.price').value, r.querySelector('.val').textContent])""")
        print("PosPort rows:", filled)
        assert filled[0][1] == "6.00" and filled[0][2] == "CONFECTIONERY"
        assert len(filled) >= 4  # 3 items + 1 spare row
        page.click("#bannerContinue")
        wait_until(page, lambda: page.locator("#addTable .pill.ok").count() >= 1)

        # Labels: search + tick + Print labels on the mock list
        page.click("[data-tab=labels]")
        page.fill("#lblNames", "A2 Full Cream 2L\n9300682012345")
        page.click("#lblRun")
        wait_until(page, lambda: "Print labels" in page.inner_text("#lblLog"))
        print("labels log:", page.inner_text("#lblLog").replace("\n", " | "))
        assert "✓ A2 Full Cream 2L" in page.inner_text("#lblLog")
        assert "✓ 9300682012345 → ALLENS MINTIES 150G" in page.inner_text("#lblLog")  # barcode -> Woolworths name -> keyword search

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
