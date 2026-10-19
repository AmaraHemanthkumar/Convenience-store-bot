/* Convenience Store Bot - dashboard controller */
'use strict';

const R = window.CSB_RULES;
const POS = 'https://manager.posport.com.au';
const STORES = {
  ww: { match: 'https://www.woolworths.com.au/*', home: 'https://www.woolworths.com.au/', label: 'Woolworths' },
  coles: { match: 'https://www.coles.com.au/*', home: 'https://www.coles.com.au/', label: 'Coles' },
};

let S = Object.assign({}, R.DEFAULT_SETTINGS, { selectors: {} });
let categories = R.DEFAULT_CATEGORIES.slice();
const state = { add: [], check: [], checkInput: [], catalogue: [], labels: [], tickets: [], tkOpts: {}, buy: [] };
let busy = false;
let stopRequested = false;

// ---------------- names ----------------
// PosPort keeps the real product name (tidied); tickets get the short shelf name.
const posNameOf = (full, size) => R.shortName(full, size || '', S.shortInPosPort ? S.ticketNameMax : S.nameMaxLength);
const ticketNameOf = (full, size) => R.shortName(full, size || '', S.ticketNameMax);
function setNames(r, full, size) {
  if (!full) return;
  r.full = full; r.fullSize = size || '';
  if (!r.nameEdited) r.name = posNameOf(full, size);
  if (!r.tnameEdited) r.tname = ticketNameOf(r.nameEdited ? r.name : full, r.nameEdited ? '' : size);
}

// ---------------- small utilities ----------------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : '$' + Number(n).toFixed(2));
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

function log(msg, cls) {
  const li = document.createElement('li');
  li.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  if (cls) li.className = cls;
  $('log').prepend(li);
}

function setBusy(on) {
  busy = on;
  document.querySelectorAll('button.btn').forEach((b) => {
    if (b.id === 'bannerContinue' || b.id === 'bannerStop') return;
    if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; } else if (b.dataset.wasDisabled !== undefined) { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled; }
  });
  if (on) stopRequested = false;
  if (!on) refreshButtons();
}

// Banner with several choices; resolves with the chosen label.
function choose(text, labels) {
  return new Promise((resolve) => {
    const bar = $('banner');
    $('bannerText').textContent = text;
    $('bannerContinue').classList.add('hidden'); $('bannerStop').classList.add('hidden');
    const extra = labels.map((l, i) => { const b = document.createElement('button'); b.className = 'btn small choice' + (i === 0 ? ' primary' : ''); b.textContent = l; bar.appendChild(b); return b; });
    bar.classList.remove('hidden');
    extra.forEach((b) => { b.onclick = () => {
      extra.forEach((x) => x.remove());
      $('bannerContinue').classList.remove('hidden'); $('bannerStop').classList.remove('hidden');
      bar.classList.add('hidden');
      if (/stop/i.test(b.textContent)) stopRequested = true;
      resolve(b.textContent);
    }; });
  });
}

// Show a problem in the banner (not just the log) and wait for OK.
async function problem(text) {
  log(text, 'err');
  await pause('⚠ ' + text);
}

// Pause with a banner until the user presses Continue (true) or Stop (false).
function pause(text) {
  return new Promise((resolve) => {
    $('bannerText').textContent = text;
    $('banner').classList.remove('hidden');
    const done = (v) => { $('banner').classList.add('hidden'); $('bannerContinue').onclick = null; $('bannerStop').onclick = null; resolve(v); };
    $('bannerContinue').onclick = () => done(true);
    $('bannerStop').onclick = () => { stopRequested = true; done(false); };
  });
}

// ---------------- persistence ----------------
async function loadAll() {
  const d = await chrome.storage.local.get(['settings', 'categories', 'add', 'check', 'checkInput', 'catalogue', 'tickets', 'tkOpts', 'catalogueAt', 'buy', 'files', 'invoices']);
  if (d.settings) S = Object.assign({}, S, d.settings);
  if (!S.namesV2) { if (S.nameMaxLength === 28) S.nameMaxLength = 60; S.namesV2 = true; chrome.storage.local.set({ settings: S }); }
  if (d.categories && d.categories.length) categories = d.categories;
  ['add', 'check', 'checkInput', 'catalogue', 'tickets', 'buy'].forEach((k) => { if (Array.isArray(d[k])) state[k] = d[k]; });
  if (d.tkOpts) state.tkOpts = d.tkOpts;
  state.catalogueAt = d.catalogueAt || 0;
  state.files = Array.isArray(d.files) ? d.files : [];
  state.invoices = Array.isArray(d.invoices) ? d.invoices : [];
  const pc = await chrome.storage.local.get('priceCache');
  Object.entries(pc.priceCache || {}).forEach(([k, v]) => { if (v && Date.now() - v.at < PRICE_CACHE_HOURS * 3600000) priceCache.set(k, v); });
}
// Saving everything after every single look-up is slow with 1000+ rows: save at most about once a second.
let saveTimer = null, saveWaiters = [], lastSave = 0;
function saveState() {
  return new Promise((resolve) => {
    saveWaiters.push(resolve);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null; lastSave = Date.now();
      const w = saveWaiters; saveWaiters = [];
      saveStateNow().then(() => w.forEach((f) => f()), () => w.forEach((f) => f()));
    }, Math.max(0, 1000 - (Date.now() - lastSave)));
  });
}
window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveStateNow(); } savePriceCache(true); });
function saveStateNow() {
  return chrome.storage.local.set({ add: state.add, check: state.check, checkInput: state.checkInput, catalogue: state.catalogue, categories, tickets: state.tickets, tkOpts: state.tkOpts, catalogueAt: state.catalogueAt || 0, buy: state.buy, files: state.files || [], invoices: state.invoices || [] });
}

// ---------------- browser tabs ----------------
function waitComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const end = Date.now() + (timeout || 30000);
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve(t);
      } catch (e) { return resolve(null); }
      if (Date.now() > end) return resolve(null);
      setTimeout(check, 250);
    };
    check();
  });
}

async function findOrOpen(match, home) {
  const tabs = await chrome.tabs.query({ url: match });
  if (tabs.length) return tabs[0].id;
  const t = await chrome.tabs.create({ url: home, active: false });
  await waitComplete(t.id);
  await sleep(1500);
  return t.id;
}

