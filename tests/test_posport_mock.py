"""Runs the PosPort actions against a local mock page that copies the layout seen
in the screenshots. Run:  python tests/test_posport_mock.py"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CORE = ROOT / "extension" / "core" / "posport.js"
MOCK = (ROOT / "tests" / "mock_posport.html").as_uri()


def call(page, name, *args):
    page.add_script_tag(path=str(CORE))
    return page.evaluate("([n, a]) => CSB_POSPORT[n](...a)", [name, list(args)])


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1400, "height": 900})
        page.goto(MOCK)

        st = call(page, "bulkStatus")
        assert st["rows"] == 1 and st["missingPrice"] == 0 and st["addRowFound"], st
        assert call(page, "ensureRows", 6, 50)["rows"] == 6
        cats = call(page, "bulkGetCategories")
        assert "Gum and Mints" in cats["categories"], cats

        items = [
            {"name": "Allens Minties 150g", "barcode": "9300682012345", "price": 5.7, "category": "CONFECTIONERY"},
            {"name": "Extra Peppermint S/Free 64g", "barcode": "9310000000001", "price": 7.0, "category": "Gum and Mints"},
        ]
        for i, it in enumerate(items):
            r = call(page, "fillBulkRow", i, it, 100)
            assert r["ok"], r
        vals = page.evaluate("""() => Array.from(document.querySelectorAll('#rows .row')).slice(0,2).map(r => [
            r.querySelector('[placeholder="Enter Item Name"]').value,
            r.querySelector('[placeholder="Enter Barcode"]').value,
            r.querySelector('.price').value,
            r.querySelector('.val').textContent])""")
        assert vals[0] == ["Allens Minties 150g", "9300682012345", "5.70", "CONFECTIONERY"], vals
        assert vals[1][3] == "Gum and Mints", vals
        assert call(page, "bulkStatus")["createLabel"] == "Create 6 Items"

        rows = call(page, "readListRows")["rows"]
        assert rows[1]["name"] == "A2 Full Cream 2L" and rows[1]["price"] == 7.5, rows
        call(page, "searchList", "A2 Full Cream 2L", 300)
        assert call(page, "tickRow", "A2 Full Cream 2L")["ok"]
        call(page, "searchList", "ALLENS MINTIES 150G", 300)
        assert call(page, "tickRow", "allens minties 150g")["ok"]  # case-insensitive exact
        assert call(page, "clickPrintLabels")["ok"]
        call(page, "searchList", "", 300)
        assert call(page, "nextPage", 100)["ok"]
        assert call(page, "readListRows")["rows"][0]["name"].startswith("Aramada")
        assert not call(page, "nextPage", 100)["ok"]
        b.close()
    print("mock PosPort tests passed")


if __name__ == "__main__":
    main()
