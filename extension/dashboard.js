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
const state = { add: [], check: [], checkInput: [], catalogue: [] };
let busy = false;
let stopRequested = false;

// ---------------- small utilities ----------------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m = (n) => (n === null || n === undefined || n === '' || isNaN(n) ? '' : '$' + Number(n).toFixed(2));
const today = () => new Date().toISOString().slice(0, 10);

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
  const d = await chrome.storage.local.get(['settings', 'categories', 'add', 'check', 'checkInput', 'catalogue']);
  if (d.settings) S = Object.assign({}, S, d.settings);
  if (d.categories && d.categories.length) categories = d.categories;
  ['add', 'check', 'checkInput', 'catalogue'].forEach((k) => { if (Array.isArray(d[k])) state[k] = d[k]; });
}
function saveState() {
  return chrome.storage.local.set({ add: state.add, check: state.check, checkInput: state.checkInput, catalogue: state.catalogue, categories });
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
async function storeCall(kind, fn, args) {
  const cfg = STORES[kind];
  for (let attempt = 0; attempt < 3; attempt++) {
    const tabId = await findOrOpen(cfg.match, cfg.home);
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
      await chrome.tabs.update(tabId, { active: true });
      const go = await pause(cfg.label + ' is showing a check page (or blocked the request). Solve it in that tab, then press Continue.');
      if (!go) return Object.assign(res, { error: 'Stopped' });
      continue;
    }
    return res || { found: false, error: 'No answer' };
  }
  return { found: false, error: cfg.label + ' kept blocking requests' };
}

async function lookupPrices(barcode, nameHint) {
  const ww = await storeCall('ww', 'wwLookup', [barcode, nameHint || '']);
  await sleep(S.delayMs);
  const colesHint = ww && ww.found ? ww.name : nameHint;
  const coles = await storeCall('coles', 'colesLookup', [barcode, colesHint || '']);
  await sleep(S.delayMs);
  const highest = R.highestPrice(ww && ww.found ? ww.regular : null, coles && coles.found ? coles.regular : null);
  return { ww, coles, highest };
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
  const map = { waiting: 'idle', ready: 'ok', check: 'warn', exists: 'warn', 'not found': 'bad', created: 'ok', filled: 'ok', error: 'bad' };
  return '<span class="pill ' + (map[r.status] || 'idle') + '" title="' + esc(r.note || '') + '">' + esc(r.status) + '</span>';
}

function renderAdd() {
  const t = $('addTable');
  if (!state.add.length) { t.innerHTML = ''; $('addSummary').textContent = 'No items loaded.'; return; }
  const catOpts = (sel) => ['<option value="">— choose —</option>'].concat(categories.map((c) => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>')).join('');
  t.innerHTML = '<thead><tr><th><input type="checkbox" id="addAll" checked></th><th>Barcode</th><th>Woolworths</th><th>Coles</th><th class="num">Highest</th><th class="num">Our price</th><th>Label name</th><th>Category</th><th>Status</th></tr></thead><tbody>' +
    state.add.map((r, i) => {
      const len = (r.name || '').length;
      return '<tr data-i="' + i + '">' +
        '<td><input type="checkbox" class="use" ' + (r.use !== false ? 'checked' : '') + '></td>' +
        '<td>' + esc(r.barcode) + (r.inName ? '<span class="sub">' + esc(r.inName) + '</span>' : '') + '</td>' +
        '<td>' + storeCell(r.ww) + '</td><td>' + storeCell(r.coles) + '</td>' +
        '<td class="num">' + m(r.highest) + '</td>' +
        '<td class="num"><input type="number" step="0.01" class="price" value="' + (r.price !== null && r.price !== undefined ? Number(r.price).toFixed(2) : '') + '"></td>' +
        '<td><input type="text" class="name" value="' + esc(r.name || '') + '"><span class="count' + (len > S.nameMaxLength ? ' over' : '') + '">' + len + '/' + S.nameMaxLength + '</span></td>' +
        '<td><select class="cat">' + catOpts(r.category) + '</select></td>' +
        '<td>' + addStatusPill(r) + '</td></tr>';
    }).join('') + '</tbody>';
  const done = state.add.filter((r) => r.status !== 'waiting').length;
  const ready = state.add.filter((r) => r.status === 'ready' || r.status === 'check').length;
  const nf = state.add.filter((r) => r.status === 'not found').length;
  $('addSummary').textContent = state.add.length + ' barcodes · ' + done + ' looked up · ' + ready + ' ready · ' + nf + ' not found (enter those by hand)';
  refreshButtons();
}

$('addTable').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.add[+tr.dataset.i];
  if (e.target.classList.contains('name')) {
    r.name = e.target.value;
    const c = tr.querySelector('.count');
    c.textContent = r.name.length + '/' + S.nameMaxLength;
    c.classList.toggle('over', r.name.length > S.nameMaxLength);
  }
  if (e.target.classList.contains('price')) r.price = R.parseMoney(e.target.value);
  saveState();
});
$('addTable').addEventListener('change', (e) => {
  if (e.target.id === 'addAll') { state.add.forEach((r) => { r.use = e.target.checked; }); renderAdd(); saveState(); return; }
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = state.add[+tr.dataset.i];
  if (e.target.classList.contains('cat')) r.category = e.target.value;
  if (e.target.classList.contains('use')) r.use = e.target.checked;
  if ((r.status === 'not found' || (r.status === 'exists' && r.use)) && r.name && r.price && r.category) { r.status = 'ready'; renderAdd(); }
  saveState();
});

