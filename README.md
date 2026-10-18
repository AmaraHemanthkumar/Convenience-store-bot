# Convenience Store Bot

A helper for the shop's **PosPort Back Office** (manager.posport.com.au). It does three jobs:

1. **Add new items.** You give it an Excel sheet of barcodes. It looks up each product's normal price at Woolworths and Coles, using the regular price rather than any special. Our price is the **higher of the two + $1.50**, with no rounding. It writes a short label name that includes the size, picks a category, and fills PosPort's **Bulk Create Items** page. It also produces an Excel price comparison for your records.
2. **Price check existing items.** It reads every item and price from Catalog › Items, then compares them with Woolworths and Coles. An item is flagged when our price is **less than $1.50** or **more than $2.00** above the highest supermarket price. You type the new prices into a **New price** column, and the bot can change them in PosPort for you.
3. **Labels.** It searches each item in Catalog › Items, ticks its checkbox, and presses **Print labels**. You then choose the label stock (Dymo 30336 etc.) and print.

There are two versions. Both use the same logic, which lives in `extension/core/`:

| | Chrome extension (recommended) | Python version |
|---|---|---|
| Install | Nothing to install, just load the folder in Chrome | Needs Python 3.10+ (Windows 10 or newer) |
| Use | A dashboard page with buttons and an editable table | A menu in a black window, with review done in Excel |
| Login | Uses your normal Chrome, where you're already logged in | Opens its own browser window, so you log in once |

---

## Chrome extension

### Install (once)
1. Download this repo: green **Code** button → **Download ZIP**, then unzip it, for example to `Documents\Convenience-store-bot`.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside the unzipped repo.
5. Pin the red price-tag icon in the toolbar. Clicking it opens the bot.

After you download a newer version, press the ↻ reload button on the extension card in `chrome://extensions`.

Keep PosPort Back Office logged in in the same Chrome. The bot opens Woolworths, Coles and PosPort in their own tabs and works in them, so leave those tabs open while it runs.

### 1 · Add new items
1. **Choose Excel file.** This is a sheet with a `Barcode` column (see `samples/barcodes-template.xlsx`). The optional `Name`, `Category` and `Price` columns override what the bot would choose.
2. **Look up prices.** For each barcode the table shows:
   - the Woolworths and Coles normal prices, with any special shown in orange;
   - the highest of the two, and our price;
   - the label name, with a character counter (28 fits a Dymo 25×54 mm label at Medium size);
   - the category.

   **check** means the product was matched by name rather than by barcode, so make sure it's the same item. **not found** means you need to type the price and name yourself. **exists** means the barcode is already in PosPort, according to the last scan in Price check.
3. Edit anything you like in the table.
4. **Load categories from PosPort** reads the real category list from Bulk Create. You only need to do this once, or again after you add categories.
5. **Create in PosPort** opens Bulk Create, adds rows (plus one spare empty row, because of the bug), and fills the name, barcode, price and category. Variants and modifiers are left empty. The bot then **stops and waits for you to press Create** in PosPort. Once you trust it, tick *Press "Create" automatically* in Settings.
6. **Download comparison Excel** saves the cross-check sheet.
7. **Send names to Labels** passes the new items straight to the Labels tab.

### 2 · Price check
1. **Scan PosPort items** goes through Catalog › Items page by page. Tip: set *Rows per page* to the largest number first, so there are fewer pages.
2. Choose what to check: either **an Excel of barcodes** (it can include a `Name` column), or **Use all scanned items**.
3. **Compare prices.** Flagged rows are marked TOO LOW or TOO HIGH, and **New price** is filled in with highest + $1.50. Change any new price you want, and tick the rows to update.
4. **Download Excel** saves the list.
5. **Update ticked prices in PosPort** opens each item and sets the new price. It shows you the full list before it starts.

### 3 · Labels
PosPort's search only looks at item names, not barcodes. So for each barcode line the bot first works out what the product is (Woolworths, then Coles, then the free barcode databases). It then searches PosPort with the product's key words and picks the item whose words **and size** match. The log shows which item it picked and how sure it was. If it isn't sure, it leaves the item unticked and shows the closest names, so you can paste the exact one. Running **Price check → Scan PosPort items** first makes this faster and more accurate.