async function exec(tabId, files, func, args) {
  try {
    if (files && files.length) await chrome.scripting.executeScript({ target: { tabId }, files });
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    return res ? res.result : { ok: false, error: 'No result' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------- PosPort ----------------
async function posTab() {
  return findOrOpen(POS + '/*', POS + '/catalog/items');
}

async function pos(action, ...args) {
  const tabId = await posTab();
  return exec(tabId, ['core/posport.js'], async (a, argv, ov) => {
    try {
      CSB_POSPORT.applyOverrides(ov);
      return await CSB_POSPORT[a].apply(null, argv);
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }, [action, args, S.selectors || {}]);
}

async function posGo(path, wantPage) {
  const tabId = await posTab();
  await chrome.tabs.update(tabId, { url: POS + path });
  await sleep(400);
  await waitComplete(tabId);
  for (let i = 0; i < 40; i++) {
    const info = await pos('pageInfo');
    if (info && info.page === 'login') {
      const go = await pause('Please log in to PosPort in its tab, then press Continue.');
      if (!go) return false;
      await chrome.tabs.update(tabId, { url: POS + path });
      await waitComplete(tabId);
      continue;
    }
    if (info && (!wantPage || info.page === wantPage)) {
      // give the app a moment to draw its table/form
      if (wantPage === 'bulk') { const st = await pos('bulkStatus'); if (st && st.rows > 0) return true; }
      else if (wantPage === 'items') { const st = await pos('readListRows'); if (st && st.rows && st.rows.length) return true; }
      else return true;
    }
    await sleep(500);
  }
  return wantPage === 'items'; // an empty list is still the list page
}

// ---------------- supermarkets ----------------
const storeTabOpening = {}, storeBlocked = {};
// Be polite to the shops: whatever the number of parallel look-ups, each shop gets at most one request
// every storeGapMs. After a check page the gap doubles for that shop (up to 8x) and slowly comes back.
const storeNext = {}, storeSlow = {}, storeOk = {};
async function storeTurn(kind) {
  const gap = (S.storeGapMs || 700) * (storeSlow[kind] || 1);
  const now = Date.now();
  const at = Math.max(now, storeNext[kind] || 0);
  storeNext[kind] = at + gap;
  if (at > now) await sleep(at - now);
}
function storeWasFine(kind) {
  storeOk[kind] = (storeOk[kind] || 0) + 1;
  if ((storeSlow[kind] || 1) > 1 && storeOk[kind] >= 60) { storeSlow[kind] = Math.max(1, storeSlow[kind] / 2); storeOk[kind] = 0; }
}
async function storeTab(kind) {
  const cfg = STORES[kind];
  if (!storeTabOpening[kind]) storeTabOpening[kind] = findOrOpen(cfg.match, cfg.home).finally(() => { setTimeout(() => { storeTabOpening[kind] = null; }, 0); });
  return storeTabOpening[kind];
}
async function storeCall(kind, fn, args) {
  const cfg = STORES[kind];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (storeBlocked[kind]) await storeBlocked[kind];          // another lookup is waiting for you to solve a check
    const tabId = await storeTab(kind);
    await storeTurn(kind);
    const res = await exec(tabId, ['core/rules.js', 'core/stores.js'], async (f, argv) => {
      try { return await CSB_STORES[f].apply(null, argv); } catch (e) { return { found: false, error: String(e && e.message || e) }; }
    }, [fn, args]);
    if (res && res.error && /error page|cannot access|no tab|frame/i.test(res.error) && attempt < 2) {
      // tab is on an error/offline page: reload the store's home page and try again
      await chrome.tabs.update(tabId, { url: cfg.home });
      await waitComplete(tabId);
      await sleep(1500);
      continue;
    }
    if (res && res.blocked) {
      if (storeBlocked[kind]) { const go = await storeBlocked[kind]; if (!go) return Object.assign(res, { error: 'Stopped' }); continue; }
      await chrome.tabs.update(tabId, { active: true });
      storeSlow[kind] = Math.min(8, (storeSlow[kind] || 1) * 2); storeOk[kind] = 0;
      log(cfg.label + ' asked for a check – the bot will now go ' + storeSlow[kind] + 'x slower with ' + cfg.label + ' for a while.', 'err');
      storeBlocked[kind] = pause(cfg.label + ' is showing a check page (or blocked the request). Solve it in that tab, then press Continue.' +
        (S.parallel > 1 ? ' Tip: set fewer parallel look-ups in Settings if this keeps happening.' : ''));
      const go = await storeBlocked[kind];
      storeBlocked[kind] = null;
      if (!go) return Object.assign(res, { error: 'Stopped' });
      continue;
    }
    if (res && !res.error) storeWasFine(kind);
    return res || { found: false, error: 'No answer' };
  }
  return { found: false, error: cfg.label + ' kept blocking requests' };
}

// ---- price memory: the same product on many invoices/sheets is looked up only once ----
// Kept for 12 hours (also after closing the bot). "Look up again" clears it.
const PRICE_CACHE_HOURS = 12;
const priceCache = new Map();      // key -> { at, ww, coles, highest }
const priceInFlight = new Map();   // key -> promise, so two rows with the same product share one look-up
let cacheTimer = null;
const priceKey = (barcode, name) => (R.cleanBarcode(barcode || '') ? 'b:' + R.cleanBarcode(barcode).replace(/^0+/, '') : 'n:' + String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
function savePriceCache(now) {
  const write = () => {
    cacheTimer = null;
    const obj = {};
    Array.from(priceCache.entries()).slice(-6000).forEach(([k, v]) => { obj[k] = v; });
    chrome.storage.local.set({ priceCache: obj });
  };
  if (now) { if (cacheTimer) { clearTimeout(cacheTimer); write(); } return; }
  if (!cacheTimer) cacheTimer = setTimeout(write, 5000);
}
function clearPriceCache() { priceCache.clear(); chrome.storage.local.set({ priceCache: {} }); }
let cacheHits = 0;
async function lookupPrices(barcode, nameHint) {
  const key = priceKey(barcode, nameHint);
  if (key === 'n:') return lookupPricesLive(barcode, nameHint);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_CACHE_HOURS * 3600000) { cacheHits++; return JSON.parse(JSON.stringify({ ww: hit.ww, coles: hit.coles, highest: hit.highest, cached: true })); }
  if (priceInFlight.has(key)) { cacheHits++; return priceInFlight.get(key).then((x) => JSON.parse(JSON.stringify(x))); }
  const p = lookupPricesLive(barcode, nameHint).then((res) => {
    // only remember real answers (not blocked pages / errors)
    const ok = (x) => x && (x.found || (!x.error && !x.blocked));
    if (ok(res.ww) && ok(res.coles)) { priceCache.set(key, { at: Date.now(), ww: res.ww, coles: res.coles, highest: res.highest }); savePriceCache(); }
    return res;
  }).finally(() => priceInFlight.delete(key));
  priceInFlight.set(key, p);
  return p;
}
async function lookupPricesLive(barcode, nameHint) {
  // Woolworths and Coles are asked at the same time
  let [ww, coles] = await Promise.all([
    storeCall('ww', 'wwLookup', [barcode, nameHint || '']),
    storeCall('coles', 'colesLookup', [barcode, nameHint || '']),
  ]);
  // Coles often can't find a barcode: try again with the Woolworths product name
  if (!(coles && coles.found) && ww && ww.found && ww.name !== nameHint) coles = await storeCall('coles', 'colesLookup', ['', ww.name]);
  const highest = R.highestPrice(ww && ww.found ? ww.regular : null, coles && coles.found ? coles.regular : null);
  return { ww, coles, highest };
}

// Run `work` on items from `next()` with up to n at the same time.
async function runPool(n, next, work) {
  const workers = Array.from({ length: Math.max(1, n) }, async (_, k) => {
    await sleep(k * 250);                          // stagger the start
    for (;;) { const item = next(); if (!item) return; await work(item); }
  });
  await Promise.all(workers);
}

// ---------------- Excel ----------------
async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

function writeSheet(rows, filename, sheetName) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const keys = Object.keys(rows[0] || {});
  ws['!cols'] = keys.map((k) => ({ wch: Math.min(45, Math.max(k.length + 2, ...rows.map((r) => String(r[k] === null || r[k] === undefined ? '' : r[k]).length + 1))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  XLSX.writeFile(wb, filename);
}

// All the detail we have about one supermarket result, as spreadsheet columns.
// ---------------- supplier invoices: the bot remembers every line it has read ----------------
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const INV = window.CSB_INVOICE;
let invIndex = null;
function invoiceIndex() {
  if (invIndex) return invIndex;
  invIndex = { byBarcode: new Map(), byCode: new Map(), byName: new Map() };
  // newest invoice wins
  (state.invoices || []).slice().sort((a, b) => (a.loadedAt || 0) - (b.loadedAt || 0)).forEach((inv) => {
    inv.items.forEach((it) => {
      const rec = Object.assign({ supplier: inv.supplier, number: inv.number, date: inv.date }, it);
      if (it.barcode) invIndex.byBarcode.set(R.cleanBarcode(it.barcode).replace(/^0+/, ''), rec);
      if (it.code && it.barcode) invIndex.byCode.set(it.code, rec);
      invIndex.byName.set(nameKey(it.name || INV.tidyName(it.desc)), rec); invIndex.byName.set(nameKey(it.desc), rec);
    });
  });
  return invIndex;
}
// by barcode, or by name (Woolworths / Coles invoices have no barcodes)
function invoiceFor(barcode, name) {
  const k = R.cleanBarcode(barcode || '').replace(/^0+/, '');
  const hit = k ? invoiceIndex().byBarcode.get(k) : null;
  if (hit) return hit;
  for (const n of [].concat(name || [])) { const h = n && invoiceIndex().byName.get(nameKey(n)); if (h) return h; }
  return null;
}
async function readInvoicePdf(file) {
  const inv = await INV.readPdf(await file.arrayBuffer());
  inv.file = file.name; inv.loadedAt = Date.now();
  inv.id = 'inv-' + (inv.number || file.name) ;
  if (!inv.items.length) throw new Error(inv.lineCount ? 'No item lines found in ' + file.name + ' – this invoice layout is new to the bot, please send it to me' : file.name + ' has no text – it looks like a scan or photo. Download the PDF from the supplier\'s website or email instead.');
  state.invoices = (state.invoices || []).filter((x) => x.id !== inv.id).concat([inv]);
  invIndex = null;
  saveState(); renderInvoices();
  if (state.add.some((r) => r.status === 'not found' && invoiceFor(r.barcode))) setTimeout(() => startLookup(), 0);
  const diff = inv.printedTotal ? Math.abs(inv.printedTotal - inv.total) : 0;
  log((inv.supplier || 'Invoice').replace(/ Pty Ltd/i, '') + ' invoice ' + (inv.number || file.name) + ' (' + (inv.date || '') + '): ' + inv.items.length + ' lines' + (inv.fees.length ? ' + ' + inv.fees.map((x) => x.desc + ' ' + m(x.amount)).join(', ') : '') + ', $' + inv.total.toFixed(2) +
    (diff > 1 ? ' – the invoice says $' + inv.printedTotal.toFixed(2) + ', check the lines (maybe freight or a line the bot could not read).' : ''), diff > 1 ? 'err' : 'ok');
  return inv;
}
function renderInvoices() {
  const box = $('invList');
  if (!box) return;
  const list = state.invoices || [];
  box.innerHTML = list.length ? '<b>Invoices the bot knows</b> (used for names, costs and margins everywhere):<br>' + list.map((x) =>
    '<span class="inv-chip">' + esc((x.supplier || 'Supplier').replace(/ Pty Ltd/i, '') + ' #' + (x.number || x.file) + ' · ' + (x.date || '') + ' · ' + x.items.length + ' lines') +
    ' <button class="fx inv-del" data-id="' + esc(x.id) + '" title="Forget this invoice">✕</button></span>').join(' ') : '<span class="muted">No invoices yet – load a supplier PDF here or in Items &amp; prices.</span>';
}

// ---------------- "Which column is which?" ----------------
const ROLE_NAMES = {
  _: '–', barcode: 'Barcode', name: 'Name', hint: 'Supplier text (search help)', category: 'Category', price: 'Price',
  qty: 'Quantity', cost: 'Paid per unit', costOuter: 'Paid per carton', units: 'Units per carton', was: 'Was price',
};
const ROLE_GUESS = [
  ['barcode', /barcode|ean|upc|gtin|apn/],
  ['costOuter', /(cost|price|paid|amount).*(outer|carton|case|ctn)|(outer|carton|case|ctn).*(cost|price)/],
  ['units', /units?\s*(per|\/|in)\s*(outer|carton|case|ctn|pack)|^units$|pack\s*size|^upc$/],
  ['cost', /unit\s*cost|cost\s*(ex|inc)?|^cost|paid|nett?\s*price|^net\b|buy\s*price|cost price/],
  ['qty', /qty|quantity|shipped|ordered|^count$/],
  ['hint', /supplier|invoice|description|desc\b|item description/],
  ['category', /categ|department|dept/],
  ['was', /^was|special/],
  ['price', /price|rrp|sell/],
  ['name', /name|product|item|title/],
];
function guessRoles(header, roles, sample) {
  const used = new Set();
  return header.map((h, i) => {
    const t = String(h || '').toLowerCase();
    for (const [role, re] of ROLE_GUESS) {
      if (!roles.includes(role) || used.has(role)) continue;
      if (re.test(t)) { used.add(role); return role; }
    }
    // no header text: a column of 8–14 digit codes is the barcode
    if (!used.has('barcode') && roles.includes('barcode') && sample.length && sample.filter((r) => /^\d{8,14}$/.test(String(r[i] || '').replace(/\.0$/, ''))).length >= sample.length * 0.6) { used.add('barcode'); return 'barcode'; }
    return '_';
  });
}

// Same window, but returns just the chosen columns (used by "Columns…" on a file)
function mapColumnsPicks(fileName, rows, roles) {
  return new Promise((resolve) => {
    mapColumns(fileName, rows, roles).then((out) => {
      if (!out) { resolve(null); return; }
      resolve(lastPicks);
    });
  });
}
let lastPicks = null;
let mapResolve = null;
function mapColumns(fileName, rows, roles, hint) {
  return new Promise((resolve) => {
    rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (!rows.length) { resolve(null); return; }
    const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
    const first = rows[0].map((c) => String(c || '').trim());
    const hasHeader = first.some((c) => c && !/^[\d.,$\s-]+$/.test(c));
    const header = hasHeader ? first : Array.from({ length: width }, (_, i) => 'Column ' + String.fromCharCode(65 + (i % 26)));
    const body = hasHeader ? rows.slice(1) : rows;
    const sig = header.join('|').toLowerCase();
    const saved = (S.colMaps || {})[sig];
    let picks = saved && saved.length === width ? saved.slice() : guessRoles(header.concat(Array(width - header.length).fill('')), roles, body.slice(0, 20));
    const opts = (sel) => ['_'].concat(roles).map((r) => '<option value="' + r + '"' + (r === sel ? ' selected' : '') + '>' + ROLE_NAMES[r] + '</option>').join('');
    const draw = () => {
      $('mapTable').innerHTML = '<thead><tr>' + Array.from({ length: width }, (_, i) =>
        '<th><select data-c="' + i + '" class="' + (picks[i] === '_' ? 'none' : '') + '">' + opts(picks[i]) + '</select><span class="colname">' + esc(header[i] || '') + '</span></th>').join('') + '</tr></thead><tbody>' +
        body.slice(0, 8).map((r) => '<tr>' + Array.from({ length: width }, (_, i) => '<td>' + esc(r[i] === undefined ? '' : r[i]) + '</td>').join('') + '</tr>').join('') + '</tbody>';
    };
    $('mapTitle').textContent = 'Which column is which? – ' + fileName;
    $('mapHint').textContent = (hint || 'Pick what each column holds. Columns set to "–" are ignored.') + ' Showing the first rows of ' + body.length + '.';
    $('mapCount').textContent = '';
    draw();
    $('mapModal').classList.remove('hidden');
    $('mapTable').onchange = (e) => {
      const c = +e.target.dataset.c;
      // one column per role
      picks = picks.map((p, i) => (i !== c && p === e.target.value && p !== '_' ? '_' : p));
      picks[c] = e.target.value;
      draw();
    };
    const done = (ok) => {
      $('mapModal').classList.add('hidden');
      if (!ok) { resolve(null); return; }
      S.colMaps = Object.assign({}, S.colMaps || {}, { [sig]: picks });
      lastPicks = picks.slice();
      chrome.storage.local.set({ settings: S });
      const out = body.map((r) => {
        const o = {};
        picks.forEach((role, i) => { if (role !== '_') o[role] = r[i]; });
        return o;
      });
      resolve(out);
    };
    $('mapOk').onclick = () => done(true);
    $('mapSkip').onclick = () => done(false);
  });
}

function storeCols(label, x) {
  const o = {};
  o[label + ' found'] = x ? (x.found ? 'yes' : (x.blocked ? 'blocked' : 'no')) : 'not checked';
  o[label + ' matched by'] = x && x.found ? (x.match || '') : '';
  o[label + ' product'] = x && x.found ? x.name || '' : '';
  o[label + ' size'] = x && x.found ? x.size || '' : '';
  o[label + ' normal $'] = x && x.found ? (x.regular || '') : '';
  o[label + ' shelf now $'] = x && x.found ? (x.now || '') : '';
  o[label + ' was $'] = x && x.found ? (x.was || '') : '';
  o[label + ' on special'] = x && x.found ? (x.onSpecial ? 'yes' : 'no') : '';
  o[label + ' department'] = x && x.found ? x.dept || '' : '';
  o[label + ' product code'] = x && x.found ? (x.stockcode || x.id || '') : '';
  o[label + ' link'] = x && x.found ? x.url || '' : '';
  o[label + ' error'] = x && x.error ? x.error : '';
  o[label + ' other results'] = x && x.candidates && x.candidates.length
    ? x.candidates.map((c) => c.name + (c.regular ? ' $' + Number(c.regular).toFixed(2) : '')).join(' | ') : '';
  return o;
}

function downloadFailed(rows, prefix, sheet) {
  if (!rows.length) { log('Nothing failed – no file needed.', 'ok'); return; }
  writeSheet(rows, prefix + '-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-') + '.xlsx', sheet);
  log('Downloaded ' + rows.length + ' failed items.', 'ok');
}

function storeCell(s) {
  if (!s) return '<span class="muted">—</span>';
  if (s.error && !s.found) return '<span class="pill bad" title="' + esc(s.error) + '">error</span>';
  if (!s.found) return '<span class="muted">not found</span>';
  const special = s.onSpecial && s.now && s.regular && s.now < s.regular ? '<span class="special"> special now ' + m(s.now) + '</span>' : '';
  return '<div class="store"><b>' + m(s.regular) + '</b>' + special +
    '<small>' + (s.url ? '<a href="' + esc(s.url) + '" target="_blank">' + esc(s.name) + '</a>' : esc(s.name)) + '</small>' +
    (s.match && s.match !== 'barcode' ? '<small class="special">' + esc(s.match) + '</small>' : '') + '</div>';
}

// =====================================================================
// 1. ADD NEW ITEMS
// =====================================================================
function addStatusPill(r) {
  if (r.pos) {
    if (r.updated === true) return '<span class="pill ok">price updated</span>';
    if (r.updated === false) return '<span class="pill bad" title="' + esc(r.note || '') + '">update failed</span>';
    return '<span class="pill idle">in PosPort</span>';
  }
  if (r.looking) return '<span class="pill idle">looking up…</span>';
  const map = { waiting: 'idle', ready: 'ok', check: 'warn', 'not found': 'bad', created: 'ok', filled: 'warn', error: 'bad', skipped: 'idle' };
  return '<span class="pill ' + (map[r.status] || 'idle') + '" title="' + esc(r.note || '') + '">' + esc(r.status === 'ready' ? 'new – ready' : r.status) + '</span>';
}

const needsAttention = (r) => ['not found', 'error', 'check', 'filled'].includes(r.status) || !!r.maybe || r.updated === false ||
  (r.pos && r.chk && r.chk.flagged && r.updated !== true);
const inFilter = (r) => {
  const f = state.addFilter || 'all';
  return f === 'all' || (f === 'new' && !r.pos) || (f === 'pos' && !!r.pos) || (f === 'attn' && needsAttention(r));
};

function checkPill(r) {
  if (!r.chk) return '';
  const cls = r.chk.status === 'OK' ? 'ok' : r.chk.status === 'NO DATA' ? 'idle' : 'bad';
  const d = r.chk.diff === null || r.chk.diff === undefined ? '' : '<span class="sub">' + (r.chk.diff < 0 ? '−' : '+') + '$' + Math.abs(r.chk.diff).toFixed(2) + ' vs highest</span>';
  return '<span class="pill ' + cls + '">' + esc(r.chk.status) + '</span>' + d;
}

const catOptsHTML = (sel) => ['<option value="">— choose —</option>'].concat(categories.map((c) => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>')).join('');

// cost from the supplier invoice and the margin at this price
// The Invoice column: what you paid per unit, supplier RRP, the margin at our price, and one-click prices
function invoiceCellHTML(r, price) {
  const inv = r.inv || invoiceFor(r.barcode, [r.hint, r.inName, r.name]);
  if (!inv || (!inv.unitCost && !inv.rrp)) return '<span class="muted">–</span>';
  const mg = price && inv.unitCost ? Math.round((price - inv.unitCost) / price * 100) : null;
  const low = mg !== null && mg < (S.minMargin || 25);
  const cp = invCostPrice(inv);
  const sup = String(inv.supplier || 'Invoice').replace(/ Pty Ltd| Australia| Partners/ig, '');
  return (inv.unitCost ? '<b>' + m(inv.unitCost) + '</b> <span class="muted">each</span>' : '') +
    '<span class="sub" title="' + esc(inv.desc || '') + '">' + esc(sup) + ' #' + esc(inv.number || '') + (inv.date ? ' · ' + esc(inv.date) : '') + '</span>' +
    (inv.rrp ? '<span class="sub">RRP ' + m(inv.rrp) + '</span>' : '') +
    (mg !== null ? '<span class="sub' + (low ? ' bad-txt' : ' ok-txt') + '">' + mg + '% margin at ' + m(price) + '</span>' : '') +
    '<div class="inv-btns">' +
      (cp ? '<button class="fx small inv-use" data-p="' + cp + '" title="Invoice cost + ' + (S.fallbackMargin || 40) + '% (Settings)">' + m(cp) + ' <span class="muted">+' + (S.fallbackMargin || 40) + '%</span></button>' : '') +
      (inv.rrp ? '<button class="fx small inv-use" data-p="' + inv.rrp + '" title="Supplier RRP">' + m(inv.rrp) + ' <span class="muted">RRP</span></button>' : '') +
    '</div>';
}
function costHTML(r, price) {
  const inv = r.inv || invoiceFor(r.barcode);
  if (!inv || !inv.unitCost) return '';
  const mg = price ? Math.round((price - inv.unitCost) / price * 100) : null;
  const low = mg !== null && mg < (S.minMargin || 25);
  return '<span class="sub' + (low ? ' bad-txt' : '') + '" title="From invoice ' + esc(inv.number || '') + ' ' + esc(inv.date || '') + ': ' + esc(inv.desc) + '">cost ' + m(inv.unitCost) +
    (mg !== null ? ' · ' + mg + '% margin' : '') + (inv.rrp ? ' · RRP ' + m(inv.rrp) : '') + '</span>';
}

function rowHTML(r, i) {
  const pos = !!r.pos;
  const len = (r.name || '').length, tlen = (r.tname || '').length;
  const ticket = '<div class="tname-row"><span class="muted">ticket</span><input type="text" class="tname" value="' + esc(r.tname || '') + '"><span class="count tcount' + (tlen > S.ticketNameMax ? ' over' : '') + '">' + tlen + '/' + S.ticketNameMax + '</span></div>';
  const nameCell = pos
    ? '<input type="text" class="name posname" value="' + esc(r.newName || r.pos.name) + '" title="Change it here and tick the row to rename it in PosPort"><span class="sub">' + (r.newName && r.newName !== r.pos.name ? 'rename from: ' + esc(r.pos.name) : 'name in PosPort') + '</span>' + ticket
    : '<input type="text" class="name" value="' + esc(r.name || '') + '"><span class="count' + (len > S.nameMaxLength ? ' over' : '') + '">' + len + '/' + S.nameMaxLength + '</span>' + ticket +
      (r.net ? '<span class="sub">name: ' + esc(r.net.source) + '</span>' : '') +
      (r.maybe ? '<div class="maybe">Already in PosPort as <b>' + esc(r.maybe.name) + '</b>' + (r.maybe.price ? ' (' + m(r.maybe.price) + ')' : '') + '?<br>' +
        '<button class="btn small maybe-yes">Yes, same item</button><button class="btn small maybe-no">No, it\'s new</button></div>' : '');
  return '<tr data-i="' + i + '" class="' + (pos ? 'in-pos' : '') + '">' +
    (pos ? '<td><input type="checkbox" class="apply" title="Save the new price / name to PosPort" ' + (r.apply ? 'checked' : '') + '></td>'
         : '<td><input type="checkbox" class="use" title="Create this item" ' + (r.use !== false ? 'checked' : '') + '></td>') +
    '<td><input type="text" class="bcedit" inputmode="numeric" value="' + esc(r.barcode || '') + '" placeholder="barcode" title="Wrong barcode? Change it here – the row is looked up again">' + ((r.inName || r.hint) ? '<span class="sub">' + esc(r.inName || r.hint) + '</span>' : '') + '</td>' +
    '<td>' + (r.status === 'waiting' ? '<span class="muted">…</span>' : storeCell(r.ww)) + '</td><td>' + (r.status === 'waiting' ? '' : storeCell(r.coles)) + '</td>' +
    '<td class="invcell">' + (r.status === 'waiting' ? '' : invoiceCellHTML(r, pos ? (r.newPrice || r.pos.price) : r.price)) + '</td>' +
    '<td class="num">' + m(r.highest) + '</td>' +
    (pos
      ? '<td class="num"><span class="sub">PosPort now</span><b>' + m(r.pos.price) + '</b><span class="sub">new price</span><input type="number" step="0.01" class="price newprice" value="' + (r.newPrice ? Number(r.newPrice).toFixed(2) : '') + '" placeholder="–"></td>'
      : '<td class="num"><input type="number" step="0.01" class="price" value="' + (r.price !== null && r.price !== undefined ? Number(r.price).toFixed(2) : '') + '">' + (r.priceEdited ? '<span class="sub">typed</span>' : priceSource(r, r.price) ? '<span class="sub">' + esc(priceSource(r, r.price)) + '</span>' : '') + '</td>') +
    '<td>' + nameCell + '</td>' +
    '<td>' + (pos ? checkPill(r) : '<select class="cat">' + catOptsHTML(r.category) + '</select>') + '</td>' +
    '<td>' + addStatusPill(r) + '</td></tr>';
}

function fileStats(fid) {
  const rows = state.add.filter((r) => (r.fileId || 'old') === fid);
  return {
    n: rows.length, done: rows.filter((r) => r.status !== 'waiting').length,
    nw: rows.filter((r) => !r.pos).length, ps: rows.filter((r) => r.pos).length,
    flag: rows.filter((r) => r.pos && r.chk && r.chk.flagged && r.updated !== true).length,
    attn: rows.filter(needsAttention).length, made: rows.filter((r) => r.status === 'created').length,
    ready: rows.filter((r) => !r.pos && r.use !== false && (r.status === 'ready' || r.status === 'check')).length,
    save: rows.filter((r) => r.pos && r.apply && (r.newPrice > 0 || (r.newName && r.newName !== r.pos.name))).length,
  };
}

function groupHeadHTML(f) {
  const st = fileStats(f.id);
  const pct = st.n ? Math.round(st.done / st.n * 100) : 100;
  return '<tr class="fhead' + (f.open ? ' open' : '') + '" data-f="' + esc(f.id) + '"><td colspan="10">' +
    '<div class="fhead-in"><button class="fx tog" title="Show / hide this file">' + (f.open ? '▾' : '▸') + '</button>' +
    '<b class="fname">' + esc(f.name) + '</b>' +
    '<span class="fmeta">' + st.n + ' items · ' + (st.done < st.n ? '<span class="fbar"><i style="width:' + pct + '%"></i></span> looking up ' + st.done + '/' + st.n :
      '<span class="pill ok">looked up</span>') +
    ' · <b>' + st.nw + '</b> new' + (st.made ? ' (' + st.made + ' created)' : '') + ' · <b>' + st.ps + '</b> in PosPort' + (st.flag ? ' · <span class="pill bad">' + st.flag + ' flagged</span>' : '') +
    (st.attn ? ' · <span class="pill warn">' + st.attn + ' to check</span>' : '') + '</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn small fx" data-act="create"' + (st.ready ? '' : ' disabled') + '>Create ' + st.ready + ' new</button>' +
    '<button class="btn small fx" data-act="tick"' + (st.flag ? '' : ' disabled') + '>Tick flagged</button>' +
    '<button class="btn small fx" data-act="save"' + (st.save ? '' : ' disabled') + '>Save ' + st.save + ' changes</button>' +
    '<button class="btn small fx" data-act="tickets">Tickets</button>' +
    '<button class="btn small fx" data-act="export">Excel</button>' +
    (f.raw ? '<button class="btn small fx" data-act="cols" title="Choose which column is which">Columns…</button>' : '') +
    '<button class="btn small fx" data-act="remove" title="Remove this file from the list">✕</button>' +
    '</div></td></tr>';
}

function ensureFiles() {
  state.files = state.files || [];
  // rows from before files existed / scanned rows get their own groups
  if (state.add.some((r) => !r.fileId) && !state.files.some((f) => f.id === 'old')) state.files.push({ id: 'old', name: 'Earlier items', open: true });
  const ids = new Set(state.add.map((r) => r.fileId || 'old'));
  state.files = state.files.filter((f) => ids.has(f.id));
}

function renderAdd() {
  ensureFiles();
  const t = $('addTable');
  const counts = { all: state.add.length, new: state.add.filter((r) => !r.pos).length, pos: state.add.filter((r) => r.pos).length, attn: state.add.filter(needsAttention).length };
  $('fAll').textContent = counts.all; $('fNew').textContent = counts.new; $('fPos').textContent = counts.pos; $('fAttn').textContent = counts.attn;
  document.querySelectorAll('#addFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === (state.addFilter || 'all')));
  if (!state.add.length) { t.innerHTML = '<tbody><tr><td class="muted">Choose one or more Excel files, or scan barcodes. Each file appears here as its own row – click it to open the whole sheet.</td></tr></tbody>'; $('addSummary').textContent = ''; refreshButtons(); return; }
  let html = '<thead><tr><th><input type="checkbox" id="addAll" title="Tick / untick everything shown"></th><th>Barcode</th><th>Woolworths</th><th>Coles</th><th>Invoice <span class="muted">(cost each)</span></th><th class="num">Highest</th><th class="num">Price</th><th>Name</th><th>Category / check</th><th>Status</th></tr></thead>';
  state.files.forEach((f) => {
    html += '<tbody class="fgroup" data-f="' + esc(f.id) + '">' + groupHeadHTML(f);
    if (f.open) state.add.forEach((r, i) => { if ((r.fileId || 'old') === f.id && inFilter(r)) html += rowHTML(r, i); });
    html += '</tbody>';
  });
  t.innerHTML = html;
  const done = state.add.filter((r) => r.status !== 'waiting').length;
  $('addSummary').textContent = state.files.length + ' file(s) · ' + done + '/' + state.add.length + ' looked up' + (lookupRunning ? ' – looking up in the background…' : '');
  refreshButtons();
}

// ---- background updates must never get in the way of what you are typing or looking at ----
let userActiveUntil = 0, pendingRows = new Set(), pendingFull = false, flushTimer = null;
['input', 'keydown', 'focusin', 'mousedown', 'wheel'].forEach((ev) => $('addTable').addEventListener(ev, () => { userActiveUntil = Date.now() + 2500; }, { passive: true }));
const userActive = () => Date.now() < userActiveUntil || ($('addTable').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName));
function scheduleFlush() { if (!flushTimer) flushTimer = setTimeout(flushPending, 1200); }
function flushPending() {
  flushTimer = null;
  if (userActive()) { scheduleFlush(); return; }
  if (pendingFull) { pendingFull = false; pendingRows.clear(); keepScroll(() => renderAdd()); return; }
  const rows = Array.from(pendingRows); pendingRows.clear();
  rows.forEach((r) => replaceRow(r));
}
// Replace while keeping what you see in the same place on screen
function keepScroll(fn) {
  const wrap = $('addTable').closest('.tablewrap');
  const rows = Array.from($('addTable').querySelectorAll('tr[data-i], tr.fhead'));
  const top = wrap.getBoundingClientRect().top;
  const anchor = rows.find((tr) => tr.getBoundingClientRect().bottom > top);
  const key = anchor ? (anchor.dataset.i ? 'tr[data-i="' + anchor.dataset.i + '"]' : 'tr.fhead[data-f="' + CSS.escape(anchor.dataset.f) + '"]') : null;
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  fn();
  const again = key && $('addTable').querySelector(key);
  if (again) wrap.scrollTop += again.getBoundingClientRect().top - before;
}
function replaceRow(r) {
  const i = state.add.indexOf(r);
  const fid = r.fileId || 'old';
  const body = document.querySelector('#addTable tbody.fgroup[data-f="' + CSS.escape(fid) + '"]');
  if (!body) { pendingFull = true; scheduleFlush(); return; }
  const tr = body.querySelector('tr[data-i="' + i + '"]');
  const f = state.files.find((x) => x.id === fid);
  keepScroll(() => {
    if (tr && inFilter(r)) tr.outerHTML = rowHTML(r, i);
    else if (!tr && f && f.open && inFilter(r)) { pendingFull = true; scheduleFlush(); }
  });
}
function refreshRow(r) {
  const fid = r.fileId || 'old';
  const f = state.files.find((x) => x.id === fid);
  const body = document.querySelector('#addTable tbody.fgroup[data-f="' + CSS.escape(fid) + '"]');
  // the file's header line is always safe to update (progress, counts)
  const head = body && body.querySelector('tr.fhead');
  if (head && f) head.outerHTML = groupHeadHTML(f);
  if (!body) { pendingFull = true; scheduleFlush(); }
  else if (f && f.open) { if (userActive()) { pendingRows.add(r); scheduleFlush(); } else replaceRow(r); }
  const done = state.add.filter((x) => x.status !== 'waiting').length;
  $('addSummary').textContent = state.files.length + ' file(s) · ' + done + '/' + state.add.length + ' looked up' + (lookupRunning ? ' – looking up in the background…' : '');
  ['fAll', 'fNew', 'fPos', 'fAttn'].forEach((id, k) => { $(id).textContent = [state.add.length, state.add.filter((x) => !x.pos).length, state.add.filter((x) => x.pos).length, state.add.filter(needsAttention).length][k]; });
  refreshButtons();
}
function safeRenderAdd() { if (userActive()) { pendingFull = true; scheduleFlush(); } else keepScroll(() => renderAdd()); }

$('addFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  state.addFilter = b.dataset.f; renderAdd();
});

$('addTable').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.add[+tr.dataset.i];
  const c = e.target.classList;
  if (c.contains('posname')) {
    r.newName = e.target.value.trim() && e.target.value.trim() !== r.pos.name ? e.target.value.trim() : null;
    r.apply = !!(r.newName || r.newPrice); tr.querySelector('.apply').checked = r.apply;
    if (!r.tnameEdited) { r.tname = ticketNameOf(r.newName || r.pos.name, ''); tr.querySelector('.tname').value = r.tname; }
  } else if (c.contains('name')) {
    r.name = e.target.value; r.nameEdited = true;
    const cnt = tr.querySelector('.count');
    cnt.textContent = r.name.length + '/' + S.nameMaxLength;
    cnt.classList.toggle('over', r.name.length > S.nameMaxLength);
    if (!r.tnameEdited) { r.tname = ticketNameOf(r.name, ''); tr.querySelector('.tname').value = r.tname; }
  }
  if (c.contains('tname')) { r.tnameEdited = true; r.tname = e.target.value; }
  if (c.contains('tname') || c.contains('name')) {
    const tc = tr.querySelector('.tcount');
    tc.textContent = (r.tname || '').length + '/' + S.ticketNameMax;
    tc.classList.toggle('over', (r.tname || '').length > S.ticketNameMax);
  }
  if (c.contains('newprice')) {
    r.newPrice = R.parseMoney(e.target.value);
    r.apply = !!(r.newPrice || r.newName); tr.querySelector('.apply').checked = r.apply;
  } else if (c.contains('price')) { r.price = R.parseMoney(e.target.value); r.priceEdited = true; }
  saveState(); refreshButtons();
  const fid = r.fileId || 'old', f = state.files.find((x) => x.id === fid), head = tr.parentElement.querySelector('tr.fhead');
  if (f && head) head.outerHTML = groupHeadHTML(f);
});
$('addTable').addEventListener('change', (e) => {
  if (e.target.id === 'addAll') {
    const open = new Set(state.files.filter((f) => f.open).map((f) => f.id));
    state.add.filter((r) => inFilter(r) && open.has(r.fileId || 'old')).forEach((r) => { if (r.pos) r.apply = e.target.checked && !!(r.newPrice || r.newName); else r.use = e.target.checked; });
    renderAdd(); saveState(); return;
  }
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.add[+tr.dataset.i];
  if (e.target.classList.contains('bcedit')) { changeBarcode(r, e.target.value); return; }
  if (e.target.classList.contains('cat')) r.category = e.target.value;
  if (e.target.classList.contains('use')) r.use = e.target.checked;
  if (e.target.classList.contains('apply')) r.apply = e.target.checked;
  if (r.status === 'not found' && r.name && r.price && r.category) r.status = 'ready';
  saveState(); refreshRow(r);
});
$('addTable').addEventListener('click', (e) => {
  const head = e.target.closest('tr.fhead');
  if (head) { fileAction(head.dataset.f, e.target.closest('button[data-act]') ? e.target.closest('button[data-act]').dataset.act : 'toggle'); return; }
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.add[+tr.dataset.i];
  const use = e.target.closest('.inv-use');
  if (use) {      // one-click price from the invoice (cost + margin, or RRP)
    const p = Number(use.dataset.p);
    if (r.pos) { r.newPrice = p; r.apply = true; } else { r.price = p; r.priceEdited = true; }
    replaceRow(r); saveState(); refreshButtons();
    const fid = r.fileId || 'old', f = state.files.find((x) => x.id === fid), head = $('addTable').querySelector('tr.fhead[data-f="' + CSS.escape(fid) + '"]');
    if (f && head) head.outerHTML = groupHeadHTML(f);
    return;
  }
  if (e.target.classList.contains('maybe-yes')) { markInPos(r, r.maybe); r.maybe = null; }
  else if (e.target.classList.contains('maybe-no')) { r.maybe = null; r.notInPos = true; }
  else return;
  renderAdd(); saveState();
});

const ITEM_ROLES = ['barcode', 'name', 'hint', 'category', 'price'];

// Read a sheet without asking: header row (if any) + guessed columns.
function autoColumns(rows, roles, picksIn) {
  rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return { picks: [], body: [] };
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const first = rows[0].map((c) => String(c || '').trim());
  const hasHeader = first.some((c) => c && !/^[\d.,$\s-]+$/.test(c));
  const header = hasHeader ? first.concat(Array(Math.max(0, width - first.length)).fill('')) : Array(width).fill('');
  const body = hasHeader ? rows.slice(1) : rows;
  const picks = picksIn || ((S.colMaps || {})[header.join('|').toLowerCase()]) || guessRoles(header, roles, body.slice(0, 20));
  return { picks, body, header };
}

function itemsFromSheet(rows, picks, fileId, seen) {
  const ac = autoColumns(rows, ITEM_ROLES, picks);
  const out = [];
  ac.body.forEach((r) => {
    const x = {};
    ac.picks.forEach((role, i) => { if (role !== '_') x[role] = r[i]; });
    const barcode = R.cleanBarcode(x.barcode);
    const name = String(x.name || '').trim(), hint = String(x.hint || '').trim();
    if (!barcode && !name && !hint) return;
    const key = barcode || (name || hint).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const price = R.parseMoney(x.price);
    const it = { barcode, inName: name, hint, name: '', tname: '', category: String(x.category || '').trim(), overridePrice: price, price, status: 'waiting', use: true, fileId };
    setNames(it, name, '');
    out.push(it);
  });
  return { items: out, picks: ac.picks };
}

$('addFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  ensureFiles();
  const seen = new Set(state.add.map((r) => r.barcode || (r.inName || '').toLowerCase()));
  const anyOpen = state.files.some((f) => f.open);
  let first = true;
  for (const f of files) {
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (/\.pdf$/i.test(f.name)) {
      let inv;
      try { inv = await readInvoicePdf(f); } catch (err) { log(f.name + ': ' + err.message, 'err'); continue; }
      const rows = [];
      inv.items.forEach((it) => {
        const key = it.barcode || it.desc.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const r = { barcode: it.barcode, inName: '', hint: it.name || it.desc, name: '', tname: '', category: '', price: null, status: 'waiting', use: it.shipped > 0, fileId: id,
          note: it.status ? it.status + ' – not delivered' : '' };
        setNames(r, it.name || INV.tidyName(it.desc), '');
        r.nameFromInvoice = true;
        rows.push(r);
      });
      state.files.push({ id, name: (inv.supplier || 'Invoice').replace(/ Pty Ltd/i, '') + ' #' + (inv.number || f.name) + (inv.date ? ' · ' + inv.date : ''), open: !anyOpen && first, invoice: inv.id });
      state.add.push(...rows);
      log('Loaded ' + rows.length + ' items from invoice ' + (inv.number || f.name));
      first = false;
      continue;
    }
    const raw = await readSheet(f);
    const res = itemsFromSheet(raw, null, id, seen);
    if (!res.items.length) { log(f.name + ': no barcodes or names found – use "Columns…" after loading to pick them.', 'err'); }
    state.files.push({ id, name: f.name, open: !anyOpen && first, raw: raw.slice(0, 5000), picks: res.picks });
    state.add.push(...res.items);
    if (!res.items.length) state.add.push({ barcode: '', inName: '(no rows read)', hint: '', name: '', tname: '', status: 'not found', use: false, fileId: id, note: 'Click "Columns…" on this file' });
    log('Loaded ' + res.items.length + ' items from ' + f.name);
    first = false;
  }
  renderAdd(); saveState();
  startLookup();
});

async function fileAction(fid, act) {
  const f = state.files.find((x) => x.id === fid);
  if (!f) return;
  const rows = state.add.filter((r) => (r.fileId || 'old') === fid);
  if (act === 'toggle') { f.open = !f.open; renderAdd(); saveState(); return; }
  if (act === 'remove') {
    if (!confirm('Remove "' + f.name + '" (' + rows.length + ' items) from the list? Nothing in PosPort changes.')) return;
    state.add = state.add.filter((r) => (r.fileId || 'old') !== fid);
    state.files = state.files.filter((x) => x.id !== fid);
    renderAdd(); saveState(); return;
  }
  if (act === 'cols') {
    const mapped = await mapColumnsPicks(f.name, f.raw, ITEM_ROLES);
    if (!mapped) return;
    const seen = new Set(state.add.filter((r) => (r.fileId || 'old') !== fid).map((r) => r.barcode || (r.inName || '').toLowerCase()));
    const res = itemsFromSheet(f.raw, mapped, fid, seen);
    state.add = state.add.filter((r) => (r.fileId || 'old') !== fid).concat(res.items);
    f.picks = mapped; f.open = true;
    renderAdd(); saveState(); startLookup(); return;
  }
  if (act === 'tick') { rows.forEach((r) => { if (r.pos && r.chk && r.chk.flagged && r.newPrice && r.updated !== true) r.apply = true; }); f.open = true; renderAdd(); saveState(); return; }
  if (busy && ['create', 'save', 'cols'].includes(act)) { log('Busy with PosPort – try again in a moment.', 'err'); return; }
  if (act === 'create') return runCreate(false, fid);
  if (act === 'save') return runPosUpdates(fid);
  if (act === 'export') return exportItems(rows, f.name.replace(/\.[^.]+$/, ''));
  if (act === 'tickets') {
    const list = rows.filter((r) => r.pos || (r.name && r.price && r.status !== 'not found' && r.use !== false)).map((r) => r.pos
      ? { full: r.newName || r.pos.name, name: r.tname || ticketNameOf(r.newName || r.pos.name, ''), price: r.updated === true ? r.pos.price : (r.pos.price), barcode: r.barcode }
      : { full: r.name, name: r.tname || ticketNameOf(r.name, ''), price: r.price, barcode: r.barcode });
    if (!list.length) { log('Nothing in this file has a name and price yet.', 'err'); return; }
    addTickets(list);
    showTab('tickets');
  }
}

// Scanner box: a USB/Bluetooth scanner (or a phone app like "Barcode to PC") types the code + Enter
function scanBox(id, onCode) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = R.cleanBarcode($(id).value);
    $(id).value = '';
    if (code.length < 6) { if (code) log('"' + code + '" is too short for a barcode.', 'err'); return; }
    onCode(code);
  });
}
scanBox('addScan', (code) => {
  if (state.add.some((r) => r.barcode && R.sameBarcode(r.barcode, code))) { log(code + ' is already in the list.'); return; }
  ensureFiles();
  if (!state.files.some((f) => f.id === 'scanned')) state.files.unshift({ id: 'scanned', name: 'Scanned barcodes', open: true });
  state.add.unshift({ barcode: code, inName: '', hint: '', name: '', tname: '', category: '', price: null, status: 'waiting', use: true, fileId: 'scanned' });
  renderAdd(); saveState();
  log('Scanned ' + code);
  startLookup();
});

