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

### 1 · Items & prices (new items and price checks in one go)
1. **Choose Excel files** (one or several at once), or scan barcodes into the scan box.
   - **Each file becomes one row** with its name, progress and counts: new · in PosPort · flagged · to check.
   - Click the row to **open the whole sheet** and work on it.
   - The bot reads the columns by itself. If a file comes out wrong, use **Columns…** on that file's row to pick them.
   - **The open file is looked up first**, and the other files keep being looked up in the background while you work.
   - **All files move forward together:** every other look-up goes to the file you have open, and the rest take turns across all the other files.
   - **"Not a robot" check pages:** the bot never jumps to the shop's tab or stops. It carries on with the other shop and waits 1 minute (then 2, 4, 8, up to 10). Then it reloads that shop's tab in the background and tries again by itself, filling in the missing prices. Rows show *waiting – will retry…* until then. A note at the top has **Try now**. If the shop keeps refusing, it also has **Open tab**, so you can tick the check yourself when it suits you.
   - **Same barcode twice in a sheet** (e.g. scanned at two spots in the fridge): it is shown once and marked *×2 in this sheet*. The file row says *(+N repeats)*, and the file's **Tickets** button prints one ticket per spot.
   - **Gentle on the shops:** however many look-ups run at once, each shop gets at most one request every 0.7 s (*Gap between requests* in Settings). If a shop shows a check page, the bot goes twice as slow with that shop (up to 8x) and speeds back up after a while.
   - **Price memory:** a product that is on several invoices or sheets is looked up only once. The answer is kept for 12 hours, even after closing the bot. **Look up again** clears it and asks the shops fresh.
   - **Look-ups run in parallel:** Woolworths and Coles are asked at the same time, and 3 items are looked up at once. You can set 1–6 in Settings. If the shops start showing "are you a robot" pages, lower it.
   - **Price sheets:** if a sheet has a plain *Price* (or *New price* / *Shelf price*) column and an item is already in PosPort at a different price, that price goes into *new price* and the row is ticked ("from your sheet"). Press *Save changes* to update PosPort. RRP, cost and shop-price columns are never used this way.
   - **Every file shows all its items**, even ones that are also in another file, so you can fix prices and names from any sheet. Repeats come from price memory instantly. **Create** makes each product only once, and **Save** changes each PosPort item only once. A saved change shows on that item in every file. Loading a file with the same name again replaces its old row.
   - **Each file row has its own buttons:** Create N new · Tick flagged · Save N changes · Tickets (send the whole file to the print list) · Excel · ✕ remove.

   For every barcode the bot:
   - reads your PosPort item list, if it hasn't in the last 12 hours;
   - looks up Woolworths and Coles normal prices, falling back to the free barcode databases when neither shop knows the barcode;
   - sorts it into one of two groups:
     - **New – not in PosPort:** our price is the highest price + markup, the name is the real product name, and a short ticket name and category are made for you.
     - **Already in PosPort:** shows the PosPort price, **TOO LOW / TOO HIGH / OK**, and a suggested new price. The **PosPort name can be edited**: change it, the row is ticked, and **Save changes** renames the item in the Back Office (and changes the price if you set one).
   - asks when it's unsure: *"Already in PosPort as …? Yes, same item / No, it's new"*.
2. Use the filters (**All · New · Already in PosPort · Needs attention**) and edit anything you like.
   - **Markup $ and Markup %** change all new prices at once: price = highest supermarket price × (1 + %) + $. For example $1.50 + 0% (the default), or $0 + 30%, or $1 + 20%.
   - **How "new" is decided:** by **barcode**. When the bot reads your PosPort list, it collects every barcode each item has, including ones inside variants. SKUs and PLUs only count if they look like a barcode. An item whose barcode is not in PosPort is **new**, and the row says why (*"why new: barcode … is not on any of your … PosPort items"*). A PosPort item with a similar name is only offered as *"Already in PosPort as …? Yes / No"*; it never decides on its own. Settings can switch back to "barcode or name". If PosPort itself has few real barcodes, the log warns you and names count again.
   - **Duplicates:** ↻ Re-check PosPort also finds barcodes that are on more than one PosPort item. This can happen when an item was created again under another name; the till only uses one of them, so prices look wrong. Rows the bot created show *created – duplicate?* with both names and prices. **Duplicates** downloads the list. Delete the extra items in the Back Office yourself, because the bot never deletes anything. Create also skips any barcode that is already in PosPort.
   - **↻ Re-check PosPort** reads the list again (do it after adding items in PosPort, and once after updating to 3.1). Rows that had only matched by name, and whose barcode is not in PosPort, go back to new with the suggestion. The age of the bot's copy shows next to *Look up again*. Before **Create**, a copy older than an hour is read again by itself, so nothing is created twice.
   - **Invoice column** (next to Woolworths and Coles): what you paid for one unit on the newest invoice that has this item, plus the supplier, invoice number and date, the supplier RRP, and the margin at our price (red below your lowest margin). Two buttons set the price in one click: **cost + margin %** or **RRP**. For items already in PosPort, the click goes into the new price and ticks the row, ready for *Save changes*.
   - **New prices from:** *Shops* (highest + markup, the default) · *Shops, but never below invoice cost + margin* (safest – you never sell under your margin) · *Invoice cost + margin* · *Supplier RRP*. The *cost + %* box next to it sets the margin. The note under each price says where it came from.
   - **Wrong barcode?** Click it in the row, type the right one and press Tab. That row is looked up again by itself.