$('addFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rows = R.parseInputRows(await readSheet(f));
  state.add = rows.map((x) => ({ barcode: x.barcode, inName: x.name, name: x.name ? R.shortName(x.name, '', S.nameMaxLength) : '', category: x.category, overridePrice: x.price, price: x.price, status: 'waiting', use: true }));
  $('addFileInfo').textContent = f.name + ' — ' + rows.length + ' items';
  log('Loaded ' + rows.length + ' barcodes from ' + f.name);
  e.target.value = '';
  renderAdd(); saveState();
});

$('addLookup').addEventListener('click', async () => {
  setBusy(true);
  try {
    let n = 0;
    for (const r of state.add) {
      if (stopRequested) break;
      if (r.status !== 'waiting' && r.status !== 'error' && r.status !== 'not found') continue;
      n++;
      log('Looking up ' + (r.barcode || r.inName) + ' (' + n + ')');
      const res = await lookupPrices(r.barcode, r.inName);
      r.ww = res.ww; r.coles = res.coles; r.highest = res.highest;
      const src = res.ww && res.ww.found ? res.ww : (res.coles && res.coles.found ? res.coles : null);
      if (src && !r.inName) r.name = R.shortName(src.name, src.size, S.nameMaxLength);
      else if (src && !r.name) r.name = R.shortName(src.name, src.size, S.nameMaxLength);
      if (!r.category) r.category = R.guessCategory(src ? src.name : r.inName, res.ww && res.ww.dept, categories);
      r.price = r.overridePrice || R.newItemPrice(res.highest, S);
      const unsure = [res.ww, res.coles].some((s) => s && s.found && s.match && s.match !== 'barcode');
      if (!res.highest) { r.status = 'not found'; r.note = 'Not found at Woolworths or Coles'; }
      else { r.status = unsure ? 'check' : 'ready'; r.note = unsure ? 'Matched by name – please check it is the same product' : ''; }
      if (r.barcode && state.catalogue.some((c) => c.barcode && R.sameBarcode(c.barcode, r.barcode))) {
        r.status = 'exists'; r.note = 'This barcode is already in PosPort (from the last scan). Change status by editing and ticking again if you still want it.';
        r.use = false;
      }
      renderAdd(); saveState();
    }
    log('Price lookup finished.', 'ok');
  } finally { setBusy(false); }
});