// ---- what a new price is based on (Prices box): shops, invoice cost, the higher of both, or supplier RRP ----
const BASIS_TEXT = { shops: 'highest shop price + markup', higher: 'shop price + markup, or invoice cost + margin if that is higher', invoice: 'invoice cost + margin', rrp: 'supplier RRP from the invoice' };
function invCostPrice(inv) { return inv && inv.unitCost ? R.round2(inv.unitCost * (1 + (S.fallbackMargin || 40) / 100)) : null; }
function priceFor(r) {
  const shop = r.highest ? R.newItemPrice(r.highest, S) : null;
  const cost = invCostPrice(r.inv), rrp = r.inv && r.inv.rrp ? r.inv.rrp : null;
  switch (S.priceBasis || 'shops') {
    case 'higher': return shop && cost ? Math.max(shop, cost) : (shop || cost || rrp);
    case 'invoice': return cost || shop || rrp;
    case 'rrp': return rrp || shop || cost;
    default: return shop || rrp || cost;
  }
}
// what the price came from, for the note under the price
function priceSource(r, p) {
  if (!p) return '';
  if (r.highest && p === R.newItemPrice(r.highest, S)) return 'shop + ' + markupText();
  if (r.inv && p === invCostPrice(r.inv)) return 'cost + ' + (S.fallbackMargin || 40) + '%';
  if (r.inv && p === r.inv.rrp) return 'supplier RRP';
  return '';
}
function markupText() {
  return (S.markup ? m(S.markup) : '') + (S.markup && S.markupPct ? ' + ' : '') + (S.markupPct ? S.markupPct + '%' : '') || '$0';
}
function applyMarkup(newMarkup, newPct) {
  S.markup = newMarkup;
  if (newPct !== undefined) S.markupPct = newPct;
  chrome.storage.local.set({ settings: S });
  let n = 0;
  state.add.forEach((r) => {
    if (r.pos || r.priceEdited || r.overridePrice || (!r.highest && !r.inv) || r.status === 'created') return;
    r.price = priceFor(r); n++;
  });
  $('s_markup').value = S.markup; $('s_markupPct').value = S.markupPct || 0;
  state.add.forEach((r) => { if (r.pos && r.highest) { r.chk = R.checkExistingPrice(r.pos.price, r.highest, S); if (!r.apply) r.newPrice = r.chk.flagged ? r.chk.suggested : r.newPrice; } });
  renderAdd(); saveState();
  log('Markup set to ' + markupText() + ' – ' + n + ' prices updated (prices you typed yourself were kept).', 'ok');
}
$('addApplyMarkup').addEventListener('click', () => {
  const v = parseFloat($('addMarkup').value || '0');
  const pct = parseFloat($('addMarkupPct').value || '0');
  if (!isFinite(v) || v < 0 || !isFinite(pct) || pct < 0) { log('Type a markup like 1.50 and/or a percent like 20', 'err'); return; }
  applyMarkup(R.round2(v), pct);
});
$('addMarkup').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addApplyMarkup').click(); });
$('addInvMargin').addEventListener('change', () => {
  const v = parseFloat($('addInvMargin').value);
  if (!isFinite(v) || v < 0) return;
  S.fallbackMargin = v; $('s_fallbackMargin').value = v;
  applyMarkup(S.markup, S.markupPct); renderAdd();
});
$('addBasis').addEventListener('change', () => {
  S.priceBasis = $('addBasis').value;
  applyMarkup(S.markup, S.markupPct);
  log('New prices now: ' + BASIS_TEXT[S.priceBasis] + '.', 'ok');
});
$('addMarkupPct').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addApplyMarkup').click(); });
$('addRename').addEventListener('click', () => {
  let n = 0;
  state.add.forEach((r) => {
    if (r.pos) { if (!r.tnameEdited) { r.tname = ticketNameOf(r.pos.name, ''); n++; } return; }
    if ((r.nameEdited && r.tnameEdited) || r.status === 'created') {
      if (r.status === 'created' && !r.tnameEdited && r.name) { r.tname = ticketNameOf(r.name, ''); n++; }
      return;
    }
    const src = (r.ww && r.ww.found && r.ww) || (r.coles && r.coles.found && r.coles) || r.net;
    const full = r.inName || (src && src.name) || r.hint;
    if (!full) return;
    setNames(r, full, r.inName ? '' : (src && src.size) || ''); n++;
  });
  renderAdd(); saveState();
  log(n + ' names made again (names you typed yourself were kept).', 'ok');
});

// ---- is it already in PosPort? ----
function markInPos(r, item) {
  r.pos = { name: item.name, price: item.price, id: item.id || '', href: item.href || '', page: item.page || '' };
  r.use = false;
  const chk = R.checkExistingPrice(item.price, r.highest, S);
  r.chk = chk;
  if (!r.newPrice) r.newPrice = chk.flagged ? chk.suggested : null;
  r.apply = false;
  if (!r.tnameEdited) r.tname = ticketNameOf(item.name, '');
}

function findInPos(r) {
  if (!state.catalogue.length) return { item: null };
  if (r.barcode) {
    const b = state.catalogue.find((c) => c.barcode && R.sameBarcode(c.barcode, r.barcode));
    if (b) return { item: b, how: 'barcode' };
  }
  // Trust supermarket names that were matched by barcode; a name-only match is used only if nothing better
  const names = [];
  const stores = [r.ww, r.coles].filter((x) => x && x.found);
  const sure = stores.filter((x) => x.match === 'barcode');
  (sure.length ? sure : stores.slice(0, 1)).forEach((x) => names.push(x.name));
  if (r.net) names.push([r.net.name, r.net.size].filter(Boolean).join(' '));
  if (r.inName) names.push(r.inName);
  if (r.hint) names.push(r.hint);
  let best = null;
  for (const n of names) {
    const mm = R.posMatch(n, state.catalogue, (c) => c.name);
    if (mm.item && mm.sure) return { item: mm.item, how: 'name' };
    if (mm.item && mm.score >= 0.5 && (!best || mm.score > best.score)) best = mm;
  }
  return { item: null, maybe: best ? Object.assign({ score: best.score }, best.item) : null };
}

async function ensureCatalogue() {
  const age = state.catalogueAt ? (Date.now() - state.catalogueAt) / 3600000 : Infinity;
  if (state.catalogue.length && age < 12) return true;
  const msg = state.catalogue.length ? 'Your PosPort item list was read ' + Math.round(age) + ' hours ago. Read it again so the bot knows exactly which items you already have? (about a minute)'
    : 'Read your PosPort item list first, so the bot can tell which items you already have? (about a minute)';
  if (state.catalogueDeclined && state.catalogue.length) return true;
  if (state.catalogueDeclined) return false;
  if (!confirm(msg)) { state.catalogueDeclined = true; return false; }
  await scanCatalogue();
  return state.catalogue.length > 0;
}

// Looks up every waiting row in the background, the open file first, so you can work on one file
// (create, change prices, print) while the next files are being looked up.
let lookupRunning = false;
async function startLookup(again) {
  if (again) clearPriceCache();
  if (again) state.add.forEach((r) => { if (r.status !== 'created' && r.updated !== true) { r.status = 'waiting'; r.pos = null; r.maybe = null; r.chk = null; } });
  if (lookupRunning) return;
  lookupRunning = true;
  try {
    await ensureCatalogue();
    $('addScanInfo').textContent = state.catalogue.length ? 'Checked against ' + state.catalogue.length + ' PosPort items' : 'PosPort not checked';
    let n = 0;
    const tried = new Set();
    // Every file moves forward at the same time: every other look-up goes to the file you have open,
    // the rest take turns across all the other files.
    let turn = 0, rot = 0;
    const startedAt = Date.now(), hits0 = cacheHits;
    const next = () => {
      if (lookupStop) return null;
      const waiting = (x) => ['waiting', 'error', 'not found'].includes(x.status) && (!tried.has(x) || x.relook) && (x.barcode || x.inName || x.hint);
      const open = new Set((state.files || []).filter((f) => f.open).map((f) => f.id));
      const fromOpen = () => state.add.find((x) => waiting(x) && open.has(x.fileId || 'old'));
      const fromOthers = () => {
        const ids = Array.from(new Set(state.add.filter((x) => waiting(x) && !open.has(x.fileId || 'old')).map((x) => x.fileId || 'old')));
        if (!ids.length) return null;
        const fid = ids[rot++ % ids.length];
        return state.add.find((x) => waiting(x) && (x.fileId || 'old') === fid);
      };
      const r = (turn++ % 2 === 0 ? (fromOpen() || fromOthers()) : (fromOthers() || fromOpen())) || state.add.find(waiting);
      if (r) { tried.add(r); r.looking = true; r.relook = false; }
      return r;
    };
    await runPool(S.parallel || 3, next, async (r) => {
      n++;
      try { await lookupOne(r); } catch (e) { r.status = 'error'; r.note = String(e.message || e); }
      r.looking = false;
      refreshRow(r); saveState();
    });
    if (n) {
      const nPos = state.add.filter((r) => r.pos).length, nNew = state.add.length - nPos;
      const secs = Math.max(1, (Date.now() - startedAt) / 1000);
      log('Done: ' + nNew + ' new items, ' + nPos + ' already in PosPort (' + state.add.filter((r) => r.pos && r.chk && r.chk.flagged).length + ' prices flagged). ' +
        n + ' looked up in ' + (secs < 90 ? Math.round(secs) + 's' : Math.round(secs / 60) + ' min') + (cacheHits - hits0 ? ', ' + (cacheHits - hits0) + ' of them answered from memory (same product seen before)' : '') + '.', 'ok');
    }
  } finally { lookupRunning = false; lookupStop = false; safeRenderAdd(); }
}
let lookupStop = false;
$('addLookup').addEventListener('click', () => startLookup(true));

// a shop result we trust enough to copy its barcode: matched by barcode, the only result, or a name match of 70%+
function strongMatch(x) {
  const mm = String((x && x.match) || '');
  if (mm === 'barcode' || /^only result/.test(mm)) return true;
  const pct = Number((mm.match(/(\d+)%/) || [])[1]);
  return pct >= 70;
}
// Wrong barcode typed/scanned: fix it in the row, then that row alone is looked up again.
function changeBarcode(r, value) {
  const bc = R.cleanBarcode(value);
  if (bc === (r.barcode || '')) return;
  if (r.status === 'created' || r.updated === true) { log('That item is already saved in PosPort – change its barcode in the Back Office.', 'err'); replaceRow(r); return; }
  r.barcode = bc;
  Object.assign(r, { status: 'waiting', ww: null, coles: null, highest: null, net: null, inv: null, pos: null, chk: null, maybe: null,
    notInPos: false, invPriced: false, note: '', newPrice: null, newName: null, apply: false, use: true });
  if (!r.nameEdited) { r.name = ''; r.nameFromInvoice = false; }
  if (!r.tnameEdited) r.tname = '';
  if (!r.priceEdited) r.price = null;
  log('Barcode changed to ' + (bc || '(none)') + ' – looking it up again.' + (bc && !R.validBarcode(bc) ? ' (check digit looks wrong – please check it)' : ''), bc && !R.validBarcode(bc) ? 'err' : '');
  r.relook = true;            // picked up even if a background look-up is already running
  replaceRow(r); saveState(); startLookup();
}