3. Save to PosPort:
   - **Create new items** fills Bulk Create (with one spare row). See *If creating fails* below.
   - **Update ticked prices** changes prices of items already in PosPort. **Tick all flagged** ticks every TOO LOW / TOO HIGH item.
4. Created items and changed prices go onto the **print list** in *Tickets & labels* automatically (you can switch this off in Settings).

**Download Excel** saves the full comparison, and **Download failed items** saves everything that needs a hand-check.

**💾 Save and carry on later:** each file row has **💾 Save**, and the toolbar has **💾 Save all**. You get one Excel file:
- One readable sheet per file. *Item Name · Barcode · Price · Category* come first, ready for PosPort, then PosPort name and price, Woolworths, Coles, invoice cost, status and notes.
- A hidden sheet holding everything the bot knows, including your edits, ticks and ticket names.

Load that Excel again (*Choose Excel files*) to carry on exactly where you were, even in a newer version of the bot.
- If the save is younger than 24 hours (Settings), its Woolworths and Coles prices are used as they are, with no new look-ups.
- If it's older, prices are looked up again, but your typed names, prices and ticks are kept.

**Woolworths / Coles on or off:** the tick boxes at the top (*Ask: Woolworths · Coles*) switch a shop off immediately, even mid-run. That's faster, and the shop's column shows *off*. Tick it again later and the bot fills in what it skipped.

**Keep working while PosPort updates:** *Create*, *Save changes*, *Re-check PosPort* and label ticking are PosPort jobs that take turns in the background. A blue bar shows what is running and what is waiting, with *Stop after this item*. Only the rows being sent are greyed out. You can edit other files, load the next batch and look things up meanwhile.

**Working while files load:** background look-ups never redraw the table while you are typing, clicking or scrolling. Finished rows wait and drop in about 2 seconds after you stop, and the page stays where you were. Only the small counts on each file row update straight away.

### Supplier invoice PDFs (used everywhere)
The bot reads three kinds of invoice PDF by itself:
- **Wholesale** invoices with barcodes, such as The Distributors Brisbane.
- **Woolworths** online-order tax invoices (Line · Description · Ordered · Supplied · Price · Amount).
- **Coles for business** online-order invoices (Product · Ordered · Picked · Unit price · Total charged).
- **Coca-Cola Europacific Partners** invoices and delivery slips as PDF from myCCA (Material · Description · Qty · CDS · Price net · Extended). Packs like X24, X 12, Ib24 and 6X4 become units. GST is added only to the lines marked * (plain water has none). The container deposit is included. Credit lines such as "Promo Pricing Error" are counted as credits.

Woolworths and Coles invoices have no barcodes. The bot finds each product at the shop by name and copies the barcode, but only when it is a confident match. The barcode then shows *"(barcode from Woolworths)"*. Scanned or photographed invoices have no text, so download the PDF from the website or email instead.

Drop the invoice PDF into **Items & prices** or **Buying & invoices**. No columns to pick: the bot reads every line (description, barcode, item code, qty, RRP, units per carton, levy, GST) and works out **what one unit really cost you**, inc GST and container deposit. Part cartons such as 0.333 count as whole units.

