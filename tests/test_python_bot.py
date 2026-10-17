"""Exercises the Python bot against the same fake sites as the extension test.
Run:  python tests/test_python_bot.py"""
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "tests"))
os.environ["CSB_HEADLESS"] = "1"
os.environ["CSB_PROFILE"] = tempfile.mkdtemp()

import bot  # noqa: E402
from test_extension_e2e import setup_routes  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

bot.SETTINGS_FILE = pathlib.Path(tempfile.mkdtemp()) / "settings.json"

with sync_playwright() as pw:
    b = bot.Bot(pw)
    setup_routes(b.ctx)
    b.settings["delayMs"] = 100
    ww, coles, highest = b.lookup("9300682012345")
    assert ww["found"] and ww["regular"] == 4.2 and coles["regular"] == 4.5 and highest == 4.5, (ww, coles, highest)
    assert b.rules("newItemPrice", highest, b.settings) == 6.0
    assert b.pos_go("/catalog/items/bulk", "bulk")
    assert b.pos("ensureRows", 3, 50)["ok"]
    r = b.pos("fillBulkRow", 0, {"name": "Allens Minties 150g", "barcode": "9300682012345", "price": 6.0, "category": "CONFECTIONERY"}, 100)
    assert r["ok"], r
    rows = b.pos("readListRows")["rows"]
    assert any(x["name"] == "A2 Full Cream 2L" for x in rows)
    cat = b.scan_catalogue()
    assert len(cat) == 5, cat
    # Excel round trip
    out = pathlib.Path(tempfile.mkdtemp()) / "t.xlsx"
    b.write_sheet(out, "T", ["Use (Y/N)", "Barcode", "Category", "Our price $"], [["Y", "0930", "Drinks", 6.0]],
                  validations={"Category": b.categories})
    back = b.read_back(out)
    assert back[0]["Barcode"] == "0930" and back[0]["Our price $"] == 6.0, back
    b.ctx.close()
print("python bot tests passed")