async function lookupOne(r) {
  let res = await lookupPrices(r.barcode, r.inName || r.hint);
  r.net = null;
  if (!res.highest || !(res.ww && res.ww.found) && !(res.coles && res.coles.found)) {
    // Not found by barcode: get the product name from open barcode databases, then try Woolworths/Coles by that name.
    const net = await window.CSB_STORES.internetLookup(r.barcode);
    if (net && net.found) {
      r.net = net;
      const again = await lookupPrices('', [net.name, net.size].filter(Boolean).join(' '));
      if (again.highest) res = again;
    }
  }
  r.ww = res.ww; r.coles = res.coles; r.highest = res.highest;
  const src = res.ww && res.ww.found ? res.ww : (res.coles && res.coles.found ? res.coles : null);
  // a line from a Woolworths / Coles invoice has no barcode: take it from the shop's product
  if (!r.barcode && src && src.barcode && strongMatch(src)) { r.barcode = R.cleanBarcode(src.barcode); r.barcodeFrom = src === res.ww ? 'Woolworths' : 'Coles'; }
  r.inv = invoiceFor(r.barcode, [r.hint, r.inName, r.name]);
  const nameSrc = src || r.net;
  if (nameSrc && !r.inName && !r.nameEdited) setNames(r, nameSrc.name, nameSrc.size);
  else if (!nameSrc && r.inv && !r.inName && !r.nameEdited) { setNames(r, r.inv.name || INV.tidyName(r.inv.desc), ''); r.nameFromInvoice = true; }
  else if (!r.name && r.hint) setNames(r, r.hint, '');
  if (!r.category) r.category = R.guessCategory(nameSrc ? nameSrc.name : (r.inName || r.hint), (res.ww && res.ww.dept) || (r.net && r.net.dept), categories);
  if (!r.priceEdited) r.price = r.overridePrice || priceFor(r);
  // not at Woolworths/Coles: the price can only come from the supplier invoice (their RRP, or cost + margin)
  r.invPriced = !res.highest && !!r.inv && !!r.price && !r.priceEdited && !r.overridePrice;
  const unsure = [res.ww, res.coles].some((x) => x && x.found && x.match && x.match !== 'barcode');
  if (r.barcode && !R.validBarcode(r.barcode)) { r.status = 'not found'; r.note = 'This barcode looks mistyped (check digit is wrong) - please re-scan it.'; }
  else if (!res.highest && r.invPriced) { r.status = 'check'; r.note = 'Not at Woolworths/Coles – name and price from invoice ' + (r.inv.number || '') + (r.inv.rrp ? ' (supplier RRP)' : ' (cost + ' + (S.fallbackMargin || 40) + '%)'); }
  else if (!res.highest) { r.status = 'not found'; r.note = 'No price at Woolworths or Coles' + (r.net ? ' (name from ' + r.net.source + ')' : r.name ? ' (name from your sheet)' : ''); }
  else { r.status = unsure ? 'check' : 'ready'; r.note = unsure ? 'Matched by name – please check it is the same product' : ''; }
  const found = r.notInPos ? { item: null } : findInPos(r);
  if (found.item) { markInPos(r, found.item); r.status = 'in PosPort'; r.note = 'found in PosPort by ' + found.how; }
  else if (found.maybe) r.maybe = found.maybe;
}

// ---- update prices of items that are already in PosPort ----
// ---- change an item that is already in PosPort (price and/or name), then check PosPort kept it ----
const nameKey = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function catalogueEntry(p) {
  return state.catalogue.find((x) => (p.id && x.id && String(x.id) === String(p.id))) ||
    state.catalogue.find((x) => nameKey(x.name) === nameKey(p.name));
}
// the item's own page, if we know it: from the list link, an earlier visit, or its id + the link pattern of another item
function itemPagePath(p) {
  const c = catalogueEntry(p) || {};
  const link = p.href || c.href || c.page || '';
  if (link) { try { return new URL(link, POS).pathname; } catch (e) { /* bad link */ } }
  const id = p.id || c.id;
  if (id) {
    const t = state.catalogue.find((x) => (x.href || x.page) && x.id && String(x.href || x.page).includes(String(x.id)));
    if (t) { try { return new URL(String(t.href || t.page).replace(String(t.id), String(id)), POS).pathname; } catch (e) { /* ignore */ } }
  }
  return '';
}
async function waitEditPage() {
  for (let i = 0; i < 24; i++) {
    const e = await pos('readEditPrice');
    if (e && e.ok) return e;
    await sleep(500);
  }
  return { ok: false, error: 'The item page did not show its price box.' };
}
async function openPosItem(p) {
  const path = itemPagePath(p);
  if (path && path !== '/catalog/items') {
    if (await posGo(path, 'item')) { const e = await waitEditPage(); if (e.ok) return e; }
  }
  if (!(await posGo('/catalog/items', 'items'))) return { ok: false, error: 'Items page did not open' };
  // search the full name; if PosPort finds nothing, search the first words + size and pick it out of the results
  const words = String(p.name).split(/\s+/);
  const size = words.find((w) => /\d/.test(w)) || '';
  const tries = [p.name, words.slice(0, 2).join(' ') + (size && !words.slice(0, 2).includes(size) ? ' ' + size : ''), words[0]];
  let o = null;
  for (const q of tries.filter((q, i, a) => q && a.indexOf(q) === i)) {
    const s2 = await pos('searchList', q, S.delayMs);
    if (!s2 || !s2.ok) return s2 || { ok: false, error: 'search failed' };
    o = await pos('openItem', p.name, S.delayMs);
    if (!o) o = { ok: true, navigating: true };     // the click moved the tab to the item page, so no answer came back
    if (o.ok) break;
  }
  if (!o || !o.ok) return o || { ok: false, error: 'could not open the item' };
  const tabId = await posTab();
  await sleep(800); await waitComplete(tabId);
  return waitEditPage();
}
async function updatePosItem(p, fields) {
  if (typeof p === 'string') p = { name: p };
  const e = await openPosItem(p);
  if (!e.ok) return e;
  // never change the wrong item
  if (e.name !== null && e.name !== undefined && nameKey(e.name) !== nameKey(p.name))
    return { ok: false, error: 'PosPort opened "' + e.name + '" instead – nothing was changed' };
  const info = await pos('pageInfo');
  const pagePath = info && info.page === 'item' ? new URL(info.url).pathname : '';
  const res = await pos('setEditFields', fields, S.delayMs);
  if (!res || !res.ok) return res || { ok: false, error: 'no answer' };
  // remember the item's page for next time
  const c = catalogueEntry(p);
  if (pagePath) { p.page = pagePath; if (c) c.page = pagePath; }
  // check it really changed
  await sleep(1500);
  const wantName = fields.name || p.name;
  const priceOk = (x) => fields.price === undefined || Math.abs(Number(x) - Number(fields.price)) < 0.005;
  if (pagePath && (await posGo(pagePath, 'item'))) {
    const v = await waitEditPage();
    if (v.ok) {
      const nameOk = v.name === null || v.name === undefined || nameKey(v.name) === nameKey(wantName);
      if (nameOk && priceOk(v.price)) return Object.assign(res, { checked: true });
      return { ok: false, error: 'PosPort did not keep the change (it still shows "' + (v.name || p.name) + '" ' + m(v.price) + ') – the Save button may need a different click, please tell me' };
    }
  }
  // the item opened as a pop-up: look it up in the list under its new name instead
  if (await posGo('/catalog/items', 'items')) {
    const l = await pos('searchList', wantName, S.delayMs);
    const row = l && l.rows && l.rows.find((x) => nameKey(x.name) === nameKey(wantName));
    if (row) return priceOk(row.price) ? Object.assign(res, { checked: true }) :
      { ok: false, error: 'the name changed but the price still shows ' + m(row.price) };
    if (fields.name) return { ok: false, error: 'PosPort did not keep the new name (no item called "' + wantName + '" after saving)' };
  }
  return Object.assign(res, { checked: false });
}
const updatePosPrice = (p, newPrice) => updatePosItem(p, { price: newPrice });

function toPrintList(items, what) {
  if (S.autoTickets === false || !items.length) return;
  addTickets(items, true);
  saveState(); renderTickets();
  log(items.length + ' ' + what + ' added to the print list (Tickets & labels tab).', 'ok');
}

$('addTickFlagged').addEventListener('click', () => {
  let n = 0;
  state.add.forEach((r) => { if (r.pos && r.chk && r.chk.flagged && r.newPrice && r.updated !== true) { r.apply = true; n++; } });
  state.addFilter = 'pos'; renderAdd(); saveState();
  log(n + ' flagged prices ticked – check the new prices, then press "Update ticked prices".');
});

$('addUpdate').addEventListener('click', () => runPosUpdates(null));

// Save ticked changes (new price and/or new name) for items already in PosPort. fid = only that file.
async function runPosUpdates(fid) {
  const todo = state.add.filter((r) => r.pos && r.apply && (!fid || (r.fileId || 'old') === fid) &&
    (r.newPrice > 0 || (r.newName && r.newName !== r.pos.name)));
  if (!todo.length) { log('Tick the PosPort items to change and give them a new price or name.', 'err'); return; }
  const line = (r) => (r.newName && r.newName !== r.pos.name ? r.pos.name + ' → "' + r.newName + '"' : r.pos.name) +
    (r.newPrice > 0 && r.newPrice !== r.pos.price ? ': ' + m(r.pos.price) + ' → ' + m(r.newPrice) : '');
  if (!confirm('Save ' + todo.length + ' changes in PosPort?\n\n' + todo.slice(0, 15).map(line).join('\n') + (todo.length > 15 ? '\n…' : ''))) return;
  setBusy(true);
  const done = [];
  try {
    for (const r of todo) {
      if (stopRequested) break;
      const fields = {};
      if (r.newPrice > 0 && r.newPrice !== r.pos.price) fields.price = r.newPrice;
      if (r.newName && r.newName !== r.pos.name) fields.name = r.newName;
      if (!Object.keys(fields).length) { r.apply = false; continue; }
      log('Saving ' + line(r));
      const res = await updatePosItem(r.pos, fields);
      r.updated = !!(res && res.ok);
      r.note = r.updated ? 'was ' + m(r.pos.price) + (fields.name ? ' / "' + r.pos.name + '"' : '') + (res.checked ? ' · checked in PosPort' : ' · saved, but could not double-check – look in PosPort') : (res && res.error) || 'unknown error';
      if (r.updated) {
        const c = state.catalogue.find((x) => x.name === r.pos.name);
        if (fields.price) { r.pos.price = fields.price; if (c) c.price = fields.price; }
        if (fields.name) { if (c) c.name = fields.name; r.pos.name = fields.name; r.newName = null; }
        r.apply = false;
        r.chk = R.checkExistingPrice(r.pos.price, r.highest, S);
        done.push({ full: r.pos.name, name: r.tname || ticketNameOf(r.pos.name, ''), price: r.pos.price, barcode: r.barcode });
      }
      log(r.pos.name + ': ' + (r.updated ? (res.checked ? 'saved and checked in PosPort' : 'saved, but could not double-check – please look in PosPort') : 'FAILED – ' + r.note), r.updated ? 'ok' : 'err');
      refreshRow(r); saveState();
      if (!r.updated) {
        const go = await pause('Could not save "' + r.pos.name + '": ' + r.note + '. Continue with the next item?');
        if (!go) break;
      }
      await sleep(S.delayMs);
    }
  } finally { setBusy(false); renderAdd(); toPrintList(done, 'changed items'); }
}

$('addCreate').addEventListener('click', () => runCreate(false));
$('addRetry').addEventListener('click', () => runCreate(true));

async function discardBulk() {
  const c = await pos('cancelBulk', S.delayMs);
  log(c && c.pressedCancel ? 'Cancelled the half-filled Bulk Create page.' : 'Cleared the Bulk Create page.');
  await sleep(800);
}

// retry = true: first throw away the half-filled Bulk Create page, then redo every row that
// failed or was filled but never confirmed as created.
async function runCreate(retry, fid) {
  const inFile = (r) => !fid || (r.fileId || 'old') === fid;
  if (retry) {
    const redo = state.add.filter((r) => inFile(r) && (r.status === 'error' || r.status === 'filled'));
    if (!redo.length) { log('Nothing to retry.', 'err'); return; }
    redo.forEach((r) => { r.status = r.name && r.price > 0 && r.category ? 'ready' : 'not found'; r.note = 'retry'; r.use = true; });
    renderAdd(); saveState();
    setBusy(true);
    try { if (await posTabOnBulk()) await discardBulk(); } finally { setBusy(false); }
  }
  const todo = state.add.filter((r) => inFile(r) && !r.pos && r.use !== false && (r.status === 'ready' || r.status === 'check') && r.name && r.price > 0 && r.category);
  const skipped = state.add.filter((r) => inFile(r) && !r.pos && r.use !== false && !todo.includes(r) && !['created', 'filled', 'exists', 'in PosPort'].includes(r.status)).length;
  if (!todo.length) { log('Nothing ready to create (need name, price and category).', 'err'); return; }
  const long = todo.filter((r) => r.name.length > S.nameMaxLength).length;
  if (!confirm((retry ? 'Retry: create ' : 'Create ') + todo.length + ' items in PosPort?' + (skipped ? '\n' + skipped + ' ticked rows are missing a name/price/category and will be skipped.' : '') + (long ? '\n' + long + ' names are longer than ' + S.nameMaxLength + ' characters.' : ''))) return;
  setBusy(true);
  try {
    let start = 0, attempts = 0;
    while (start < todo.length && !stopRequested) {
      const batch = todo.slice(start, start + S.batchSize).filter((it) => it.status !== 'skipped');
      if (!batch.length) { start += S.batchSize; continue; }
      log('Opening Bulk Create for items ' + (start + 1) + '–' + (start + batch.length) + (attempts ? ' (try ' + (attempts + 1) + ')' : ''));
      if (!(await posGo('/catalog/items/bulk', 'bulk'))) { await problem('The Bulk Create page did not load properly. Check you are logged in to PosPort, then press Retry.'); break; }
      const need = batch.length + (S.extraBlankRow ? 1 : 0);
      const rr = await pos('ensureRows', need, S.delayMs);
      if (!rr || !rr.ok) { await problem('Could not add rows on the Bulk Create page: ' + (rr && rr.error) + ' Go to Settings › "Test PosPort page" while on Bulk Create and send the result.'); break; }
      log('Bulk Create has ' + rr.rows + ' rows. Filling ' + batch.length + ' items…');
      let bad = null;
      for (let i = 0; i < batch.length; i++) {
        if (stopRequested) break;
        const it = batch[i];
        const res = await pos('fillBulkRow', i, { name: it.name, barcode: it.barcode, price: it.price, category: it.category }, S.delayMs);
        if (!res || !res.ok) { it.status = 'error'; it.note = res && res.error; bad = it; log('Row ' + (i + 1) + ' (' + it.name + '): ' + (res && res.error), 'err'); break; }
        it.status = 'filled';
        renderAdd();
        await sleep(S.delayMs / 2);
      }
      const resetBatch = () => batch.forEach((it) => { if (it.status === 'filled' || it.status === 'error') it.status = 'ready'; });

      if (bad || stopRequested) {
        const ans = stopRequested ? 'Stop' : await choose('Row "' + bad.name + '" could not be filled (' + (bad.note || 'unknown') + '). What now?',
          ['Retry this batch', 'Skip that item and retry', 'Stop']);
        if (ans === 'Stop') { await discardBulk(); resetBatch(); if (bad) bad.status = 'error'; break; }
        await discardBulk();
        resetBatch();
        if (ans.startsWith('Skip')) { bad.status = 'skipped'; bad.use = false; bad.note = 'skipped after a failed fill'; }
        if (++attempts >= 3 && ans.startsWith('Retry')) { await problem('Still failing after 3 tries – stopping. Check the item, then use "Retry unfinished".'); if (bad) bad.status = 'error'; break; }
        renderAdd(); saveState();
        continue;                                   // same batch again
      }

      const tabId = await posTab();
      let created = true;
      if (S.autoCreate) {
        const c = await pos('clickCreate');
        log(c && c.ok ? 'Pressed "' + c.clicked + '"' : 'Create button: ' + (c && c.error), c && c.ok ? 'ok' : 'err');
        await sleep(2500);
        const st = await pos('toasts');
        if (Array.isArray(st) && st.length) log('PosPort says: ' + st.join(' | '));
        if (!c || !c.ok || (Array.isArray(st) && st.some((t) => /error|fail|invalid|required|exists/i.test(t)))) created = false;
      } else {
        await chrome.tabs.update(tabId, { active: true });
        const ans = await choose('Batch filled. Check the rows in PosPort and press "Create" there. Did it work?',
          ['Created OK', 'It failed – clear and retry', 'Stop']);
        if (ans === 'Stop') { resetBatch(); break; }
        created = ans === 'Created OK';
      }
      if (!created) {
        if (++attempts >= 3) { await problem('Creating failed 3 times – stopping. Use "Retry unfinished" later.'); batch.forEach((it) => { it.status = 'error'; }); break; }
        await discardBulk(); resetBatch(); renderAdd(); saveState();
        continue;
      }
      const made = batch.filter((it) => it.status === 'filled');
      made.forEach((it) => { it.status = 'created'; it.note = ''; });
      if (made.length) {
        state.catalogue.push(...made.map((it) => ({ name: it.name, price: it.price, barcode: it.barcode })));
        toPrintList(made.map((it) => ({ full: it.name, name: it.tname || ticketNameOf(it.name, ''), price: it.price, barcode: it.barcode })), 'new items');
      }
      renderAdd(); saveState();
      start += S.batchSize; attempts = 0;
    }
    log('Create run finished. Download the comparison Excel to keep a record.', 'ok');
  } finally { setBusy(false); renderAdd(); saveState(); }
}

async function posTabOnBulk() {
  const tabs = await chrome.tabs.query({ url: POS + '/catalog/items/bulk*' });
  return tabs.length > 0;
}

$('addExport').addEventListener('click', () => exportItems(state.add, 'items-and-prices'));
function exportItems(list, base) {
  const fname = (r) => ((state.files || []).find((f) => f.id === (r.fileId || 'old')) || {}).name || '';
  const rows = list.map((r) => ({
    File: fname(r),
    Barcode: r.barcode,
    'Name in PosPort': r.name || '',
    'Ticket name': r.tname || '',
    Category: r.category || '',
    'Woolworths product': r.ww && r.ww.found ? r.ww.name : '',
    'Woolworths normal $': r.ww && r.ww.found ? r.ww.regular : '',
    'Woolworths special $': r.ww && r.ww.found && r.ww.onSpecial ? r.ww.now : '',
    'Coles product': r.coles && r.coles.found ? r.coles.name : '',
    'Coles normal $': r.coles && r.coles.found ? r.coles.regular : '',
    'Coles special $': r.coles && r.coles.found && r.coles.onSpecial ? r.coles.now : '',
    'Invoice cost each $': r.inv && r.inv.unitCost ? R.round2(r.inv.unitCost) : '',
    'Invoice RRP $': r.inv && r.inv.rrp ? r.inv.rrp : '',
    'Invoice': r.inv ? String(r.inv.supplier || '').replace(/ Pty Ltd/i, '') + ' #' + (r.inv.number || '') + ' ' + (r.inv.date || '') : '',
    'Margin % at our price': r.inv && r.inv.unitCost && (r.pos ? (r.newPrice || r.pos.price) : r.price) ? Math.round(((r.pos ? (r.newPrice || r.pos.price) : r.price) - r.inv.unitCost) / (r.pos ? (r.newPrice || r.pos.price) : r.price) * 100) : '',
    'Highest $': r.highest || '',
    'Our price $': r.pos ? '' : (r.price || ''),
    'In PosPort as': r.pos ? r.pos.name : (r.maybe ? 'maybe: ' + r.maybe.name : ''),
    'PosPort price $': r.pos ? r.pos.price : '',
    'Check': r.chk ? r.chk.status : '',
    'New price $': r.pos ? (r.newPrice || '') : '',
    'Price updated': r.updated === true ? 'yes' : r.updated === false ? 'FAILED' : '',
    'Markup $': r.price && r.highest ? R.round2(r.price - r.highest) : '',
    Status: r.status,
    Note: r.note || '',
  }));
  if (!rows.length) { log('Nothing to download.', 'err'); return; }
  writeSheet(rows, base + '-' + today() + '.xlsx', 'Items');
  log('Excel downloaded.', 'ok');
}