Every invoice you load is remembered (listed under *Buying & invoices*, ✕ to forget one) and used as a back-up source of information:
- **Items & prices:** the invoice becomes one file row ("Supplier #number · date"). Lines that weren't delivered are left unticked.
- **Cost and margin** show under every price whose barcode is on an invoice, and turn red below the *lowest margin* in Settings.
- **Not at Woolworths/Coles or online?** The name comes from the invoice (supplier short-hand like "NES", "SMT" or "S/CREAM" is spelt out). The price is the invoice **RRP**, or cost + the *fallback margin* in Settings, and it is marked *to check*.
- **Tickets and labels:** an unknown barcode still gets a name from the invoice.
- **Buying & invoices:** compares the real unit cost with today's supermarket prices. The **Not delivered** filter lists out-of-stock / short lines, so you can check you weren't charged.

### 3 · Buying & invoices
Is what you paid a good price, or would it be cheaper at Woolworths or Coles today (specials included)?
- **Load:** an invoice (Excel or a PDF from your supplier, Woolworths or Coles) or a shopping list (several files at once), or scan barcodes.
- **One step:** loading does everything by itself. It looks up Woolworths and Coles (specials included), checks PosPort (reading your item list if it is more than 12 hours old), and works out your margin.
  - Each line says whether the item is **in PosPort** (with its price and TOO LOW / TOO HIGH) or **Not in PosPort**, with a suggested sell price.
  - **Send to Items & prices** sends the new items and the prices to fix to *Items & prices* as one file row, ready to Create / Save.
- **Pick columns:**
  - an invoice needs barcode (or name), quantity, and paid per unit, or paid per carton plus units per carton;
  - a shopping list only needs a barcode or name.
- **Each line shows:**
  - Woolworths and Coles today (normal price and special);
  - the cheapest price and where it is;
  - a verdict: **Cheaper at Woolworths by $x – return / buy there**, **About the same** (tolerance adjustable), or **x% below**;
  - your PosPort sell price and margin.
- **Totals:** what you paid vs the same items at today's cheapest supermarket price, and how much more you paid on the "cheaper elsewhere" items.
- **Filters:** Cheaper elsewhere · On special now (good time to stock up) · Good deal · Not delivered.
- **Downloads:** **Download Excel** saves the full comparison. **Download "return / buy elsewhere" list** saves only the problem lines.

### Scanning barcodes straight in
Every tab has a **scan box**. Click it and scan: each barcode + Enter is added and looked up straight away.
- **USB / Bluetooth scanners** work like a keyboard, so nothing needs installing.
- **To scan with a phone:** a phone app such as *Barcode to PC* (free) sends each scan to the laptop as if typed. Put the cursor in the scan box and scan with the phone.

### Backup
**Back up everything** opens every page in the Back Office menu (catalog, categories, modifiers, variants, units, customers, inventory, settings…). It reads all of their pages and saves two files:
- **posport-backup-DATE.xlsx:** a *Contents* sheet, one sheet per section, and one sheet per data list the Back Office loads, with every field.
- **posport-backup-DATE.json:** every record exactly as PosPort sends it, which another POS system or a developer can import.

It only reads. **Items only (quick)** backs up just the item list.

### Whole-shop price check
1. **Scan PosPort items** goes through Catalog › Items page by page. Tip: set *Rows per page* to the largest number first, so there are fewer pages.
2. Choose what to check: either **an Excel of barcodes** (it can include a `Name` column), or **Use all scanned items**.
3. **Compare prices.** Flagged rows are marked TOO LOW or TOO HIGH, and **New price** is filled in with highest + $1.50. Change any new price you want, and tick the rows to update.
4. **Download Excel** saves the list.
5. **Update ticked prices in PosPort** opens each item and sets the new price. It shows you the full list before it starts.

### PosPort's own label page (inside *Tickets & labels*)
PosPort's search only looks at item names, not barcodes. So for each barcode line the bot first works out what the product is (Woolworths, then Coles, then the free barcode databases). It then searches PosPort with the product's key words and picks the item whose words **and size** match. The log shows which item it picked and how sure it was. If it isn't sure, it leaves the item unticked and shows the closest names, so you can paste the exact one. Running **Price check → Scan PosPort items** first makes this faster and more accurate.

Paste item names (one per line, exactly as in PosPort) or load them from Excel, then press **Tick items & open Print labels**.

If the bot has already seen the PosPort ID of every item, it skips the ticking and opens the Print labels page with all of them directly.

### Short names
The first word (brand) is never changed. When a name is too long, the bot shortens it in this order:
1. Drops filler words (bag, bottle, with…).
2. Uses shelf shorthand: Classic→CLS, Special→SPL, Chocolate→CHOC, Chicken→CHKN, Sour Cream→S/CRM, Sugar Free→S/F and about 100 more. Add your own in **Settings** (`Classic=CLS`, one per line).
3. Drops words like *Potato Chips*, *Pasta Sauce* or *Cup A Soup*.
4. Squeezes long words to their consonants (Cauliflower→CLFLW).
5. As a last resort, drops middle words.

