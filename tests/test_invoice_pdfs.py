"""Reads made-up supplier, Woolworths and Coles invoice PDFs with the extension's own reader (pdf.js in Chromium)."""
import json, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"

def read_all(paths):
    page_html = pathlib.Path(tempfile.mkdtemp()) / "p.html"
    page_html.write_text(f'<script src="{(EXT / "vendor/pdf.min.js").as_uri()}"></script><script src="{(EXT / "core/invoice.js").as_uri()}"></script>')
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--allow-file-access-from-files"])
        pg = b.new_page(); pg.goto(page_html.as_uri())
        pg.evaluate(f"pdfjsLib.GlobalWorkerOptions.workerSrc = {json.dumps((EXT / 'vendor/pdf.worker.min.js').as_uri())}")
        for name, path in paths.items():
            data = list(pathlib.Path(path).read_bytes())
            out[name] = pg.evaluate("async (d) => CSB_INVOICE.readPdf(new Uint8Array(d).buffer)", data)
        b.close()
    return out

def main(extra=()):
    d = pathlib.Path(tempfile.mkdtemp())
    subprocess.run([sys.executable, str(ROOT / "tests/make_shop_invoices.py"), str(d)], check=True)
    subprocess.run([sys.executable, str(ROOT / "tests/make_invoice_pdf.py"), str(d / "wholesale.pdf")], check=True)
    paths = {"woolworths": d / "woolworths.pdf", "coles": d / "coles.pdf", "wholesale": d / "wholesale.pdf", "ccep": d / "ccep.pdf"}
    paths.update({pathlib.Path(x).name: x for x in extra})
    res = read_all(paths)
    for name, inv in res.items():
        print(f"== {name}: {inv['kind']} · {inv['supplier']} #{inv['number']} · {inv['date']} · {len(inv['items'])} items · "
              f"total {inv['total']:.2f} printed {inv['printedTotal']} fees {inv['fees']}")
        for it in inv["items"][:200]:
            print(f"   {it['desc'][:70]:70} got {it['unitsReceived']:>5} short {it['unitsShort']:>3} unit ${it['unitCost']} {it['status']}")
    if extra:
        return
    ww, co, wh = res["woolworths"], res["coles"], res["wholesale"]
    assert ww["kind"] == "table" and ww["supplier"] == "Woolworths" and ww["number"] == "300000001" and ww["date"] == "15 Oct 2026", ww
    names = [i["desc"] for i in ww["items"]]
    assert len(names) == 7, names
    assert names[0].startswith("Huggies gentle cleanse") and not any(n in ("Baby", "Drinks", "Gift Ideas") for n in names), names
    vit = ww["items"][3]; assert vit["desc"].startswith("Vitasoy") and vit["unitsReceived"] == 4 and vit["unitCost"] == 2.5, vit
    oats = ww["items"][1]; assert oats["unitCost"] == 4.195, oats                       # 2 for $8.39 (discount)
    ed = ww["items"][6]; assert ed["desc"].endswith("that wraps") and ed["status"] == "NOT SUPPLIED" and ed["unitsShort"] == 7, ed
    assert ww["fees"] == [{"desc": "Delivery fee", "amount": 9.0}] and ww["printedTotal"] == 75.14, ww["fees"]
    assert co["supplier"] == "Coles" and co["number"] == "200000002" and len(co["items"]) == 5, [i["desc"] for i in co["items"]]
    assert co["items"][0]["desc"] == "Blistex Lip Balm Conditioning 4.25g" and co["items"][0]["unitCost"] == 3.25
    fin = co["items"][3]; assert fin["unitsShort"] == 1 and fin["unitsReceived"] == 3, fin
    assert abs(co["itemsTotal"] - 82.25) < 0.01 and co["printedTotal"] == 82.25, co["itemsTotal"]
    assert wh["kind"] == "wholesale" and len(wh["items"]) == 6, wh["kind"]
    cc = res["ccep"]
    assert cc["kind"] == "ccep" and cc["number"] == "240000001" and cc["date"] == "14/10/2026", (cc["kind"], cc["number"], cc["date"])
    names = [i["name"] for i in cc["items"]]
    assert names == ["Fanta Orange 600ml", "Mother Rainbow Sherbet 500ml Can", "Monster Mango Loco 500ml Can",
                     "Mount Franklin Still Water 600ml", "Coca-Cola 375ml Can"], names
    fanta, water, cans = cc["items"][0], cc["items"][3], cc["items"][4]
    assert fanta["unitsReceived"] == 24 and abs(fanta["unitCost"] - 2.735) < 0.001, fanta          # 59.67 + 10% GST / 24
    assert water["gst"] == 0 and water["unitCost"] == 1.9571, water                     # no GST on plain water
    assert cans["unitsReceived"] == 48, cans                                            # 2 cases of 24
    assert len(cc["fees"]) == 1 and cc["fees"][0]["desc"].startswith("Promo Pricing") and cc["fees"][0]["amount"] == -31.0, cc["fees"]
    assert abs(cc["total"] - 252.55) < 0.02 and cc["printedTotal"] == 252.55, (cc["total"], cc["printedTotal"])
    print("invoice pdf tests passed")

if __name__ == "__main__":
    main(sys.argv[1:])