$('addCats').addEventListener('click', async () => {
  setBusy(true);
  try {
    if (!(await posGo('/catalog/items/bulk', 'bulk'))) return;
    const res = await pos('bulkGetCategories');
    if (res && res.ok && res.categories.length) {
      categories = res.categories;
      if (!categories.includes('Misc')) categories.push('Misc');
      log('Loaded ' + categories.length + ' categories from PosPort.', 'ok');
      saveState(); renderAdd();
    } else log('Could not read categories: ' + (res && res.error), 'err');
  } finally { setBusy(false); }
});

$('addCreate').addEventListener('click', async () => {
  const todo = state.add.filter((r) => r.use !== false && (r.status === 'ready' || r.status === 'check') && r.name && r.price > 0 && r.category);
  const skipped = state.add.filter((r) => r.use !== false && !todo.includes(r) && r.status !== 'created' && r.status !== 'filled').length;
  if (!todo.length) { log('Nothing ready to create (need name, price and category).', 'err'); return; }
  const long = todo.filter((r) => r.name.length > S.nameMaxLength).length;
  if (!confirm('Create ' + todo.length + ' items in PosPort?' + (skipped ? '\n' + skipped + ' ticked rows are missing a name/price/category and will be skipped.' : '') + (long ? '\n' + long + ' names are longer than ' + S.nameMaxLength + ' and may be cut off on labels.' : ''))) return;
  setBusy(true);
  try {
    for (let start = 0; start < todo.length; start += S.batchSize) {
      if (stopRequested) break;
      const batch = todo.slice(start, start + S.batchSize);
      log('Opening Bulk Create for items ' + (start + 1) + '–' + (start + batch.length));
      if (!(await posGo('/catalog/items/bulk', 'bulk'))) { log('Bulk Create page did not open.', 'err'); break; }
      const need = batch.length + (S.extraBlankRow ? 1 : 0);
      const rr = await pos('ensureRows', need, S.delayMs);
      if (!rr || !rr.ok) { log('Could not add rows: ' + (rr && rr.error), 'err'); break; }
      let failed = false;
      for (let i = 0; i < batch.length; i++) {
        if (stopRequested) { failed = true; break; }
        const it = batch[i];
        const res = await pos('fillBulkRow', i, { name: it.name, barcode: it.barcode, price: it.price, category: it.category }, S.delayMs);
        if (!res || !res.ok) {
          it.status = 'error'; it.note = res && res.error;
          log('Row ' + (i + 1) + ' (' + it.name + '): ' + (res && res.error), 'err');
          failed = true;
          break;
        }
        it.status = 'filled';
        renderAdd();
        await sleep(S.delayMs / 2);
      }
      if (failed) {
        await pause('Stopped at a problem row (see the log). Fix it in the PosPort tab if you like, then press Continue to go on or Stop.');
        if (stopRequested) break;
      }
      const tabId = await posTab();
      if (S.autoCreate && !failed) {
        const c = await pos('clickCreate');
        log(c && c.ok ? 'Pressed "' + c.clicked + '"' : 'Create button: ' + (c && c.error), c && c.ok ? 'ok' : 'err');
        await sleep(2500);
        const st = await pos('toasts');
        if (Array.isArray(st) && st.length) log('PosPort says: ' + st.join(' | '));
      } else {
        await chrome.tabs.update(tabId, { active: true });
        const go = await pause('Batch filled. Check the rows in the PosPort tab and press "Create" there. Then come back and press Continue.');
        if (!go) break;
      }
      batch.forEach((it) => { if (it.status === 'filled') it.status = 'created'; });
      renderAdd(); saveState();
    }
    log('Create run finished. Download the comparison Excel to keep a record.', 'ok');
  } finally { setBusy(false); }
});