The size always stays. **Redo short names** remakes the names after you change the length or shorthand. Names you typed yourself are kept.

### Items that weren't ticked
After a labels run, every item the bot couldn't tick is listed under **Not ticked**:
- **Is it one of these PosPort items?** Shows the closest PosPort items with their price and match %. Pick the right one, then press **Run labels again with my picks**.
- **Add to Back Office** (or **Add all missing to Back Office**) sends the barcode and product name to **1 · Add new items**. There you press *Look up prices* and create it like any new item.

With 5 or more barcodes and no scan yet, the bot offers to read all PosPort item names first, which is faster and more accurate.

### Failed items Excel
Each tab has a **Download failed items** button, and the file also downloads automatically at the end of a run when something failed (you can turn this off in Settings). It saves an Excel of everything that didn't work, with all the details the bot has:
- why it failed;
- whether the barcode's check digit is OK;
- everything Woolworths and Coles returned (product, size, normal/special price, department, link, other close results);
- the name from the barcode databases;
- the closest PosPort items and the words that were searched;
- ready-made Woolworths and Coles search links.

### Two names per item
- **Name in PosPort:** the real product name, tidied up (up to 60 characters). This makes PosPort searches, receipts and the bot's own matching work better.
- **Name on ticket:** made from it with the shelf shorthand (up to 40 characters, so it fits on two lines).

Both are shown in the Add table and you can edit either one. To save the short name in PosPort as well, tick the option in Settings.

### 2 · Tickets & labels (print your own shelf tickets)
- **Whole category:** pick a PosPort category (e.g. *CONFECTIONERY*) and press **Add all in category**. Every item in it goes onto the print list with its PosPort name, price and barcode. Press ↻ first to read the PosPort list again if prices changed. If PosPort's list doesn't give category names, the bot groups items by its own guess from the name.
These are made by the bot itself, so you don't need PosPort's label page:
- **Sizes:** 2.5 or 3 inches wide, 1 or 1.25 inches tall, or any custom size.
- **On each ticket:** the name (as large as fits on 2 lines), a big price, the size, the unit price (e.g. $6.32 per 100g), and a scannable barcode (EAN-13/EAN-8/UPC; anything else is drawn as Code 128). Optionally the shop name and date.
- **Layouts:**
  - **Bold** – big price on the right.
  - **PosPort style** – price under the name, barcode centred, like the PosPort label page.
  - **Compact** – name and price side by side.
- **Specials:** fill in **Was $** and the ticket gets a black SPECIAL tag with the old price crossed out.
- **Where items come from:**
  - added automatically after creating items or changing prices;
  - **From Items & prices**;
  - **Load Excel / CSV**;
  - pasted lines: `Name | Price | Barcode`, or just a **barcode** (the bot finds the item and its price in PosPort).
  - *Load Excel / CSV* reads the Excel files the bot saved: price check, price updates, new-items comparison and failed items.
  - It also reads your own sheet with a name column and a price column (barcode, was-price and copies are optional).
  - For a price-check file it uses the **New price** where one is filled in, and asks whether to load only the items whose price changed.
- **Paper:** *A4 paper* (the default) fits as many as possible per page:
  - It leaves safe margins so no row is lost at the printer's edge.
  - **Gap between tickets** (2 mm by default) leaves room for cutting.
  - **Rows per A4 page** can be raised if your printer allows more.
  - The browser adds no date or address headers. *Label printer roll* prints one ticket per label.
- **When printing:** keep scale at **100%** (not "Fit to page"). The barcodes are drawn at exact printer-dot widths, so they print sharp and scan.

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
node tests/invoice.test.js               # supplier invoice PDF lines -> unit cost
node tests/capture.test.js               # barcodes read from PosPort's own item data
python tests/test_invoice_pdfs.py [x.pdf]  # reads made-up wholesale / Woolworths / Coles PDFs (or your own files)
python tests/test_posport_mock.py        # PosPort actions on the mock page
python tests/test_extension_e2e.py       # whole extension with fake Woolworths/Coles/PosPort
python tests/test_python_bot.py          # Python version with the same fakes
```
The browser tests need `pip install playwright openpyxl` and `python -m playwright install chromium`.

`extension/vendor/xlsx.full.min.js` is SheetJS Community Edition (Apache 2.0).