const ADD_FAILED = ['not found', 'error', 'check', 'skipped'];
$('addFailed').addEventListener('click', () => {
  const rows = state.add.filter((r) => ADD_FAILED.includes(r.status)).map((r) => Object.assign({
    'Why it failed': r.status === 'check' ? 'Matched by name, not barcode – make sure it is the same product'
      : r.status === 'error' ? 'PosPort did not accept this row' : 'No price found',
    Barcode: r.barcode,
    'Barcode check digit': r.barcode ? (R.validBarcode(r.barcode) ? 'ok' : 'WRONG – re-scan') : '',
    'Name in your sheet': r.inName || '',
    'Supplier text': r.hint || '',
    'Label name (bot)': r.name || '',
    'Name length': (r.name || '').length,
    Category: r.category || '',
    'Our price $': r.price || '',
    'Highest $': r.highest || '',
    'Status': r.status,
    'Details': r.note || '',
    'Used in this run': r.use === false ? 'no' : 'yes',
  }, storeCols('Woolworths', r.ww), storeCols('Coles', r.coles), {
    'Internet name': r.net ? r.net.name : '',
    'Internet size': r.net ? r.net.size || '' : '',
    'Internet source': r.net ? r.net.source : '',
    'Internet category': r.net ? r.net.dept || '' : '',
    'Search on Woolworths': r.barcode ? 'https://www.woolworths.com.au/shop/search/products?searchTerm=' + r.barcode : '',
    'Search on Coles': r.barcode ? 'https://www.coles.com.au/search/products?q=' + r.barcode : '',
  }));
  downloadFailed(rows, 'add-items-failed', 'Failed');
});

$('addToTickets').addEventListener('click', () => { $('tkFromAdd').click(); showTab('tickets'); });



// =====================================================================
// 2. PRICE CHECK
// =====================================================================
function catalogueIndex() {
  const byName = new Map();
  state.catalogue.forEach((c) => byName.set(c.name.toLowerCase(), c));
  return byName;
}

$('chkScan').addEventListener('click', async () => {
  setBusy(true);
  try { await scanCatalogue(); } finally { setBusy(false); }
});

async function scanCatalogue() {
  {
    if (!(await posGo('/catalog/items', 'items'))) { log('Items page did not open.', 'err'); return; }
    const seen = new Map();
    for (let page = 1; page <= 200; page++) {
      if (stopRequested) break;
      const res = await pos('readListRows');
      (res && res.rows || []).forEach((r) => seen.set(r.name.toLowerCase(), { name: r.name, price: r.price, href: r.href }));
      $('chkScanInfo').textContent = 'Page ' + page + ' · ' + seen.size + ' items';
      const nx = await pos('nextPage', S.delayMs);
      if (!nx || !nx.ok) break;
    }
    const cap = await pos('captured');
    const capItems = (cap && cap.items) || [];
    // the network copy has ids and barcodes; check its price units against what is on screen
    let ratio = 1;
    const both = capItems.filter((c) => seen.has(c.name.toLowerCase()) && c.price > 0 && seen.get(c.name.toLowerCase()).price > 0);
    if (both.length >= 3) {
      const med = both.map((c) => c.price / seen.get(c.name.toLowerCase()).price).sort((a, b) => a - b)[Math.floor(both.length / 2)];
      if (med > 50) ratio = 100;
    }
    capItems.forEach((c) => {
      const k = c.name.toLowerCase();
      const cur = seen.get(k) || { name: c.name, price: R.round2(c.price / ratio) };
      seen.set(k, Object.assign(cur, { id: c.id, barcode: R.cleanBarcode(c.barcode), category: c.category }));
    });
    state.catalogue = Array.from(seen.values());
    state.catalogueAt = Date.now();
    const withBc = state.catalogue.filter((c) => c.barcode).length;
    $('chkScanInfo').textContent = state.catalogue.length + ' items · ' + withBc + ' with barcode';
    log('Scanned ' + state.catalogue.length + ' PosPort items (' + withBc + ' with barcodes).', 'ok');
    saveState();
  }
}

$('chkFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.checkInput = R.parseInputRows(await readSheet(f));
  $('chkFileInfo').textContent = f.name + ' — ' + state.checkInput.length + ' items';
  log('Loaded ' + state.checkInput.length + ' items to check from ' + f.name);
  e.target.value = '';
  saveState(); refreshButtons();
});

$('chkUseAll').addEventListener('click', () => {
  if (!state.catalogue.length) { log('Scan PosPort items first.', 'err'); return; }
  const withBc = state.catalogue.filter((c) => c.barcode);
  if (!withBc.length && !confirm('None of the scanned items came with a barcode. Check them by name instead? Name matches are less reliable and will be marked "check".')) return;
  const src = withBc.length ? withBc : state.catalogue;
  state.checkInput = src.map((c) => ({ barcode: c.barcode || '', name: c.name, currentPrice: c.price }));
  $('chkFileInfo').textContent = 'All scanned items — ' + state.checkInput.length;
  saveState(); refreshButtons();
});

function matchCatalogue(inp) {
  if (inp.barcode) {
    const b = state.catalogue.find((c) => c.barcode && R.sameBarcode(c.barcode, inp.barcode));
    if (b) return b;
  }
  if (inp.name) {
    const exact = catalogueIndex().get(inp.name.toLowerCase());
    if (exact) return exact;
    const best = R.posMatch(inp.name, state.catalogue, (c) => c.name);
    if (best.item && best.sure) return best.item;
  }
  return null;
}

function renderCheck() {
  const t = $('chkTable');
  const only = $('chkOnlyFlagged').checked;
  const rows = state.check.map((r, i) => ({ r, i })).filter(({ r }) => !only || r.flagged || r.status === 'NO DATA' || r.applied);
  if (!state.check.length) { t.innerHTML = ''; return; }
  const pill = (r) => {
    if (r.applied === true) return '<span class="pill ok">updated</span>';
    if (r.applied === false) return '<span class="pill bad" title="' + esc(r.note || '') + '">update failed</span>';
    const cls = r.status === 'OK' ? 'ok' : r.status === 'NO DATA' ? 'idle' : 'bad';
    return '<span class="pill ' + cls + '">' + esc(r.status) + '</span>';
  };
  t.innerHTML = '<thead><tr><th>Update</th><th>PosPort item</th><th>Barcode</th><th class="num">Our price</th><th>Woolworths</th><th>Coles</th><th class="num">Highest</th><th class="num">Above highest</th><th>Status</th><th class="num">New price</th></tr></thead><tbody>' +
    rows.map(({ r, i }) => '<tr data-i="' + i + '">' +
      '<td><input type="checkbox" class="apply" ' + (r.apply ? 'checked' : '') + (r.posName ? '' : ' disabled title="Not found in PosPort scan"') + '></td>' +
      '<td>' + esc(r.posName || '') + (r.posName ? '' : '<span class="sub">' + esc(r.inName || 'not in PosPort scan') + '</span>') + '</td>' +
      '<td>' + esc(r.barcode) + '</td>' +
      '<td class="num">' + m(r.ours) + '</td>' +
      '<td>' + storeCell(r.ww) + '</td><td>' + storeCell(r.coles) + '</td>' +
      '<td class="num">' + m(r.highest) + '</td>' +
      '<td class="num">' + (r.diff === null || r.diff === undefined ? '' : (r.diff < 0 ? '−' : '') + '$' + Math.abs(r.diff).toFixed(2)) + '</td>' +
      '<td>' + pill(r) + '</td>' +
      '<td class="num"><input type="number" step="0.01" class="price" value="' + (r.newPrice ? Number(r.newPrice).toFixed(2) : '') + '"></td></tr>').join('') + '</tbody>';
  const f = state.check.filter((r) => r.flagged).length;
  const low = state.check.filter((r) => r.status === 'TOO LOW').length;
  const high = state.check.filter((r) => r.status === 'TOO HIGH').length;
  const nd = state.check.filter((r) => r.status === 'NO DATA').length;
  $('chkSummary').textContent = state.check.length + ' checked · ' + f + ' flagged (' + low + ' too low, ' + high + ' too high) · ' + nd + ' no data';
  refreshButtons();
}

$('chkOnlyFlagged').addEventListener('change', renderCheck);
$('chkTable').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.check[+tr.dataset.i];
  if (e.target.classList.contains('price')) {
    r.newPrice = R.parseMoney(e.target.value);
    if (r.newPrice && r.posName) { r.apply = true; tr.querySelector('.apply').checked = true; }
  }
  saveState();
});
$('chkTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  if (e.target.classList.contains('apply')) { state.check[+tr.dataset.i].apply = e.target.checked; saveState(); }
});

$('chkLookup').addEventListener('click', async () => {
  if (!state.checkInput.length) { log('Load barcodes or use scanned items first.', 'err'); return; }
  setBusy(true);
  try {
    // keep results already done for the same barcodes
    const prev = new Map(state.check.map((r) => [r.barcode || r.inName, r]));
    state.check = [];
    let n = 0;
    for (const inp of state.checkInput) {
      if (stopRequested) break;
      const key = inp.barcode || inp.name;
      const old = prev.get(key);
      if (old && old.highest && !old.applied) { state.check.push(old); continue; }
      n++;
      let pm = matchCatalogue(inp);
      log('Comparing ' + (pm ? pm.name : key) + ' (' + n + ')');
      const res = await lookupPrices(inp.barcode, pm ? pm.name : (inp.name || inp.hint));
      if (!pm) {
        // PosPort has no barcodes to match on: use the supermarket's name for the product
        const src = (res.ww && res.ww.found && res.ww) || (res.coles && res.coles.found && res.coles);
        if (src) { const m = R.posMatch(src.name, state.catalogue, (c) => c.name); if (m.item && m.sure) pm = m.item; }
      }
      const ours = inp.currentPrice !== null && inp.currentPrice !== undefined ? inp.currentPrice : (pm ? pm.price : null);
      const chk = R.checkExistingPrice(ours, res.highest, S);
      const unsure = [res.ww, res.coles].some((s) => s && s.found && s.match && s.match !== 'barcode');
      state.check.push({
        barcode: inp.barcode, inName: inp.name, posName: pm ? pm.name : '', posId: pm ? pm.id : '',
        ours, ww: res.ww, coles: res.coles, highest: res.highest,
        diff: chk.diff, status: chk.status, flagged: chk.flagged,
        newPrice: chk.flagged ? chk.suggested : null, apply: false,
        note: unsure ? 'Supermarket matched by name – check it' : '',
      });
      renderCheck(); saveState();
    }
    log('Price check finished.', 'ok');
    if (S.autoExportFailed && state.check.some((r) => r.status === 'NO DATA' || !r.posName)) setTimeout(() => $('chkFailed').click(), 0);
  } finally { setBusy(false); renderCheck(); }
});

$('chkExport').addEventListener('click', () => {
  const rows = state.check.map((r) => ({
    'PosPort item': r.posName || r.inName || '',
    Barcode: r.barcode,
    'Our price $': r.ours === null ? '' : r.ours,
    'Woolworths product': r.ww && r.ww.found ? r.ww.name : '',
    'Woolworths normal $': r.ww && r.ww.found ? r.ww.regular : '',
    'Coles product': r.coles && r.coles.found ? r.coles.name : '',
    'Coles normal $': r.coles && r.coles.found ? r.coles.regular : '',
    'Highest $': r.highest || '',
    'Above highest $': r.diff === null || r.diff === undefined ? '' : r.diff,
    Status: r.status,
    'New price $': r.newPrice || '',
    Updated: r.applied === true ? 'yes' : r.applied === false ? 'FAILED' : '',
    Note: r.note || '',
  }));
  writeSheet(rows, 'price-check-' + today() + '.xlsx', 'Price check');
  log('Price check Excel downloaded.', 'ok');
});

$('chkFailed').addEventListener('click', () => {
  const rows = state.check.filter((r) => r.status === 'NO DATA' || r.applied === false || !r.posName).map((r) => Object.assign({
    'Why it failed': r.applied === false ? 'Price update in PosPort failed'
      : !r.posName ? 'Could not find this item in the PosPort scan'
      : r.ours === null || r.ours === undefined ? 'No PosPort price' : 'No Woolworths or Coles price',
    'PosPort item': r.posName || '',
    'PosPort id': r.posId || '',
    Barcode: r.barcode || '',
    'Name in your sheet': r.inName || '',
    'Our price $': r.ours === null || r.ours === undefined ? '' : r.ours,
    'Highest $': r.highest || '',
    'Above highest $': r.diff === null || r.diff === undefined ? '' : r.diff,
    Status: r.status,
    'New price $': r.newPrice || '',
    'Update result': r.applied === true ? 'updated' : r.applied === false ? 'FAILED' : '',
    Details: r.note || '',
  }, storeCols('Woolworths', r.ww), storeCols('Coles', r.coles)));
  downloadFailed(rows, 'price-check-failed', 'Failed');
});

$('chkApply').addEventListener('click', async () => {
  const todo = state.check.filter((r) => r.apply && r.posName && r.newPrice > 0);
  if (!todo.length) { log('Tick the rows to update and give them a new price.', 'err'); return; }
  if (!confirm('Change the price of ' + todo.length + ' items in PosPort?\n\n' + todo.slice(0, 15).map((r) => r.posName + ': ' + m(r.ours) + ' → ' + m(r.newPrice)).join('\n') + (todo.length > 15 ? '\n…' : ''))) return;
  setBusy(true);
  const chkDone = [];
  try {
    for (const r of todo) {
      if (stopRequested) break;
      log('Updating ' + r.posName + ' → ' + m(r.newPrice));
      const res = await updatePosPrice(r.posName, r.newPrice);
      r.applied = !!(res && res.ok);
      r.note = res && res.ok ? 'was ' + (res.old || r.ours) : (res && res.error) || 'unknown error';
      if (r.applied) { r.ours = r.newPrice; r.apply = false; chkDone.push({ full: r.posName, name: ticketNameOf(r.posName, ''), price: r.newPrice, barcode: r.barcode }); }
      log(r.posName + ': ' + (r.applied ? 'updated' : 'FAILED – ' + r.note), r.applied ? 'ok' : 'err');
      renderCheck(); saveState();
      if (!r.applied) {
        const go = await pause('Could not update "' + r.posName + '": ' + r.note + '. Continue with the next item?');
        if (!go) break;
      }
      await sleep(S.delayMs);
    }
  } finally { setBusy(false); toPrintList(chkDone, 'changed prices'); }
});

// =====================================================================
// 3. LABELS
// =====================================================================
function lblLog(msg, cls) {
  const li = document.createElement('li');
  li.textContent = msg; if (cls) li.className = cls;
  $('lblLog').appendChild(li);
}

$('lblFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rows = await readSheet(f);
  const head = (rows[0] || []).map((h) => String(h).toLowerCase());
  let col = head.findIndex((h) => /name|item/.test(h));
  const names = rows.slice(col >= 0 ? 1 : 0).map((r) => String(r[col >= 0 ? col : 0] || '').trim()).filter(Boolean);
  $('lblNames').value = names.join('\n');
  e.target.value = '';
});
$('lblFailed').addEventListener('click', () => exportLabelFailures());
function exportLabelFailures() {
  const rows = (state.labels || []).filter((r) => r.status === 'failed').map((r) => ({
    'What you entered': r.line,
    'Barcode check digit': r.barcodeOk === '' || r.barcodeOk === undefined ? '' : (r.barcodeOk ? 'ok' : 'WRONG – re-scan'),
    'Product it is': r.product || '',
    'Where the name came from': r.source || '',
    'Why it failed': r.reason || '',
    'Closest PosPort item': r.closest || '',
    'Closest match %': r.closestScore ? Math.round(r.closestScore * 100) : '',
    'Next closest PosPort item': r.runnerUp || '',
    'Words searched in PosPort': r.words || '',
    'Other possible PosPort items': (r.candidates || []).map((c) => c.name + ' (' + Math.round(c.score * 100) + '%)').join(' | '),
    'Probably missing from Back Office': r.missing ? 'yes' : 'no',
    'In last PosPort scan?': state.catalogue.length ? (r.closest && state.catalogue.some((c) => c.name === r.closest) ? 'closest item is' : 'no close item') : 'no scan yet',
    Time: r.time,
  }));
  downloadFailed(rows, 'labels-failed', 'Failed');
}

// ---- "Not ticked" panel: pick the right PosPort item, or add the product to the Back Office ----
function renderIssues() {
  const box = $('lblIssues');
  const fails = (state.labels || []).map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'failed');
  if (!fails.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="toolbar"><h3>Not ticked (' + fails.length + ')</h3><span class="spacer"></span>' +
    '<button class="btn small" id="issAddAll">Add all missing to Back Office</button>' +
    '<button class="btn small primary" id="issRerun">Run labels again with my picks</button></div>' +
    '<table class="grid"><thead><tr><th>Entered</th><th>Product</th><th>Is it one of these PosPort items?</th><th>Not in PosPort?</th></tr></thead><tbody>' +
    fails.map(({ r, i }) => '<tr data-i="' + i + '"><td>' + esc(r.line) + '</td><td>' + esc(r.product || '—') +
      '<span class="sub">' + esc(r.reason || '') + '</span></td><td>' +
      ((r.candidates || []).length ? r.candidates.map((c, k) => '<label class="check pick"><input type="radio" name="pick' + i + '" value="' + k + '"' + (r.chosen === c.name ? ' checked' : '') + '> ' +
        esc(c.name) + ' <span class="muted">' + (c.price ? '$' + Number(c.price).toFixed(2) + ' · ' : '') + Math.round(c.score * 100) + '%</span></label>').join('') : '<span class="muted">nothing similar</span>') +
      '</td><td>' + (r.queued ? '<span class="pill ok">in Add items</span>' : '<button class="btn small add1">Add to Back Office</button>') + '</td></tr>').join('') +
    '</tbody></table>';
}

$('lblIssues').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || e.target.type !== 'radio') return;
  const r = state.labels[+tr.dataset.i];
  r.chosen = r.candidates[+e.target.value].name;
});

function queueForAdd(r) {
  if (r.queued) return;
  if (r.barcode && state.add.some((a) => a.barcode && R.sameBarcode(a.barcode, r.barcode))) { r.queued = true; return; }
  ensureFiles();
  if (!state.files.some((f) => f.id === 'labels')) state.files.unshift({ id: 'labels', name: 'Missing from PosPort (from labels)', open: true });
  state.add.push({ barcode: r.barcode || '', inName: '', hint: r.product && r.product !== r.line ? r.product : (r.barcode ? '' : r.line),
    name: '', category: '', price: null, status: 'waiting', use: true, fileId: 'labels' });
  setTimeout(() => startLookup(), 0);
  r.queued = true;
}

$('lblIssues').addEventListener('click', (e) => {
  if (e.target.id === 'issAddAll') {
    const miss = state.labels.filter((r) => r.status === 'failed' && (r.missing || !r.chosen));
    miss.forEach(queueForAdd);
    saveState(); renderAdd(); renderIssues();
    log(miss.length + ' items sent to "Add new items". Press "Look up prices" there.', 'ok');
    showTab('add');
    return;
  }
  if (e.target.id === 'issRerun') {
    const lines = $('lblNames').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const ticked = new Set(state.labels.filter((r) => r.status === 'ticked').map((r) => r.line));
    const out = lines.filter((l) => !ticked.has(l)).map((l) => {
      const r = state.labels.find((x) => x.line === l);
      return r && r.chosen ? r.chosen : l;
    }).filter((l) => { const r = state.labels.find((x) => x.line === l); return !(r && r.queued); });
    const keep = state.labels.filter((r) => r.status === 'ticked').map((r) => r.posName || r.line);
    $('lblNames').value = keep.concat(out).join('\n');
    $('lblRun').click();
    return;
  }
  if (e.target.classList.contains('add1')) {
    const r = state.labels[+e.target.closest('tr').dataset.i];
    queueForAdd(r);
    saveState(); renderAdd(); renderIssues();
    log('"' + (r.product || r.line) + '" sent to "Add new items".', 'ok');
  }
});
$('lblClear').addEventListener('click', () => { $('lblNames').value = ''; $('lblLog').innerHTML = ''; state.labels = []; renderIssues(); refreshButtons(); });

// What is this barcode? Woolworths, then Coles, then the open barcode databases.
async function identifyBarcode(bc) {
  const ww = await storeCall('ww', 'wwLookup', [bc, '']);
  if (ww && ww.found && ww.match === 'barcode') return { name: ww.name, source: 'Woolworths' };
  const co = await storeCall('coles', 'colesLookup', [bc, '']);
  if (co && co.found && co.match === 'barcode') return { name: co.name, source: 'Coles' };
  const net = await window.CSB_STORES.internetLookup(bc);
  if (net && net.found) return { name: [net.name, net.size].filter(Boolean).join(' '), source: net.source };
  const iv = invoiceFor(bc);
  if (iv) return { name: iv.name || INV.tidyName(iv.desc), source: 'invoice ' + (iv.number || '') };
  if (ww && ww.found) return { name: ww.name, source: 'Woolworths (check)' };
  if (co && co.found) return { name: co.name, source: 'Coles (check)' };
  return null;
}