Paste item names (one per line, exactly as in PosPort) or load them from Excel, then press **Tick items & open Print labels**.

If the bot has already seen the PosPort ID of every item, it skips the ticking and opens the Print labels page with all of them directly.

### Failed items Excel
Each tab has a **Download failed items** button. It saves an Excel of everything that didn't work, with all the details the bot has:
- why it failed;
- whether the barcode's check digit is OK;
- everything Woolworths and Coles returned (product, size, normal/special price, department, link, other close results);
- the name from the barcode databases;
- the closest PosPort items and the words that were searched;
- ready-made Woolworths and Coles search links.

### Settings
Here you can change:
- the markup ($1.50);
- the flag limits ($1.50 / $2.00);
- the label name length (28);
- the speed;
- the batch size;
- the extra empty row;
- auto-Create.

**Test PosPort page** reports what the bot can see on the PosPort tab that's open. Use it if something stops working.

---

## Python version
1. Install Python from python.org and tick **"Add python.exe to PATH"** during setup.
2. Double-click `python\run_bot.bat`. The first run installs what it needs, which takes a few minutes.
3. A browser window opens. Log in to PosPort there once; it remembers you.
4. Pick an option from the menu:
   - **1 Add new items.** Choose your barcode Excel. The bot looks up prices and writes `python\output\new-items-review-DATE.xlsx`. Open that file, check it, fix rows marked *NOT FOUND* or *CHECK MATCH*, then save and close it. Press Enter, and the bot fills Bulk Create and waits for you to press Create (or type `C` to let it press Create).
   - **2 Price check.** Writes `price-check-DATE.xlsx`, with too-low rows in red and too-high rows in orange. Put your prices in **New price $** and set **Update (Y/N)** to `Y` on the rows you want changed.
   - **3 Update prices.** Choose that edited file. The bot changes only the `Y` rows and writes a log of what it did.
   - **4 Print labels.** Paste names, load them from a file, or use the items created in the last run.
   - **5 Settings.** Loads the category list from PosPort. Other settings are in `python\settings.json`.

---

## Ready-made barcode sheets
`data/distributors-batch42-barcodes.xlsx` contains the 144 barcodes from The Distributors invoice (batch 42, OID 352), typed from photos. Every barcode passes its check-digit test. Items that were out of stock or late from the supplier are highlighted. Lines with no barcode on the invoice are on the **No barcode** tab. Load this file in **Add new items** as it is.

## Good to know
- **Woolworths / Coles checks.** If either site shows a "are you a robot" page, the bot pauses and asks you to solve it in that tab, then continue. It doesn't try to get around these checks.
- **Coles and barcodes.** Coles' website doesn't always find products by barcode. In that case the bot searches Coles by the Woolworths product name and marks the match *check*.
- **Nothing is changed without you.** By default the bot never presses Create on its own. Price updates show the full list first, and labels are never printed for you.
- **If PosPort changes its screens,** the button and field names the bot looks for are listed in `extension/core/posport.js` (`SEL`). They can be overridden in Settings → *Advanced* without editing code.

## First real run — please check
The PosPort steps were built from screenshots and tested against a copy of the page layout (`tests/mock_posport.html`), not the live site. On the first run:
1. Open Bulk Create and press **Settings → Test PosPort page**. It should report a row count and the "Create N Items" button.
2. Try **Add new items** with 2–3 barcodes and check the filled rows before pressing Create.
3. Try **Update prices** on one item. The item edit screen hasn't been seen yet, so this is the step most likely to need a tweak.
4. Try **Labels** with 2 names.

If a step fails, send a screenshot of the PosPort screen together with the message from the bottom of the bot window.

## For developers
```
node tests/rules.test.js                 # pricing / names / categories
python tests/test_posport_mock.py        # PosPort actions on the mock page
python tests/test_extension_e2e.py       # whole extension with fake Woolworths/Coles/PosPort
python tests/test_python_bot.py          # Python version with the same fakes
```
The browser tests need `pip install playwright openpyxl` and `python -m playwright install chromium`.

`extension/vendor/xlsx.full.min.js` is SheetJS Community Edition (Apache 2.0).