$('addExport').addEventListener('click', () => {
  const rows = state.add.map((r) => ({
    Barcode: r.barcode,
    'Label name': r.name || '',
    Category: r.category || '',
    'Woolworths product': r.ww && r.ww.found ? r.ww.name : '',
    'Woolworths normal $': r.ww && r.ww.found ? r.ww.regular : '',
    'Woolworths special $': r.ww && r.ww.found && r.ww.onSpecial ? r.ww.now : '',
    'Coles product': r.coles && r.coles.found ? r.coles.name : '',
    'Coles normal $': r.coles && r.coles.found ? r.coles.regular : '',
    'Coles special $': r.coles && r.coles.found && r.coles.onSpecial ? r.coles.now : '',
    'Highest $': r.highest || '',
    'Our price $': r.price || '',
    'Markup $': r.price && r.highest ? R.round2(r.price - r.highest) : '',
    Status: r.status,
    Note: r.note || '',
  }));
  writeSheet(rows, 'new-items-price-comparison-' + today() + '.xlsx', 'New items');
  log('Comparison Excel downloaded.', 'ok');
});

$('addToLabels').addEventListener('click', () => {
  const names = state.add.filter((r) => r.status === 'created' || r.status === 'filled').map((r) => r.name);
  const list = names.length ? names : state.add.filter((r) => r.name).map((r) => r.name);
  $('lblNames').value = list.join('\n');
  showTab('labels');
});

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
  try {
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
    const withBc = state.catalogue.filter((c) => c.barcode).length;
    $('chkScanInfo').textContent = state.catalogue.length + ' items · ' + withBc + ' with barcode';
    log('Scanned ' + state.catalogue.length + ' PosPort items (' + withBc + ' with barcodes).', 'ok');
    saveState();
  } finally { setBusy(false); }
});

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
    const best = R.bestMatch(inp.name, state.catalogue, (c) => c.name);
    if (best.item && best.score >= 0.8) return best.item;
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
      const pm = matchCatalogue(inp);
      const ours = inp.currentPrice !== null && inp.currentPrice !== undefined ? inp.currentPrice : (pm ? pm.price : null);
      log('Comparing ' + (pm ? pm.name : key) + ' (' + n + ')');
      const res = await lookupPrices(inp.barcode, pm ? pm.name : inp.name);
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