// Find a product in Catalog > Items and tick it. PosPort only searches names, so:
// 1) the exact name, 2) the best match from the last full scan, 3) keyword searches checked by size + words.
async function tickProduct(product) {
  let s = await pos('searchList', product, S.delayMs);
  if (s && s.ok) {
    const t = await pos('tickRow', product, false);
    if (t && t.ok) return { ok: true, name: t.name };
  }
  if (state.catalogue.length) {
    const m = R.posMatch(product, state.catalogue, (c) => c.name);
    if (m.item && m.sure) {
      s = await pos('searchList', m.item.name, S.delayMs);
      const t = await pos('tickRow', m.item.name, false);
      if (t && t.ok) return { ok: true, name: t.name, score: m.score };
    }
  }
  let best = null;
  const seen = new Map();
  if (state.catalogue.length) state.catalogue.forEach((c) => seen.set(c.name, c.price));
  for (const word of R.searchWords(product)) {
    s = await pos('searchList', word, S.delayMs);
    const rows = (s && s.rows) || [];
    rows.forEach((r) => seen.set(r.name, r.price));
    const m = R.posMatch(product, rows, (r) => r.name);
    if (m.item && (!best || m.score > best.score)) best = Object.assign({ word }, m);
    if (m.item && m.sure) {
      const t = await pos('tickRow', m.item.name, false);
      if (t && t.ok) return { ok: true, name: t.name, score: m.score };
    }
  }
  const candidates = Array.from(seen.keys()).map((n) => ({ name: n, price: seen.get(n), score: R.posScore(product, n) }))
    .filter((c) => c.score > 0.2).sort((a, b) => b.score - a.score).slice(0, 4);
  if (best && best.item) {
    return { candidates, ok: false, error: 'not sure – closest is "' + best.item.name + '" (' + Math.round(best.score * 100) + '%)' + (best.runnerUp ? ' or "' + best.runnerUp.name + '"' : '') + '. Paste the exact name to use it.',
      closest: best.item.name, closestScore: best.score, runnerUp: best.runnerUp ? best.runnerUp.name : '', words: R.searchWords(product).join(', ') };
  }
  return { candidates, ok: false, missing: true, error: 'no item like "' + product + '" in PosPort', words: R.searchWords(product).join(', ') };
}

$('lblRun').addEventListener('click', async () => {
  const names = $('lblNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  $('lblLog').innerHTML = '';
  state.labels = [];
  const record = (o) => { state.labels.push(Object.assign({ time: new Date().toLocaleString() }, o)); };
  setBusy(true);
  try {
    // Lines can be item names or barcodes. Turn barcodes into PosPort names where we know them.
    const isBarcode = (x) => /^\d{7,14}$/.test(x.replace(/\s/g, ''));
    const cap = await pos('captured');
    const capItems = (cap && cap.items) || [];
    const nameFor = (line) => {
      if (!isBarcode(line)) return line;
      const bc = line.replace(/\s/g, '');
      const c = capItems.find((x) => x.barcode && R.sameBarcode(x.barcode, bc)) ||
        state.catalogue.find((x) => x.barcode && R.sameBarcode(x.barcode, bc));
      if (c) return c.name;
      const a = state.add.find((x) => x.barcode && R.sameBarcode(x.barcode, bc) && x.name && (x.status === 'created' || x.status === 'filled'));
      return a ? a.name : line;
    };
    const wanted = names.map((n) => ({ line: n, name: nameFor(n) }));

    // Fast path: if we know every item's PosPort id, open the label page directly.
    const byName = new Map(capItems.map((c) => [c.name.toLowerCase(), c.id]));
    const ids = wanted.map((w) => byName.get(w.name.toLowerCase()));
    if (ids.every(Boolean)) {
      const tabId = await posTab();
      await chrome.tabs.update(tabId, { url: POS + '/print/labels?' + ids.map((id) => 'item=' + encodeURIComponent(id)).join('&'), active: true });
      wanted.forEach((w) => record({ line: w.line, product: w.name, posName: w.name, status: 'ticked', how: 'opened by PosPort id' }));
      lblLog('Opened Print labels with all ' + names.length + ' items. Choose the label stock and press Print.', 'ok');
      return;
    }
    if (!state.catalogue.length && wanted.filter((w) => isBarcode(w.name) || w.name.split(' ').length < 3).length >= 5 &&
        confirm('Faster and more accurate: read all PosPort item names first (takes about a minute)?')) {
      await scanCatalogue();
    }
    if (!(await posGo('/catalog/items', 'items'))) { lblLog('Items page did not open.', 'err'); return; }
    let ticked = 0;
    for (const w of wanted) {
      if (stopRequested) break;
      let product = w.name;
      let id = null;
      if (isBarcode(product)) {
        // PosPort can't search barcodes: find out what the product is first
        id = await identifyBarcode(product);
        if (!id) {
          lblLog('✗ ' + w.line + ': not found at Woolworths, Coles or the barcode databases – type its name instead', 'err');
          record({ line: w.line, status: 'failed', reason: 'Barcode not found at Woolworths, Coles or the barcode databases', barcodeOk: R.validBarcode(w.line), barcode: w.line.replace(/\s/g, ''), missing: true, candidates: [] });
          continue;
        }
        product = id.name;
        lblLog('… ' + w.line + ' is "' + product + '" (' + id.source + ')');
      }
      const res = await tickProduct(product);
      record({
        line: w.line, product, source: id ? id.source : (w.name !== w.line ? 'last PosPort scan' : 'typed name'),
        status: res.ok ? 'ticked' : 'failed', posName: res.ok ? res.name : '', score: res.score || '',
        reason: res.ok ? '' : res.error, closest: res.closest || '', closestScore: res.closestScore || '', runnerUp: res.runnerUp || '',
        words: res.words || '', barcodeOk: isBarcode(w.line) ? R.validBarcode(w.line) : '',
        barcode: isBarcode(w.line) ? w.line.replace(/\s/g, '') : '', candidates: res.candidates || [], missing: !!res.missing,
      });
      if (res.ok) { ticked++; lblLog('✓ ' + w.line + (res.name.toLowerCase() !== w.line.toLowerCase() ? ' → ' + res.name + (res.score ? ' (' + Math.round(res.score * 100) + '% match)' : '') : ''), 'ok'); }
      else lblLog('✗ ' + w.line + ': ' + res.error, 'err');
      await sleep(S.delayMs / 2);
    }
    const nFail = state.labels.filter((r) => r.status === 'failed').length;
    renderIssues();
    if (nFail) {
      lblLog(nFail + ' not ticked – see "Not ticked" below to pick the right item or add it to the Back Office.', 'err');
      if (S.autoExportFailed) exportLabelFailures();
    }
    if (!ticked) { lblLog('Nothing was ticked.', 'err'); return; }
    const p = await pos('clickPrintLabels');
    const tabId = await posTab();
    await chrome.tabs.update(tabId, { active: true });
    lblLog(p && p.ok ? 'Pressed Print labels (' + ticked + ' items). Choose the label stock and press Print.' : 'Ticked ' + ticked + ' items but: ' + (p && p.error), p && p.ok ? 'ok' : 'err');
  } finally { setBusy(false); }
});


// =====================================================================
// 4. MY TICKETS – our own shelf tickets, printed from here
// =====================================================================
const B = window.CSB_BARCODE;

function tkOpts() {
  const pick = (sel, custom, def) => {
    const v = $(sel).value === 'custom' ? parseFloat($(custom).value) : parseFloat($(sel).value);
    return isFinite(v) && v > 0.4 && v < 8 ? v : def;
  };
  return {
    w: pick('tkW', 'tkWc', 2.5), h: pick('tkH', 'tkHc', 1), paper: $('tkPaper').value, shop: $('tkShop').value.trim(),
    barcode: $('tkBarcode').checked, unit: $('tkUnit').checked, date: $('tkDate').checked, border: $('tkBorder').checked,
    layout: $('tkLayout').value,
    gap: Math.max(0, Math.min(10, parseFloat($('tkGap').value) || 0)),
    rows: parseInt($('tkRows').value, 10) || 0,
  };
}

function saveTkOpts() {
  state.tkOpts = { W: $('tkW').value, Wc: $('tkWc').value, H: $('tkH').value, Hc: $('tkHc').value, paper: $('tkPaper').value, shop: $('tkShop').value,
    barcode: $('tkBarcode').checked, unit: $('tkUnit').checked, date: $('tkDate').checked, border: $('tkBorder').checked,
    layout: $('tkLayout').value, shorten: $('tkShorten').checked, v2: true, gap: $('tkGap').value, rows: $('tkRows').value };
  saveState();
}
function loadTkOpts() {
  const o = state.tkOpts || {};
  if (o.W) $('tkW').value = o.W; if (o.Wc) $('tkWc').value = o.Wc; if (o.H) $('tkH').value = o.H; if (o.Hc) $('tkHc').value = o.Hc;
  if (o.paper && o.v2) $('tkPaper').value = o.paper; if (o.shop) $('tkShop').value = o.shop;
  if (o.gap !== undefined && o.gap !== '') $('tkGap').value = o.gap; if (o.rows) $('tkRows').value = o.rows;
  if (o.layout) $('tkLayout').value = o.layout; if (o.shorten !== undefined) $('tkShorten').checked = o.shorten;
  ['barcode', 'unit', 'date', 'border'].forEach((k) => { if (o[k] !== undefined) $('tk' + k[0].toUpperCase() + k.slice(1)).checked = o[k]; });
  $('tkWc').classList.toggle('hidden', $('tkW').value !== 'custom');
  $('tkHc').classList.toggle('hidden', $('tkH').value !== 'custom');
}

function sizeFromName(name) {
  const m = String(name || '').match(/(\d+\s?x\s?\d+(?:\.\d+)?\s?(?:g|kg|ml|l)|\d+(?:\.\d+)?\s?(?:g|kg|ml|l))\b/ig);
  return m ? m[m.length - 1] : '';
}

function addTickets(items, quiet) {
  let n = 0;
  items.forEach((it) => {
    if (!it.name) return;
    const full = it.full || it.name;
    const dup = state.tickets.find((t) => (t.full || t.name).toLowerCase() === full.toLowerCase());
    if (dup) { if (it.price) dup.price = it.price; if (it.barcode && !dup.barcode) dup.barcode = it.barcode; return; }
    const short = it.full ? it.name : ($('tkShorten').checked ? ticketNameOf(full, '') : full);
    state.tickets.push({ full, name: short, price: it.price || null, was: it.was || null, barcode: it.barcode || '', size: it.size || sizeFromName(full), qty: 1, use: true });
    n++;
  });
  if (quiet) return;
  saveState(); renderTickets();
  log(n + ' tickets added' + (items.length - n ? ', ' + (items.length - n) + ' already there (updated)' : '') + '.', 'ok');
}

function ticketHTML(t, o) {
  const price = R.parseMoney(t.price);
  const dollars = price === null ? '–' : String(Math.floor(price + 1e-9));
  const cents = price === null ? '' : '.' + String(Math.round((price - Math.floor(price + 1e-9)) * 100)).padStart(2, '0');
  const unit = o.unit && price ? R.unitPrice(price, t.size || t.name) : '';
  const enc = o.barcode && t.barcode ? B.encode(t.barcode) : null;
  const was = R.parseMoney(t.was);
  const meta = [t.size ? '<b>' + esc(t.size) + '</b>' : '', unit ? esc(unit) : ''].filter(Boolean).join(' · ');
  const foot = [o.shop ? esc(o.shop) : '', o.date ? new Date().toLocaleDateString('en-AU') : ''].filter(Boolean).join(' · ');
  const special = was && price && was > price;
  return '<div class="ticket layout-' + (o.layout || 'bold') + (o.border ? ' bordered' : '') + (special ? ' has-was' : '') + '" style="--tw:' + o.w + 'in;--th:' + o.h + 'in">' +
    (was && price && was > price ? '<div class="t-was">SPECIAL<s>' + m(was) + '</s></div>' : '') +
    '<div class="t-name">' + esc(t.name) + '</div>' +
    '<div class="t-info">' +
      (meta ? '<div class="t-meta">' + meta + '</div>' : '') +
      (enc ? '<div class="t-bc">' + B.barcodeSVG(t.barcode, o.w >= 2.9 ? 0.01333 : 0.01) + '</div><div class="t-digits">' + esc(enc.text) + '</div>' : '') +
      (foot ? '<div class="t-shop">' + foot + '</div>' : '') +
    '</div>' +
    (meta ? '<div class="t-meta t-meta-side">' + meta.replace(' · ', '<br>') + '</div>' : '') +
    '<div class="t-price"><span class="cur">$</span><span class="dol">' + dollars + '</span><span class="cts">' + cents + '</span></div>' +
  '</div>';
}

// Make the name as big as possible (within its line limit), then the price as big as the space allows
// without the ticket overflowing. Works for every layout.
function fitTickets(root) {
  root.querySelectorAll('.ticket').forEach((el) => {
    const H = el.clientHeight, W = el.clientWidth;
    const layout = (el.className.match(/layout-(\w+)/) || [])[1] || 'bold';
    const nm = el.querySelector('.t-name');
    const pr = el.querySelector('.t-price');
    // overflow measured on the boxes (big price digits deliberately hang outside their tight line box)
    const over = () => { const e = el.getBoundingClientRect();
      return ['.t-name', '.t-price', '.t-info'].some((q) => { const b = el.querySelector(q).getBoundingClientRect(); return b.bottom > e.bottom + 1 || b.right > e.right + 1; }); };
    let fs = Math.min(layout === 'compact' ? 12 : 13, H / 96 * 72 * (layout === 'posport' ? 0.17 : 0.2));
    nm.style.fontSize = fs + 'pt';
    while (fs > 6 && nm.scrollHeight > nm.clientHeight + 1) { fs -= 0.5; nm.style.fontSize = fs + 'pt'; }
    const share = { bold: el.querySelector('.t-bc') ? 0.5 : 0.62, posport: 0.62, compact: 0.45 }[layout];
    const pad = 8;
    const infoH = Array.from(el.querySelector('.t-info').children).filter((c) => getComputedStyle(c).display !== 'none')
      .reduce((a, c) => a + c.getBoundingClientRect().height, 0) + 2;
    const nameH = nm.getBoundingClientRect().height;
    const room = layout === 'bold' ? H - nameH - pad
      : layout === 'posport' ? H - nameH - infoH - pad
      : H - infoH - pad;                                   // compact: price sits beside the name
    let ps = Math.max(10, room / (layout === 'posport' ? 1.0 : 0.95));
    pr.style.fontSize = ps + 'px';
    const tooBig = () => { const b = pr.getBoundingClientRect(); return b.width > W * share || b.height > room; };
    while (ps > 9 && tooBig()) { ps -= 1; pr.style.fontSize = ps + 'px'; }
    while (ps > 9 && over()) { ps -= 1; pr.style.fontSize = ps + 'px'; }
    // still overflowing (very small ticket): shrink the name a bit more
    while (fs > 6 && over()) { fs -= 0.5; nm.style.fontSize = fs + 'pt'; }
  });
}

// ---- tickets for a whole PosPort category ----
const looksLikeId = (c) => /^[0-9a-f]{8}-[0-9a-f]{4}-|^\d+$|^[0-9a-f]{20,}$/i.test(String(c || ''));
function catalogueByCategory() {
  const groups = new Map();
  const list = state.catalogue || [];
  // the PosPort list gives category names; if it only gave ids, use the bot's own guess from the name
  const useGuess = list.filter((c) => c.category).length < list.length / 3 || list.filter((c) => looksLikeId(c.category)).length > list.length / 3;
  list.forEach((c) => {
    if (!c.name) return;
    let cat = useGuess ? R.guessCategory(c.name, '', categories) : c.category;
    cat = String(cat || 'No category').trim() || 'No category';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(c);
  });
  return { groups, guessed: useGuess };
}
function fillTicketCategories() {
  const sel = $('tkCat');
  if (!sel) return;
  const keep = sel.value;
  const { groups, guessed } = catalogueByCategory();
  if (!groups.size) { sel.innerHTML = '<option value="">– read the PosPort list first (↻) –</option>'; $('tkAddCat').disabled = true; return; }
  sel.innerHTML = '<option value="">Pick a category' + (guessed ? ' (guessed from names)' : '') + '…</option>' +
    Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([c, items]) => '<option value="' + esc(c) + '">' + esc(c) + ' (' + items.length + ')</option>').join('');
  if (keep && groups.has(keep)) sel.value = keep;
  $('tkAddCat').disabled = busy || !sel.value;
}
$('tkCat').addEventListener('change', () => { $('tkAddCat').disabled = busy || !$('tkCat').value; });
$('tkAddCat').addEventListener('click', () => {
  const cat = $('tkCat').value;
  const items = (catalogueByCategory().groups.get(cat) || []).filter((c) => c.price > 0);
  if (!items.length) { log('No priced items in ' + cat + '.', 'err'); return; }
  const age = state.catalogueAt ? Math.round((Date.now() - state.catalogueAt) / 3600000) : null;
  addTickets(items.map((c) => ({ full: c.name, name: ticketNameOf(c.name, ''), price: c.price, barcode: c.barcode || '' })));
  log(cat + ': ' + items.length + ' items on the print list, PosPort prices' + (age !== null ? ' from ' + (age < 1 ? 'less than an hour' : age + ' hours') + ' ago' : '') + (age > 12 ? ' – press ↻ first if prices changed' : '') + '.', age > 12 ? 'err' : 'ok');
});
$('tkCatRefresh').addEventListener('click', async () => {
  setBusy(true);
  try { await scanCatalogue(); } finally { setBusy(false); fillTicketCategories(); }
});

function renderTickets() {
  fillTicketCategories();
  const t = $('tkTable');
  const o = tkOpts();
  if (!state.tickets.length) {
    t.innerHTML = '<tbody><tr><td class="muted">No tickets yet – bring items in from the other tabs or paste lines above.</td></tr></tbody>';
  } else {
    t.innerHTML = '<thead><tr><th><input type="checkbox" id="tkAll" checked></th><th>Name on ticket</th><th class="num">Price $</th><th class="num">Was $ <span class="muted">(special)</span></th><th>Size</th><th>Barcode</th><th class="num">Copies</th><th></th></tr></thead><tbody>' +
      state.tickets.map((x, i) => '<tr data-i="' + i + '"><td><input type="checkbox" class="use" ' + (x.use !== false ? 'checked' : '') + '></td>' +
        '<td><input type="text" class="tk-name" value="' + esc(x.name) + '">' + (x.full && x.full !== x.name ? '<span class="sub">PosPort: ' + esc(x.full) + '</span>' : '') + '</td>' +
        '<td class="num"><input type="number" step="0.01" class="price tk-price" value="' + (x.price ? Number(x.price).toFixed(2) : '') + '"></td>' +
        '<td class="num"><input type="number" step="0.01" class="price tk-was" value="' + (x.was ? Number(x.was).toFixed(2) : '') + '"></td>' +
        '<td><input type="text" class="tk-size price" value="' + esc(x.size || '') + '"></td>' +
        '<td><input type="text" class="tk-bc" value="' + esc(x.barcode || '') + '">' + (x.barcode && !B.encode(x.barcode) ? '' : (x.barcode && B.encode(x.barcode).type === 'Code 128' ? '<span class="sub">not a shop barcode – drawn as Code 128</span>' : '')) + '</td>' +
        '<td class="num"><input type="number" min="1" class="tk-qty" value="' + (x.qty || 1) + '"></td>' +
        '<td><button class="btn small tk-del" title="Remove">✕</button></td></tr>').join('') + '</tbody>';
  }
  const list = state.tickets.filter((x) => x.use !== false);
  const copies = list.reduce((a, x) => a + Math.max(1, x.qty || 1), 0);
  $('tkCount').textContent = copies ? copies + ' tickets' + (list.some((x) => !x.price) ? ' · some have no price' : '') : '';
  $('tkPrint').disabled = !copies;
  $('tkPreview').style.gap = o.paper === 'a4' ? Math.max(o.gap, 0.5) + 'mm' : '12px';
  $('tkPreview').innerHTML = list.slice(0, 40).map((x) => ticketHTML(x, o)).join('') || '<span class="muted">Nothing to preview.</span>';
  fitTickets($('tkPreview'));
}

