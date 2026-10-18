"""Draws barcodes with extension/core/barcode.js and reads them back with zxing-cpp (pip install zxing-cpp).
Run:  python tests/test_barcode.py"""
import pathlib, tempfile
import zxingcpp
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CODES = ["9300605094703", "93645102", "041116005343", "9310015233562", "ABC-123"]

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 900, "height": 300})
    pg.set_content("<body style='margin:0;background:#fff'><div id=c style='width:600px;height:200px;padding:30px'></div></body>")
    pg.add_script_tag(path=str(ROOT / "extension/core/barcode.js"))
    for code in CODES:
        pg.evaluate("c => document.getElementById('c').innerHTML = CSB_BARCODE.barcodeSVG(c, 0.06).replace('<svg', '<svg height=\"200\"')", code)
        out = pathlib.Path(tempfile.mkdtemp()) / "bc.png"
        pg.screenshot(path=str(out))
        found = zxingcpp.read_barcodes(Image.open(out))
        text = found[0].text if found else ""
        print(code, "->", repr(text), found[0].format if found else "")
        assert text.lstrip("0") == code.lstrip("0"), (code, text)
    b.close()
print("barcode tests passed")