$('chkApply').addEventListener('click', async () => {
  const todo = state.check.filter((r) => r.apply && r.posName && r.newPrice > 0);
  if (!todo.length) { log('Tick the rows to update and give them a new price.', 'err'); return; }
  if (!confirm('Change the price of ' + todo.length + ' items in PosPort?\n\n' + todo.slice(0, 15).map((r) => r.posName + ': ' + m(r.ours) + ' → ' + m(r.newPrice)).join('\n') + (todo.length > 15 ? '\n…' : ''))) return;
  setBusy(true);
  try {
    for (const r of todo) {
      if (stopRequested) break;
      log('Updating ' + r.posName + ' → ' + m(r.newPrice));
      let res;
      if (!(await posGo('/catalog/items', 'items'))) { res = { ok: false, error: 'Items page did not open' }; }
      else {
        const s = await pos('searchList', r.posName, S.delayMs);
        if (!s || !s.ok) res = s;
        else {
          const o = await pos('openItem', r.posName, S.delayMs);
          if (!o || !o.ok) res = o;
          else {
            const tabId = await posTab();
            await sleep(800); await waitComplete(tabId); await sleep(800);
            res = await pos('setEditPrice', r.newPrice, S.delayMs);
          }
        }
      }
      r.applied = !!(res && res.ok);
      r.note = res && res.ok ? 'was ' + (res.old || r.ours) : (res && res.error) || 'unknown error';
      if (r.applied) { r.ours = r.newPrice; r.apply = false; }
      log(r.posName + ': ' + (r.applied ? 'updated' : 'FAILED – ' + r.note), r.applied ? 'ok' : 'err');
      renderCheck(); saveState();
      if (!r.applied) {
        const go = await pause('Could not update "' + r.posName + '": ' + r.note + '. Continue with the next item?');
        if (!go) break;
      }
      await sleep(S.delayMs);
    }
  } finally { setBusy(false); }
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
$('lblClear').addEventListener('click', () => { $('lblNames').value = ''; $('lblLog').innerHTML = ''; });

$('lblRun').addEventListener('click', async () => {
  const names = $('lblNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  $('lblLog').innerHTML = '';
  setBusy(true);
  try {
    // Fast path: if we know every item's PosPort id, open the label page directly.
    const cap = await pos('captured');
    const byName = new Map(((cap && cap.items) || []).map((c) => [c.name.toLowerCase(), c.id]));
    const ids = names.map((n) => byName.get(n.toLowerCase()));
    if (ids.every(Boolean)) {
      const tabId = await posTab();
      await chrome.tabs.update(tabId, { url: POS + '/print/labels?' + ids.map((id) => 'item=' + encodeURIComponent(id)).join('&'), active: true });
      lblLog('Opened Print labels with all ' + names.length + ' items. Choose the label stock and press Print.', 'ok');
      return;
    }
    if (!(await posGo('/catalog/items', 'items'))) { lblLog('Items page did not open.', 'err'); return; }
    let ticked = 0;
    for (const n of names) {
      if (stopRequested) break;
      const s = await pos('searchList', n, S.delayMs);
      if (!s || !s.ok) { lblLog('✗ ' + n + ': ' + (s && s.error), 'err'); continue; }
      const t = await pos('tickRow', n);
      if (t && t.ok) { ticked++; lblLog('✓ ' + n, 'ok'); } else lblLog('✗ ' + n + ': ' + (t && t.error), 'err');
      await sleep(S.delayMs / 2);
    }
    if (!ticked) { lblLog('Nothing was ticked.', 'err'); return; }
    const p = await pos('clickPrintLabels');
    const tabId = await posTab();
    await chrome.tabs.update(tabId, { active: true });
    lblLog(p && p.ok ? 'Pressed Print labels (' + ticked + ' items). Choose the label stock and press Print.' : 'Ticked ' + ticked + ' items but: ' + (p && p.error), p && p.ok ? 'ok' : 'err');
  } finally { setBusy(false); }
});

// =====================================================================
// SETTINGS
// =====================================================================
const NUM_KEYS = ['markup', 'flagLow', 'flagHigh', 'nameMaxLength', 'delayMs', 'batchSize'];
function fillSettings() {
  NUM_KEYS.forEach((k) => { $('s_' + k).value = S[k]; });
  $('s_extraBlankRow').checked = !!S.extraBlankRow;
  $('s_autoCreate').checked = !!S.autoCreate;
  $('s_selectors').value = S.selectors && Object.keys(S.selectors).length ? JSON.stringify(S.selectors, null, 2) : '';
  $('lowLbl').textContent = m(S.flagLow);
  $('highLbl').textContent = m(S.flagHigh);
}
$('sSave').addEventListener('click', async () => {
  NUM_KEYS.forEach((k) => { const v = parseFloat($('s_' + k).value); if (isFinite(v)) S[k] = v; });
  S.extraBlankRow = $('s_extraBlankRow').checked;
  S.autoCreate = $('s_autoCreate').checked;
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
    if (info && info.page === 'bulk') { const b = await pos('bulkStatus'); extra = b.rows + ' rows, ' + b.missingPrice + ' without a price box, button: ' + b.createLabel; }
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
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function refreshButtons() {
  if (busy) return;
  $('addLookup').disabled = !state.add.some((r) => r.status === 'waiting' || r.status === 'error' || r.status === 'not found');
  $('addCreate').disabled = !state.add.some((r) => r.status === 'ready' || r.status === 'check' || r.status === 'error');
  $('addExport').disabled = !state.add.some((r) => r.status !== 'waiting');
  $('addToLabels').disabled = !state.add.some((r) => r.name);
  $('chkLookup').disabled = !state.checkInput.length;
  $('chkExport').disabled = !state.check.length;
  $('chkApply').disabled = !state.check.some((r) => r.apply);
}

(async function init() {
  await loadAll();
  fillSettings();
  if (state.catalogue.length) $('chkScanInfo').textContent = state.catalogue.length + ' items from last scan';
  if (state.checkInput.length) $('chkFileInfo').textContent = state.checkInput.length + ' items loaded';
  renderAdd(); renderCheck(); refreshButtons();
  log('Ready. Keep PosPort Back Office logged in, in this Chrome window.');
})();
