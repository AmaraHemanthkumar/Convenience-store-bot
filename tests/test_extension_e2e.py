"""End-to-end test of the Chrome extension with fake Woolworths, Coles and PosPort sites.
Network calls are answered locally, so nothing real is touched.
Run:  python tests/test_extension_e2e.py"""
import json
import pathlib
import tempfile
from playwright.sync_api import sync_playwright
from openpyxl import load_workbook

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT = str(ROOT / "extension")
MOCK = (ROOT / "tests" / "mock_posport.html").read_text()
SAMPLE = str(ROOT / "samples" / "barcodes-template.xlsx")
SHOT = str(pathlib.Path(tempfile.gettempdir()) / "items_tab.png")

WW = {"Products": [{"Products": [{
    "Stockcode": 123, "Name": "Allen's Minties Lollies Bag", "DisplayName": "Allen's Minties Lollies Bag 150g",
    "PackageSize": "150g", "Barcode": "9300682012345", "Price": 3.0, "WasPrice": 4.2, "IsOnSpecial": True,
    "AdditionalAttributes": {"sapdepartmentname": "CONFECTIONERY"}}]}]}
COLES_HOME = '<html><body><script id="__NEXT_DATA__" type="application/json">{"buildId":"abc"}</script></body></html>'
COLES = {"pageProps": {"searchResults": {"results": [{
    "_type": "PRODUCT", "id": 1, "name": "Minties Lollies Bag", "brand": "Allen's", "size": "150g",
    "pricing": {"now": 4.5, "was": 0}}]}}}


KITKAT = {"Products": [{"Products": [{
    "Stockcode": 456, "Name": "Nestle Kit Kat Chunky", "DisplayName": "Nestle Kit Kat Chunky 70g",
    "PackageSize": "70g", "Barcode": "9300605094703", "Price": 2.5, "WasPrice": 0, "IsOnSpecial": False,
    "AdditionalAttributes": {"sapdepartmentname": "CONFECTIONERY"}}]}]}


def ww_answer(route):
    """Kit Kat (not in the mock PosPort) for its barcode, Minties (in PosPort) for anything else."""
    body = route.request.post_data or route.request.url
    route.fulfill(json=KITKAT if "9300605094703" in body or "Kit Kat" in body else WW)