$('tkTable').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const x = state.tickets[+tr.dataset.i];
  const c = e.target.classList;
  if (c.contains('tk-name')) { x.name = e.target.value; x.nameEdited = true; }
  if (c.contains('tk-price')) x.price = R.parseMoney(e.target.value);
  if (c.contains('tk-was')) x.was = R.parseMoney(e.target.value);
  if (c.contains('tk-size')) x.size = e.target.value;
  if (c.contains('tk-bc')) x.barcode = e.target.value.replace(/\s/g, '');
  if (c.contains('tk-qty')) x.qty = Math.max(1, parseInt(e.target.value, 10) || 1);
  saveState();
  clearTimeout(window.__tkT);
  window.__tkT = setTimeout(() => { $('tkPreview').innerHTML = state.tickets.filter((t) => t.use !== false).slice(0, 40).map((t) => ticketHTML(t, tkOpts())).join(''); fitTickets($('tkPreview')); }, 250);
});
$('tkTable').addEventListener('change', (e) => {
  if (e.target.id === 'tkAll') { state.tickets.forEach((x) => { x.use = e.target.checked; }); saveState(); renderTickets(); return; }
  const tr = e.target.closest('tr[data-i]');
  if (tr && e.target.classList.contains('use')) { state.tickets[+tr.dataset.i].use = e.target.checked; saveState(); renderTickets(); }
});
$('tkTable').addEventListener('click', (e) => {
  if (!e.target.classList.contains('tk-del')) return;
  state.tickets.splice(+e.target.closest('tr').dataset.i, 1);
  saveState(); renderTickets();
});
['tkW', 'tkH', 'tkPaper', 'tkShop', 'tkBarcode', 'tkUnit', 'tkDate', 'tkBorder', 'tkWc', 'tkHc', 'tkLayout', 'tkShorten', 'tkGap', 'tkRows'].forEach((id) => {
  $(id).addEventListener('input', () => { loadTkOptsVisibility(); saveTkOpts(); renderTickets(); });
  $(id).addEventListener('change', () => { loadTkOptsVisibility(); saveTkOpts(); renderTickets(); });
});
function loadTkOptsVisibility() {
  $('tkWc').classList.toggle('hidden', $('tkW').value !== 'custom');
  $('tkHc').classList.toggle('hidden', $('tkH').value !== 'custom');
}

$('tkFromAdd').addEventListener('click', () => {
  const posRows = state.add.filter((r) => r.pos);
  const rows = state.add.filter((r) => !r.pos && r.use !== false && r.name && r.price && ['created', 'filled', 'ready', 'check'].includes(r.status));
  if (!rows.length && !posRows.length) { log('No items with a name and price yet.', 'err'); return; }
  if (posRows.length) addTickets(posRows.map((r) => ({ full: r.pos.name, name: r.tname || ticketNameOf(r.pos.name, ''), price: r.pos.price, barcode: r.barcode })), !rows.length ? false : true);
  if (rows.length) addTickets(rows.map((r) => {
    const src = (r.ww && r.ww.found && r.ww) || (r.coles && r.coles.found && r.coles) || r.net || {};
    return { full: r.name, name: r.tname || ticketNameOf(r.name, ''), price: r.price, barcode: r.barcode, size: sizeFromName(r.name) || src.size || '' };
  }));
});
$('tkFromCheck').addEventListener('click', () => {
  const rows = state.check.filter((r) => r.posName && (r.applied === true || r.newPrice || r.ours));
  if (!rows.length) { log('Run a price check first.', 'err'); return; }
  const changed = rows.filter((r) => r.applied === true || (r.apply && r.newPrice));
  const use = changed.length ? changed : rows;
  addTickets(use.map((r) => ({ name: r.posName, price: r.applied === true ? r.ours : (r.newPrice || r.ours), barcode: r.barcode })));
  if (changed.length) log('Added the ' + changed.length + ' items whose price changed.', 'ok');
});
$('tkFromLabels').addEventListener('click', () => {
  const lines = $('lblNames').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) { log('The Labels list is empty.', 'err'); return; }
  const done = (state.labels || []).filter((r) => r.status === 'ticked');
  const items = lines.map((line) => {
    const hit = done.find((r) => r.line === line);
    const name = hit ? hit.posName : line;
    const cat = state.catalogue.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) ||
      (state.catalogue.length ? (() => { const mm = R.posMatch(name, state.catalogue, (c) => c.name); return mm.sure ? mm.item : null; })() : null);
    const isBc = /^\d{7,14}$/.test(line);
    return { name: cat ? cat.name : (isBc ? '' : name), price: cat ? cat.price : null, barcode: isBc ? line : (cat && cat.barcode) || '' };
  });
  const missing = items.filter((x) => !x.name).length;
  addTickets(items.filter((x) => x.name));
  if (missing) log(missing + ' barcodes have no known name yet – run them on the Labels tab first.', 'err');
  if (items.some((x) => x.name && !x.price)) log('Some tickets have no price – run "Scan PosPort items" on Price check, or type the price.', 'err');
});
// Read any Excel the bot saved (price check, price updates, new items, failed items) or your own sheet.
// Name: PosPort item / Name in PosPort / Label name / Item name / Name / Product
// Price: New price (when filled) -> Our price -> Price.  Barcode, Was/Special price and Copies if present.
function ticketsFromSheet(rows) {
  if (!rows.length) return { items: [], changed: 0 };
  const head = rows[0].map((h) => String(h || '').toLowerCase().trim());
  const find = (...res) => { for (const re of res) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
  const cName = find(/^posport item$/, /name in posport/, /^ticket name$/, /^label name/, /^item name$/, /^name$/, /product name/, /^product$/, /^what you entered$/, /^item$/, /name|description/);
  const cTicket = find(/^ticket name$/);
  const cNew = find(/^new price/);
  const cOur = find(/^our price/, /current price/, /^price/, /sell/);
  const cBc = find(/^barcode$/, /barcode|ean|upc|gtin/);
  const cWas = find(/^was/, /special/);
  const cQty = find(/^copies$/, /^qty$/, /quantity/);
  const cUpd = find(/^updated$/, /^result$/, /^update result$/);
  if (cName < 0) return { error: 'No name column found (expected "PosPort item", "Name" or "Label name").' };
  let changed = 0;
  const items = rows.slice(1).map((r) => {
    const full = String(r[cName] || '').trim();
    if (!full || /^\d{7,14}$/.test(full) && cBc < 0) return null;
    const newP = cNew >= 0 ? R.parseMoney(r[cNew]) : null;
    const upd = cUpd >= 0 ? String(r[cUpd] || '').toLowerCase() : '';
    if (newP && !/fail/.test(upd)) changed++;
    const price = (newP && !/fail/.test(upd)) ? newP : (cOur >= 0 ? R.parseMoney(r[cOur]) : null);
    const ticket = cTicket >= 0 && cTicket !== cName ? String(r[cTicket] || '').trim() : '';
    return {
      full, name: ticket || undefined, price, newPrice: newP,
      barcode: cBc >= 0 ? R.cleanBarcode(r[cBc]) : '',
      was: cWas >= 0 ? R.parseMoney(r[cWas]) : null,
      qty: cQty >= 0 ? Math.max(1, parseInt(r[cQty], 10) || 1) : 1,
    };
  }).filter(Boolean);
  return { items, changed, hasNew: cNew >= 0 };
}

$('tkFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) await loadTicketFile(f);
});
scanBox('tkScan', (code) => {
  if (busy) { log('Busy – scan again in a moment.', 'err'); return; }
  $('tkPaste').value = code;
  $('tkAddLines').click();
});
async function loadTicketFile(f) {
  const res = ticketsFromSheet(await readSheet(f));
  if (res.error) { log(f.name + ': ' + res.error, 'err'); return; }
  let items = res.items;
  if (res.hasNew && res.changed && res.changed < items.length &&
      confirm(f.name + ' has ' + res.changed + ' items with a new price (out of ' + items.length + ').\n\nOK = only those ' + res.changed + '\nCancel = all ' + items.length + ' items')) {
    items = items.filter((x) => x.newPrice);
  }
  const before = state.tickets.length;
  items.forEach((x) => {
    const name = x.name || ($('tkShorten').checked ? ticketNameOf(x.full, '') : x.full);
    addTickets([{ full: x.full, name, price: x.price, barcode: x.barcode, was: x.was }], true);
    const t = state.tickets.find((tk) => (tk.full || tk.name).toLowerCase() === x.full.toLowerCase());
    if (t) { t.qty = x.qty; if (x.was) t.was = x.was; }
  });
  saveState(); renderTickets();
  const noPrice = items.filter((x) => !x.price).length;
  log('Loaded ' + items.length + ' items from ' + f.name + ' (' + (state.tickets.length - before) + ' new tickets)' + (noPrice ? ' – ' + noPrice + ' have no price, type it in the table.' : '.'), noPrice ? 'err' : 'ok');
}

// A pasted line can be "Name | Price | Barcode", or only a barcode: then the bot finds the item
// in PosPort (barcode → product name → matching PosPort item and its price).
async function ticketFromBarcode(bc) {
  const byBc = state.catalogue.find((c) => c.barcode && R.sameBarcode(c.barcode, bc));
  if (byBc) return { full: byBc.name, price: byBc.price, barcode: bc };
  const fromAdd = state.add.find((r) => r.barcode && R.sameBarcode(r.barcode, bc) && (r.pos || r.status === 'created'));
  if (fromAdd) return { full: fromAdd.pos ? fromAdd.pos.name : fromAdd.name, price: fromAdd.pos ? fromAdd.pos.price : fromAdd.price, barcode: bc };
  const id = await identifyBarcode(bc);
  if (!id) {
    const iv = invoiceFor(bc);
    if (iv) return { full: iv.name || INV.tidyName(iv.desc), price: iv.rrp || null, barcode: bc, note: 'name from invoice ' + (iv.number || '') + (iv.rrp ? ', price = supplier RRP' : ' – type the price') };
    return { error: 'not found anywhere' };
  }
  if (state.catalogue.length) {
    const mm = R.posMatch(id.name, state.catalogue, (c) => c.name);
    if (mm.item && mm.sure) return { full: mm.item.name, price: mm.item.price, barcode: bc };
  }
  return { full: R.shortName(id.name, '', S.nameMaxLength), price: null, barcode: bc, note: 'not found in PosPort – type the price' };
}

$('tkAddLines').addEventListener('click', async () => {
  const lines = $('tkPaste').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [], codes = [];
  lines.forEach((l) => {
    const flat = l.replace(/\s/g, '');
    if (/^\d{7,14}$/.test(flat)) { codes.push(flat); return; }
    const parts = l.split(/\s*[|\t;]\s*/);
    const name = parts[0];
    const price = parts.slice(1).map(R.parseMoney).find((x) => x !== null && x < 1000);
    const barcode = (parts.slice(1).find((x) => /^\d{7,14}$/.test(x.replace(/\s/g, ''))) || '').replace(/\s/g, '');
    items.push({ name, price, barcode });
  });
  if (items.length) addTickets(items);
  $('tkPaste').value = '';
  if (!codes.length) return;
  setBusy(true);
  try {
    if (!state.catalogue.length) await ensureCatalogue();
    const got = [];
    for (const bc of codes) {
      if (stopRequested) break;
      const t = await ticketFromBarcode(bc);
      if (t.error) { log(bc + ': ' + t.error, 'err'); continue; }
      log(bc + ' → ' + t.full + (t.price ? ' ' + m(t.price) : '') + (t.note ? ' (' + t.note + ')' : ''), t.note ? 'err' : 'ok');
      got.push({ full: t.full, name: $('tkShorten').checked ? ticketNameOf(t.full, '') : t.full, price: t.price, barcode: t.barcode });
    }
    addTickets(got);
  } finally { setBusy(false); }
});

$('tkReshort').addEventListener('click', () => {
  state.tickets.forEach((x) => { if (!x.nameEdited) x.name = $('tkShorten').checked ? ticketNameOf(x.full || x.name, '') : (x.full || x.name); });
  saveState(); renderTickets();
});
$('tkToLabels').addEventListener('click', () => {
  const list = state.tickets.filter((x) => x.use !== false).map((x) => x.full || x.name);
  if (!list.length) { log('The ticket list is empty.', 'err'); return; }
  $('lblNames').value = list.join('\n');
  $('lblBox').open = true;
  $('lblNames').scrollIntoView({ block: 'center' });
});
$('tkClear').addEventListener('click', () => {
  if (state.tickets.length && !confirm('Remove all ' + state.tickets.length + ' tickets from the list?')) return;
  state.tickets = []; saveState(); renderTickets();
});

$('tkPrint').addEventListener('click', () => {
  const o = tkOpts();
  const list = [];
  state.tickets.filter((x) => x.use !== false).forEach((x) => { for (let i = 0; i < Math.max(1, x.qty || 1); i++) list.push(x); });
  if (list.some((x) => !x.price) && !confirm('Some tickets have no price and will show "$–". Print anyway?')) return;
  const area = $('printArea');
  area.className = o.paper;
  if (o.paper === 'roll') {
    area.innerHTML = list.map((x) => ticketHTML(x, o)).join('');
    $('pageStyle').textContent = '@page { size: ' + o.w + 'in ' + o.h + 'in; margin: 0; }';
  } else {
    // A4: our own pages with 8 mm margins, so the browser adds no date/URL headers
    // Printers can't print right to the paper edge, and some are set to Letter (shorter than A4),
    // so keep 10 mm top/bottom margins plus a safety strip at the bottom, and a gap for cutting.
    const gap = o.gap, side = 7, top = 10, safe = 12;
    const cols = Math.max(1, Math.floor((210 - 2 * side + gap) / (o.w * 25.4 + gap)));
    let rows = Math.max(1, Math.floor((297 - 2 * top - safe + gap) / (o.h * 25.4 + gap)));
    if (o.rows > 0) rows = o.rows;
    const per = cols * rows, pages = [];
    for (let i = 0; i < list.length; i += per) pages.push(list.slice(i, i + per));
    area.innerHTML = pages.map((pg) => '<div class="a4page" style="padding:' + top + 'mm ' + side + 'mm;gap:' + gap + 'mm;grid-template-columns:repeat(' + cols + ',' + o.w + 'in);grid-auto-rows:' + o.h + 'in">' +
      pg.map((x) => ticketHTML(x, o)).join('') + '</div>').join('');
    $('pageStyle').textContent = '@page { size: A4; margin: 0; }';
    log(cols + ' × ' + rows + ' = ' + per + ' tickets per A4 page, ' + pages.length + ' page(s).');
  }
  area.style.display = 'block';
  area.style.position = 'absolute'; area.style.left = '-10000px';
  fitTickets(area);
  area.style.display = ''; area.style.position = ''; area.style.left = '';
  window.print();
  log('Sent ' + list.length + ' tickets to the printer.', 'ok');
});


// =====================================================================
// 3. BUYING & INVOICES – is the supplier price good, or is it cheaper at Woolworths/Coles today?
// =====================================================================
state.buy = state.buy || [];
const nowPrice = (x) => (x && x.found ? (x.now || x.regular) : null);

function buyVerdict(r) {
  const tol = (parseFloat($('buyTol').value) || 0) / 100;
  const ww = nowPrice(r.ww), co = nowPrice(r.coles);
  const best = [ww ? { store: 'Woolworths', p: ww } : null, co ? { store: 'Coles', p: co } : null].filter(Boolean).sort((a, b) => a.p - b.p)[0] || null;
  r.best = best;
  r.special = !!((r.ww && r.ww.found && r.ww.onSpecial && r.ww.now < r.ww.regular) || (r.coles && r.coles.found && r.coles.onSpecial && r.coles.now < r.coles.regular));
  const unit = r.cost || (r.costOuter && r.units ? r.costOuter / r.units : null);
  r.unitCost = unit ? R.round2(unit) : null;
  if (r.notDelivered) { r.verdict = 'short'; r.vclass = 'warn'; r.vtext = 'Not delivered: ' + r.notDelivered + ' – check you were not charged'; return; }
  if (!best) { r.verdict = 'no data'; r.vclass = 'warn'; r.vtext = 'No Woolworths/Coles price' + (r.rrp ? ' (supplier RRP ' + m(r.rrp) + ')' : ''); return; }
  if (!unit) { r.verdict = 'list'; r.vclass = r.special ? 'ok' : ''; r.vtext = 'Cheapest: ' + best.store + ' ' + m(best.p) + (r.special ? ' (special)' : ''); return; }
  const diff = unit - best.p;
  if (diff > best.p * tol) { r.verdict = 'worse'; r.vclass = 'bad'; r.vtext = 'Cheaper at ' + best.store + ' by ' + m(diff) + ' each – return / buy there'; }
  else if (diff >= -best.p * tol) { r.verdict = 'same'; r.vclass = 'warn'; r.vtext = 'About the same as ' + best.store; }
  else { r.verdict = 'good'; r.vclass = 'ok'; r.vtext = Math.round(-diff / best.p * 100) + '% below ' + best.store; }
}