def setup_routes(ctx):
    ctx.route("https://www.woolworths.com.au/apis/**", ww_answer)
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
        # 1 · Items & prices: loading the Excel reads the PosPort list, looks up prices and sorts new / in PosPort
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active
        ws.append(["Barcode"]); ws.append(["9300605094703"]); ws.append(["9300682012345"])
        xl = pathlib.Path(tempfile.mkdtemp()) / "barcodes.xlsx"; wb.save(xl)
        page.set_input_files("#addFile", str(xl))
        page.wait_for_selector("#mapModal:not(.hidden)")      # "Which column is which?"
        assert page.locator("#mapTable th select").first.input_value() == "barcode"
        page.click("#mapOk")                                  # confirm "read PosPort list?" auto-accepted
        wait_until(page, lambda: "Done:" in page.inner_text("#log"))
        print("summary:", page.inner_text("#addSummary"))
        assert page.inner_text("#fNew") == "1" and page.inner_text("#fPos") == "1", (page.inner_text("#fNew"), page.inner_text("#fPos"))
        # the item already in PosPort: shows PosPort name/price, check result and a suggested new price
        posrow = page.locator("#addTable tr.in-pos")
        assert "ALLENS MINTIES 150G" in posrow.inner_text() and "$5.50" in posrow.inner_text(), posrow.inner_text()
        print("in PosPort row check:", posrow.locator("td").nth(7).inner_text().replace("\n", " "))
        newrow = page.locator("#addTable tbody tr:not(.in-pos)")
        price = newrow.locator("input.price").input_value()
        name = newrow.locator("input.name").input_value()
        print("new row:", name, price)
        assert name.startswith("Nestle Kit Kat") and newrow.locator("select.cat").input_value() == "CONFECTIONERY"
        base = float(price)

        # markup can be changed (only new items change)
        page.fill("#addMarkup", "2")
        page.click("#addApplyMarkup")
        assert abs(float(newrow.locator("input.price").input_value()) - (base + 0.5)) < 0.001
        page.fill("#addMarkup", "1.5")
        page.click("#addApplyMarkup")
        page.screenshot(path=SHOT, full_page=True)

        # filters
        page.click("#addFilter button[data-f=pos]")
        assert page.locator("#addTable tbody tr").count() == 1
        page.click("#addFilter button[data-f=all]")

        # Create the new item: fills Bulk Create, "It failed – clear and retry", then "Created OK"
        page.click("#addCreate")
        wait_until(page, lambda: page.locator("#banner:not(.hidden) button.choice").count() > 0)
        pos = [pg for pg in ctx.pages if "posport" in pg.url][0]
        filled = pos.evaluate("""() => Array.from(document.querySelectorAll('#rows .row')).map(r =>
            [r.querySelector('[placeholder="Enter Item Name"]').value, r.querySelector('.price').value, r.querySelector('.val').textContent])""")
        print("PosPort rows:", filled)
        assert filled[0][0].startswith("Nestle Kit Kat") and filled[0][2] == "CONFECTIONERY" and len(filled) == 2 and filled[1][0] == ""
        page.click("#banner button.choice:has-text('It failed')")
        wait_until(page, lambda: page.locator("#banner:not(.hidden) button.choice:has-text('Created OK')").count() == 1)
        page.click("#banner button.choice:has-text('Created OK')")
        wait_until(page, lambda: "created" in page.inner_text("#addTable"))
        assert "new items added to the print list" in page.inner_text("#log")
        page.click("[data-tab=tickets]")
        assert page.locator("#tkTable tr[data-i]").count() == 1
        page.click("[data-tab=add]")

        # Labels: search + tick + Print labels on the mock list
        page.click("[data-tab=tickets]"); page.evaluate("document.getElementById('lblBox').open = true")
        page.fill("#lblNames", "A2 Full Cream 2L\n9300682012345\nMystery Snack 99g")
        page.click("#lblRun")
        wait_until(page, lambda: "Print labels" in page.inner_text("#lblLog"))
        print("labels log:", page.inner_text("#lblLog").replace("\n", " | "))
        assert "✓ A2 Full Cream 2L" in page.inner_text("#lblLog")
        assert "✓ 9300682012345 → ALLENS MINTIES 150G" in page.inner_text("#lblLog")  # barcode -> Woolworths name -> keyword search

        # "Download failed items" on Labels and Add tabs
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
        assert "Mystery Snack 99g" in page.inner_text("#addTable")      # waiting in Items & prices to be looked up

        # Not sure which item -> pick one in the panel -> run again
        page.click("[data-tab=tickets]"); page.evaluate("document.getElementById('lblBox').open = true")
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
        page.click("#tkClear")
        page.fill("#tkPaste", "Kit Kat Chunky King 70g | 3.99 | 9300605094703")
        page.click("#tkAddLines")
        wait_until(page, lambda: page.locator("#tkPreview .ticket").count() == 1)
        assert "$5.70 per 100g" in page.inner_text("#tkPreview")
        # a bare barcode finds the item and its price in PosPort
        page.fill("#tkPaste", "9300682012345")
        page.click("#tkAddLines")
        wait_until(page, lambda: page.locator("#tkPreview .ticket").count() == 2)
        print("barcode ticket log:", page.inner_text("#log").split("\n")[0:2])
        assert "$5.50" in page.inner_text("#log")
        # Load the saved price-check Excel straight into tickets (only rows with a new price)
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active
        ws.append(["PosPort item", "Barcode", "Our price $", "Highest $", "Status", "New price $", "Updated"])
        ws.append(["A2 Full Cream 2L", "9300633603369", 7.5, 4.5, "TOO HIGH", 6.0, "yes"])
        ws.append(["ALLENS MINTIES 150G", "9300682012345", 5.5, 4.2, "OK", None, ""])
        ws.append(["Leggos Tomato Paste 500g", "93645102", 4.0, 3.3, "TOO LOW", 4.8, ""])
        xl = pathlib.Path(tempfile.mkdtemp()) / "price-check-2026-10-18.xlsx"; wb.save(xl)
        n0 = page.locator("#tkTable tr[data-i]").count()
        page.set_input_files("#tkFile", str(xl))      # dialog auto-accepted -> only the 2 with a new price
        wait_until(page, lambda: page.locator("#tkTable tr[data-i]").count() == n0 + 2)
        assert page.locator("#tkTable tr[data-i]").nth(n0).locator(".tk-price").input_value() == "6.00"
        names = [page.locator("#tkTable tr[data-i] .tk-name").nth(i).input_value() for i in range(n0, n0 + 2)]
        assert names[1].startswith("Leggos") and not any("MINTIES" in x for x in names), names
        page.select_option("#tkPaper", "roll")
        page.evaluate("window.print = () => {}")
        page.click("#tkPrint")
        page.emulate_media(media="print")
        pdf = pathlib.Path(tempfile.mkdtemp()) / "t.pdf"
        page.pdf(path=str(pdf), prefer_css_page_size=True)
        page.emulate_media(media="screen")
        from pypdf import PdfReader
        box = PdfReader(str(pdf)).pages[0].mediabox
        assert (round(float(box.width) / 72, 2), round(float(box.height) / 72, 2)) == (2.5, 1.0), box
        page.click("[data-tab=tickets]"); page.evaluate("document.getElementById('lblBox').open = true")
        # 3 · Buying & invoices: invoice paid per carton -> per unit, compared with today's supermarket price
        wb = Workbook(); ws = wb.active
        ws.append(["Item Description", "Qty Shipped", "Barcode", "Cost per Outer", "Units per Outer"])
        ws.append(["NES KIT KAT CHUNKY KING 70G", 1, "9300605094703", 48.0, 24])     # $2.00 each vs Woolies $2.50
        ws.append(["ALLENS MINTIES 150G", 2, "9300682012345", 60.0, 12])             # $5.00 each vs Woolies special $3.00
        inv = pathlib.Path(tempfile.mkdtemp()) / "invoice.xlsx"; wb.save(inv)
        page.click("[data-tab=buy]")
        page.set_input_files("#buyFile", str(inv))
        page.wait_for_selector("#mapModal:not(.hidden)")
        roles = [page.locator("#mapTable th select").nth(i).input_value() for i in range(5)]
        print("invoice columns guessed:", roles)
        assert roles[1:] == ["qty", "barcode", "costOuter", "units"], roles
        page.locator("#mapTable th select").nth(0).select_option("name")
        page.click("#mapOk")
        wait_until(page, lambda: "Comparison finished" in page.inner_text("#log"))
        txt = page.inner_text("#buyTable")
        print("buy totals:", page.inner_text("#buyTotals").replace("\n", " "))
        assert "Cheaper at Woolworths by $2.00 each" in txt and "% below Woolworths" in txt, txt
        assert page.inner_text("#bWorse") == "1"
        with page.expect_download() as dl:
            page.click("#buyReturns")
        ws2 = load_workbook(save_xlsx(dl.value)).active
        assert ws2.max_row == 2 and ws2.cell(2, 1).value.startswith("ALLENS"), [c.value for c in ws2[2]][:3]

        # Backup (items only on the mock): Excel with a Contents sheet + a JSON file
        page.click("[data-tab=backup]")
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        page.click("#bkItems")
        wait_until(page, lambda: "Backup saved" in page.inner_text("#bkLog"))
        page.wait_for_timeout(500)
        names = sorted(d.suggested_filename.rsplit(".", 1)[1] for d in downloads)
        print("backup files:", [d.suggested_filename for d in downloads], page.inner_text("#bkLog").split("\n")[0])
        assert names == ["json", "xlsx"], names
        bk = load_workbook(save_xlsx([d for d in downloads if d.suggested_filename.endswith(".xlsx")][0]))
        assert bk.sheetnames[0] == "Contents" and any(n.startswith("Items") for n in bk.sheetnames), bk.sheetnames

        page.click("[data-tab=check]")
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