function renderBuy() {
  const f = state.buyFilter || 'all';
  const show = (r) => f === 'all' || (f === 'worse' && r.verdict === 'worse') || (f === 'special' && r.special) || (f === 'good' && r.verdict === 'good') || (f === 'short' && r.verdict === 'short');
  $('bAll').textContent = state.buy.length;
  $('bWorse').textContent = state.buy.filter((r) => r.verdict === 'worse').length;
  $('bSpecial').textContent = state.buy.filter((r) => r.special).length;
  $('bGood').textContent = state.buy.filter((r) => r.verdict === 'good').length;
  $('bShort').textContent = state.buy.filter((r) => r.verdict === 'short').length;
  document.querySelectorAll('#buyFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
  $('buyTable').innerHTML = !state.buy.length ? '<tbody><tr><td class="muted">Load a shopping list or an invoice.</td></tr></tbody>' :
    '<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Paid / unit</th><th>Woolworths</th><th>Coles</th><th class="num">Cheapest now</th><th>Verdict</th><th class="num">PosPort sell</th><th class="num">Margin</th></tr></thead><tbody>' +
    state.buy.map((r, i) => ({ r, i })).filter(({ r }) => show(r)).map(({ r, i }) => {
      const margin = r.sell && r.unitCost ? Math.round((r.sell - r.unitCost) / r.sell * 100) + '%' : '';
      return '<tr data-i="' + i + '"><td><b>' + esc(r.name || (r.ww && r.ww.found && r.ww.name) || '') + '</b><span class="sub">' + esc(r.barcode || '') + (r.barcodeFrom ? ' (barcode from ' + esc(r.barcodeFrom) + ')' : '') + (r.file ? ' · ' + esc(r.file) : '') + '</span></td>' +
        '<td class="num">' + esc(r.qty || '') + '</td>' +
        '<td class="num"><input type="number" step="0.01" class="price buycost" value="' + (r.unitCost ? r.unitCost.toFixed(2) : '') + '" placeholder="–"></td>' +
        '<td>' + storeCell(r.ww) + '</td><td>' + storeCell(r.coles) + '</td>' +
        '<td class="num">' + (r.best ? m(r.best.p) + '<span class="sub">' + r.best.store + '</span>' : '') + '</td>' +
        '<td><span class="verdict ' + (r.vclass || '') + '">' + esc(r.vtext || (r.ww ? '' : 'not checked yet')) + '</span>' + (r.special ? '<span class="sub special">on special now</span>' : '') + '</td>' +
        '<td class="num">' + (r.sell ? m(r.sell) + '<span class="sub">' + esc(r.posName || '') + '</span>' +
            (r.posChk && r.posChk.flagged ? '<span class="sub verdict ' + (r.posChk.status === 'TOO LOW' ? 'bad' : 'warn') + '">' + r.posChk.status + ' → ' + m(r.posChk.suggested) + '</span>' : '')
          : r.inPos === false ? '<span class="verdict warn">Not in PosPort</span>' + (r.suggested ? '<span class="sub">sell at ' + m(r.suggested) + '</span>' : '') : '') + '</td>' +
        '<td class="num">' + margin + '</td></tr>';
    }).join('') + '</tbody>';
  // totals
  const both = state.buy.filter((r) => r.unitCost && r.best);
  const qty = (r) => Math.max(1, parseFloat(r.qty) || 1);
  const paid = both.reduce((a, r) => a + r.unitCost * qty(r), 0);
  const retail = both.reduce((a, r) => a + r.best.p * qty(r), 0);
  const over = state.buy.filter((r) => r.verdict === 'worse').reduce((a, r) => a + (r.unitCost - r.best.p) * qty(r), 0);
  $('buyTotals').innerHTML = both.length
    ? 'Paid <b>' + m(paid) + '</b> for ' + both.length + ' items · same items at today\'s cheapest supermarket price: <b>' + m(retail) + '</b><br>' +
      (over > 0 ? '<span class="verdict bad">' + m(over) + ' more than buying those at Woolworths/Coles today</span>' : '<span class="verdict ok">Nothing was cheaper at the supermarkets.</span>')
    : state.buy.length ? state.buy.filter((r) => r.best).length + ' of ' + state.buy.length + ' priced. Add "Paid per unit" to compare an invoice.' : '–';
  $('buyLookup').disabled = busy || !state.buy.length;
  $('buyExport').disabled = !state.buy.some((r) => r.ww);
  $('buyReturns').disabled = !state.buy.some((r) => r.verdict === 'worse');
  const toSend = buyToSend();
  $('buySend').disabled = busy || !toSend.length;
  $('buySend').textContent = 'Send to Items & prices' + (toSend.length ? ' (' + toSend.filter((r) => r.inPos === false).length + ' new · ' + toSend.filter((r) => r.posChk && r.posChk.flagged).length + ' to fix)' : '');
}
// items worth sending: not in PosPort yet, or a PosPort price that is flagged
function buyToSend() {
  return state.buy.filter((r) => !r.notDelivered && (r.barcode || r.name) && (r.inPos === false || (r.posChk && r.posChk.flagged)));
}

$('buyFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) { state.buyFilter = b.dataset.f; renderBuy(); } });
$('buyTol').addEventListener('input', () => { state.buy.forEach(buyVerdict); renderBuy(); });
$('buyTable').addEventListener('change', (e) => {
  if (!e.target.classList.contains('buycost')) return;
  const r = state.buy[+e.target.closest('tr').dataset.i];
  r.cost = R.parseMoney(e.target.value); r.costOuter = null;
  buyVerdict(r); renderBuy(); saveState();
});
$('buyClear').addEventListener('click', () => { state.buy = []; renderBuy(); saveState(); });
// Send to Items & prices: one file row per invoice, with names, shop prices and invoice cost already filled in
$('buySend').addEventListener('click', () => {
  const list = buyToSend();
  if (!list.length) return;
  ensureFiles();
  const groups = new Map();
  list.forEach((r) => { const k = r.file || 'Buying list'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const seen = new Set(state.add.filter((x) => x.status !== 'created').map((x) => x.barcode).filter(Boolean));
  let n = 0;
  groups.forEach((rows, label) => {
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const items = [];
    rows.forEach((b) => {
      if (b.barcode && seen.has(b.barcode)) return;
      if (b.barcode) seen.add(b.barcode);
      const r = { barcode: b.barcode || '', inName: '', hint: b.name || b.supplierDesc || '', name: '', tname: '', category: '', price: null,
        status: 'waiting', use: true, fileId: id, note: '' };
      setNames(r, b.name || INV.tidyName(b.supplierDesc || ''), '');
      items.push(r);
    });
    if (!items.length) return;
    state.files.forEach((f) => { f.open = false; });
    state.files.push({ id, name: 'From ' + label, open: true });
    state.add.push(...items); n += items.length;
  });
  saveState(); renderAdd();
  document.querySelector('[data-tab=add]').click();
  log(n ? n + ' items sent to Items & prices – check them, then "Create" the new ones and "Save" the price fixes.' : 'Those items are already in Items & prices.', n ? 'ok' : '');
  if (n) startLookup();
});
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('inv-del')) return;
  state.invoices = (state.invoices || []).filter((x) => x.id !== e.target.dataset.id);
  invIndex = null; saveState(); renderInvoices();
});

$('buyFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) {
    if (/\.pdf$/i.test(f.name)) {
      let inv;
      try { inv = await readInvoicePdf(f); } catch (err) { log(err.message, 'err'); continue; }
      const label = 'invoice ' + (inv.number || f.name);
      inv.items.forEach((it, k) => state.buy.push({
        barcode: it.barcode, name: it.name || INV.tidyName(it.desc), supplierDesc: it.desc, qty: it.unitsReceived || '', cost: it.unitCost, file: label,
        invRef: { id: inv.id, k }, supplier: inv.supplier,
        notDelivered: it.shipped === 0 ? (it.status || 'not delivered') + (it.unitsShort ? ' – ' + it.unitsShort + ' units short' : '') : '',
        rrp: it.rrp, promo: it.promo,
      }));
      log('Loaded ' + inv.items.length + ' lines from ' + label);
      continue;
    }
    const mapped = await mapColumns(f.name, await readSheet(f), ['barcode', 'name', 'qty', 'cost', 'costOuter', 'units'],
      'Invoice: pick the barcode (or name), quantity and what you paid. Shopping list: barcode or name is enough.');
    if (!mapped) continue;
    let n = 0;
    mapped.forEach((x) => {
      const barcode = R.cleanBarcode(x.barcode), name = String(x.name || '').trim();
      if (!barcode && !name) return;
      state.buy.push({ barcode, name, qty: R.parseMoney(x.qty) || '', cost: R.parseMoney(x.cost), costOuter: R.parseMoney(x.costOuter), units: R.parseMoney(x.units), file: f.name });
      n++;
    });
    log('Loaded ' + n + ' lines from ' + f.name);
  }
  $('buyInfo').textContent = state.buy.length + ' lines';
  renderBuy(); saveState();
  // one step: compare with Woolworths + Coles, check PosPort, work out margins – no more questions
  if (state.buy.some((r) => !r.ww)) $('buyLookup').click();
});
scanBox('buyScan', (code) => {
  state.buy.unshift({ barcode: code, name: '', qty: 1, file: 'scanned' });
  renderBuy(); saveState();
  if (!busy) $('buyLookup').click();
});

function buyPosCheck(r) {
  const c = (r.barcode && state.catalogue.find((x) => x.barcode && R.sameBarcode(x.barcode, r.barcode))) ||
    (r.name && state.catalogue.length ? (() => { const mm = R.posMatch(r.name, state.catalogue, (x) => x.name); return mm.sure ? mm.item : null; })() : null) ||
    (r.ww && r.ww.found && r.ww.name && state.catalogue.length ? (() => { const mm = R.posMatch(r.ww.name, state.catalogue, (x) => x.name); return mm.sure ? mm.item : null; })() : null);
  r.sell = c ? c.price : null; r.posName = c ? c.name : '';
  r.inPos = state.catalogue.length ? !!c : null;              // null = PosPort list not read
  const highest = R.highestPrice(r.ww && r.ww.found ? r.ww.regular : null, r.coles && r.coles.found ? r.coles.regular : null);
  r.highest = highest;
  r.suggested = highest ? R.newItemPrice(highest, S) : (r.unitCost ? R.round2(r.unitCost * (1 + (S.fallbackMargin || 40) / 100)) : null);
  r.posChk = c && highest ? R.checkExistingPrice(c.price, highest, S) : null;
}
$('buyLookup').addEventListener('click', async () => {
  setBusy(true);
  try {
    if (await ensureCatalogue()) log('Checking against ' + state.catalogue.length + ' PosPort items.');
    const next = () => { if (stopRequested) return null; const r = state.buy.find((x) => !x.ww && !x.tried); if (r) r.tried = true; return r; };
    await runPool(S.parallel || 3, next, async (r) => {
      log('Comparing ' + (r.name || r.barcode));
      const res = await lookupPrices(r.barcode, r.name);
      r.ww = res.ww; r.coles = res.coles;
      const src = (res.ww && res.ww.found && res.ww) || (res.coles && res.coles.found && res.coles);
      if (!r.name && src) r.name = src.name;
      // shop invoices have no barcodes: take it from the matching shop product, and teach the saved invoice
      if (!r.barcode && src && src.barcode && strongMatch(src)) {
        r.barcode = R.cleanBarcode(src.barcode); r.barcodeFrom = src.store;
        const inv = r.invRef && (state.invoices || []).find((x) => x.id === r.invRef.id);
        if (inv && inv.items[r.invRef.k] && !inv.items[r.invRef.k].barcode) { inv.items[r.invRef.k].barcode = r.barcode; invIndex = null; }
      }
      buyVerdict(r); buyPosCheck(r); renderBuy(); saveState();
    });
    state.buy.forEach((r) => { delete r.tried; if (r.ww) buyPosCheck(r); });
    const notIn = state.buy.filter((r) => r.inPos === false && !r.notDelivered).length;
    const flagged = state.buy.filter((r) => r.posChk && r.posChk.flagged).length;
    log('Comparison finished.' + (state.catalogue.length ? ' ' + notIn + ' not in PosPort yet, ' + flagged + ' PosPort prices to fix – press "Send to Items & prices" to create / fix them.' : ''), 'ok');
  } finally { setBusy(false); renderBuy(); }
});

function buyRows(list) {
  return list.map((r) => Object.assign({
    Item: r.name || '', Barcode: r.barcode || '', Qty: r.qty || '', 'Paid per unit $': r.unitCost || '',
    'Cheapest now $': r.best ? r.best.p : '', 'Cheapest at': r.best ? r.best.store : '',
    'Difference per unit $': r.unitCost && r.best ? R.round2(r.unitCost - r.best.p) : '',
    'Difference total $': r.unitCost && r.best ? R.round2((r.unitCost - r.best.p) * Math.max(1, parseFloat(r.qty) || 1)) : '',
    Verdict: r.vtext || '', 'On special': r.special ? 'yes' : '',
    'PosPort sell $': r.sell || '', 'Margin %': r.sell && r.unitCost ? Math.round((r.sell - r.unitCost) / r.sell * 100) : '',
    File: r.file || '',
  }, storeCols('Woolworths', r.ww), storeCols('Coles', r.coles)));
}
$('buyExport').addEventListener('click', () => writeSheet(buyRows(state.buy), 'buying-compare-' + today() + '.xlsx', 'Compare'));
$('buyReturns').addEventListener('click', () => writeSheet(buyRows(state.buy.filter((r) => r.verdict === 'worse')), 'return-or-buy-elsewhere-' + today() + '.xlsx', 'Cheaper elsewhere'));

// =====================================================================
// BACKUP – everything the Back Office shows, for safe keeping or moving to another system
// =====================================================================
function bkLog(msg, cls) { const li = document.createElement('li'); li.textContent = new Date().toLocaleTimeString() + '  ' + msg; if (cls) li.className = cls; $('bkLog').prepend(li); }

async function execMain(tabId, func) {
  try { const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func }); return r ? r.result : null; } catch (e) { return null; }
}

// turn nested JSON into flat rows: {a:{b:1}} -> {"a.b":1}
function flatten(o, prefix, out) {
  out = out || {};
  Object.keys(o || {}).forEach((k) => {
    const v = o[k], key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== 'object') ? v.join(' | ') : JSON.stringify(v).slice(0, 32000);
    else out[key] = v;
  });
  return out;
}
function recordArrays(data) {
  const found = [];
  const walk = (n, path, depth) => {
    if (!n || depth > 5) return;
    if (Array.isArray(n)) { if (n.length && n.every((x) => x && typeof x === 'object' && !Array.isArray(x))) found.push({ path, rows: n }); return; }
    if (typeof n === 'object') Object.keys(n).forEach((k) => walk(n[k], path ? path + '.' + k : k, depth + 1));
  };
  walk(data, '', 0);
  if (!found.length && data && typeof data === 'object' && !Array.isArray(data)) found.push({ path: '', rows: [data] });
  return found;
}

async function runBackup(onlyItems) {
  setBusy(true);
  $('bkLog').innerHTML = '';
  const pages = [], api = {};
  try {
    if (!(await posGo('/catalog/items', 'items'))) { bkLog('Could not open the Back Office – are you logged in?', 'err'); return; }
    const tabId = await posTab();
    let links = [{ path: '/catalog/items', text: 'Items' }];
    if (!onlyItems) {
      const ml = await pos('menuLinks');
      const extra = ['/catalog/categories', '/catalog/modifiers', '/catalog/variants', '/catalog/units'];
      const all = ((ml && ml.links) || []).concat(extra.map((p) => ({ path: p, text: p.split('/').pop() })));
      const seen = new Set();
      links = all.filter((l) => { if (seen.has(l.path)) return false; seen.add(l.path); return true; }).slice(0, 60);
      if (!links.some((l) => l.path === '/catalog/items')) links.unshift({ path: '/catalog/items', text: 'Items' });
    }
    bkLog(links.length + ' sections to read.');
    for (const l of links) {
      if (stopRequested) break;
      await chrome.tabs.update(tabId, { url: POS + l.path });
      await sleep(500); await waitComplete(tabId); await sleep(2500);
      const info = await pos('pageInfo');
      if (info && info.page === 'login') { bkLog('Logged out – log in again and restart the backup.', 'err'); break; }
      const rows = []; let headers = [];
      for (let pg = 1; pg <= 300; pg++) {
        const t = await pos('readTable');
        (t && t.tables || []).forEach((tb) => { if (tb.headers.length > headers.length) headers = tb.headers; rows.push(...tb.rows); });
        const nx = await pos('nextPage', S.delayMs);
        if (!nx || !nx.ok) break;
      }
      const raw = await execMain(tabId, () => (window.__csbRaw ? Object.values(window.__csbRaw.items) : []));
      (raw || []).forEach((x) => { api[x.url] = x.data; });
      pages.push({ section: l.text || l.path, path: l.path, headers, rows });
      bkLog((l.text || l.path) + ': ' + rows.length + ' table rows, ' + (raw || []).length + ' data answers');
    }
    // ---- Excel: one sheet per section, one per data list ----
    const wb = XLSX.utils.book_new();
    const names = new Set();
    const sheetName = (n) => {
      let b = String(n || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
      let k = b, i = 2; while (names.has(k.toLowerCase())) k = b.slice(0, 26) + ' ' + i++;
      names.add(k.toLowerCase()); return k;
    };
    const summary = [];
    pages.forEach((p) => {
      if (!p.rows.length) return;
      const aoa = [p.headers.length ? p.headers : p.rows[0].map((_, i) => 'Column ' + (i + 1))].concat(p.rows.map((r) => r.map((c) => String(c).slice(0, 32000))));
      const nm = sheetName(p.section);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nm);
      summary.push({ Sheet: nm, From: 'page ' + p.path, Rows: p.rows.length });
    });
    Object.keys(api).forEach((url) => {
      recordArrays(api[url]).forEach((arr) => {
        if (arr.rows.length < 1) return;
        const flat = arr.rows.map((r) => { const f = flatten(r); Object.keys(f).forEach((k) => { if (typeof f[k] === 'string') f[k] = f[k].slice(0, 32000); }); return f; });
        const nm = sheetName('data ' + url.split('?')[0].split('/').filter(Boolean).slice(-2).join(' ') + (arr.path ? ' ' + arr.path.split('.').pop() : ''));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), nm);
        summary.push({ Sheet: nm, From: 'data ' + url + (arr.path ? ' → ' + arr.path : ''), Rows: flat.length });
      });
    });
    const ws = XLSX.utils.json_to_sheet(summary.length ? summary : [{ Sheet: '-', From: 'nothing found', Rows: 0 }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Contents');
    wb.SheetNames.unshift(wb.SheetNames.pop());           // Contents first
    const d0 = new Date(), pad = (x) => String(x).padStart(2, '0');
    const stamp = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate()) + '-' + pad(d0.getHours()) + pad(d0.getMinutes());
    XLSX.writeFile(wb, 'posport-backup-' + stamp + '.xlsx');
    // ---- JSON: everything, for importing into another system ----
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), source: POS, pages, data: api }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'posport-backup-' + stamp + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    bkLog('Backup saved: ' + summary.length + ' sheets in the Excel file + the full JSON file (check your Downloads).', 'ok');
  } finally { setBusy(false); }
}
$('bkRun').addEventListener('click', () => { if (confirm('Read every Back Office section and save a backup? This takes a few minutes – leave the PosPort tab alone while it runs.')) runBackup(false); });
$('bkItems').addEventListener('click', () => runBackup(true));

// =====================================================================
// SETTINGS
// =====================================================================
const NUM_KEYS = ['markup', 'markupPct', 'storeGapMs', 'flagLow', 'flagHigh', 'nameMaxLength', 'ticketNameMax', 'delayMs', 'batchSize', 'parallel', 'fallbackMargin', 'minMargin'];
function fillSettings() {
  NUM_KEYS.forEach((k) => { $('s_' + k).value = S[k]; });
  $('s_extraBlankRow').checked = !!S.extraBlankRow;
  $('s_autoCreate').checked = !!S.autoCreate;
  $('s_shortInPosPort').checked = !!S.shortInPosPort;
  $('s_autoTickets').checked = S.autoTickets !== false;
  $('s_autoExportFailed').checked = S.autoExportFailed !== false;
  $('s_selectors').value = S.selectors && Object.keys(S.selectors).length ? JSON.stringify(S.selectors, null, 2) : '';
  $('s_abbrevs').value = S.abbrevs || '';
  $('addMarkup').value = Number(S.markup).toFixed(2);
  $('addMarkupPct').value = S.markupPct || 0;
  $('addBasis').value = S.priceBasis || 'shops';
  $('addInvMargin').value = S.fallbackMargin || 40;
  R.setAbbreviations(S.abbrevs || '');
  document.querySelectorAll('.lowLbl').forEach((x) => { x.textContent = m(S.flagLow); });
  document.querySelectorAll('.highLbl').forEach((x) => { x.textContent = m(S.flagHigh); });
}
$('sSave').addEventListener('click', async () => {
  NUM_KEYS.forEach((k) => { const v = parseFloat($('s_' + k).value); if (isFinite(v)) S[k] = v; });
  S.extraBlankRow = $('s_extraBlankRow').checked;
  S.parallel = Math.max(1, Math.min(6, Math.round(S.parallel || 3)));
  S.autoCreate = $('s_autoCreate').checked;
  S.shortInPosPort = $('s_shortInPosPort').checked;
  S.autoTickets = $('s_autoTickets').checked;
  S.autoExportFailed = $('s_autoExportFailed').checked;
  S.abbrevs = $('s_abbrevs').value;
  const raw = $('s_selectors').value.trim();
  try { S.selectors = raw ? JSON.parse(raw) : {}; } catch (e) { $('sInfo').textContent = 'Patterns are not valid JSON.'; return; }
  await chrome.storage.local.set({ settings: S });
  fillSettings();
  $('sInfo').textContent = 'Saved.';
  renderAdd(); renderCheck();
});
$('sTest').addEventListener('click', async () => {
  setBusy(true);
  try {
    const info = await pos('pageInfo');
    let extra = '';
    if (info && info.page === 'bulk') { const b = await pos('bulkStatus'); extra = b.rows + ' rows, ' + b.missingPrice + ' without a price box, Add Row button ' + (b.addRowFound ? 'found' : 'NOT found') + ', create button: ' + b.createLabel + ', boxes: ' + (b.placeholders || []).join(' / '); }
    else if (info && info.page === 'items') { const l = await pos('readListRows'); extra = (l.rows || []).length + ' rows read, first: ' + ((l.rows || [])[0] ? l.rows[0].name + ' ' + m(l.rows[0].price) : '—'); }
    else if (info && info.page === 'item') { const p = await pos('readEditPrice'); extra = p.ok ? 'price box shows ' + m(p.price) : p.error; }
    const cap = await pos('captured');
    $('sInfo').textContent = (info ? 'PosPort page: ' + info.page + '. ' + extra : 'PosPort tab not reachable') + ' · items captured from network: ' + ((cap && cap.items) || []).length;
  } finally { setBusy(false); }
});

// =====================================================================
// UI plumbing
// =====================================================================
function showTab(name) {
  if (name === 'labels') { name = 'tickets'; $('lblBox').open = true; }
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  if (name === 'tickets') renderTickets();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function refreshButtons() {
  if (busy) return;
  $('addLookup').disabled = !state.add.length;
  $('addUpdate').disabled = !state.add.some((r) => r.pos && r.apply && (r.newPrice > 0 || (r.newName && r.newName !== r.pos.name)));
  $('addTickFlagged').disabled = !state.add.some((r) => r.pos && r.chk && r.chk.flagged && r.newPrice && r.updated !== true);
  $('addCreate').disabled = !state.add.some((r) => r.status === 'ready' || r.status === 'check');
  $('addRetry').disabled = !state.add.some((r) => r.status === 'error' || r.status === 'filled');
  $('addExport').disabled = !state.add.some((r) => r.status !== 'waiting');
  $('addToTickets').disabled = !state.add.some((r) => (r.name && r.price) || r.pos);
  $('chkLookup').disabled = !state.checkInput.length;
  $('chkExport').disabled = !state.check.length;
  $('chkApply').disabled = !state.check.some((r) => r.apply);
  $('addFailed').disabled = !state.add.some((r) => ADD_FAILED.includes(r.status));
  $('chkFailed').disabled = !state.check.some((r) => r.status === 'NO DATA' || r.applied === false || !r.posName);
  $('lblFailed').disabled = !(state.labels || []).some((r) => r.status === 'failed');
}

(async function init() {
  await loadAll();
  fillSettings();
  if (state.catalogue.length) $('chkScanInfo').textContent = state.catalogue.length + ' items from last scan';
  if (state.checkInput.length) $('chkFileInfo').textContent = state.checkInput.length + ' items loaded';
  renderAdd(); renderCheck(); refreshButtons();
  loadTkOpts(); renderTickets(); renderBuy(); renderInvoices();
  log('Ready. Keep PosPort Back Office logged in, in this Chrome window.');
  // carry on with items that were still waiting when the bot was closed or reloaded
  const left = state.add.filter((r) => r.status === 'waiting' || r.looking).length;
  if (left) { state.add.forEach((r) => { if (r.looking) { r.looking = false; r.status = 'waiting'; } }); log('Carrying on: ' + left + ' items still to look up.'); startLookup(); }
})();
