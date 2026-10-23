// ================= Offers: deals built from your Back Office items, found by name =================
// "Any 2 × 1.25 L (Coke, Sprite, Solo, Fanta) for $7" or a meal deal (these items together for $X).
let offers = [];
let ofPicked = [];               // Back Office items ticked for the offer being made
let ofEditing = null;            // id of the offer being changed

async function loadOffers() {
  const d = await chrome.storage.local.get('offers');
  offers = Array.isArray(d.offers) ? d.offers : [];
  renderOffers(); renderPicked();
}
const saveOffers = () => chrome.storage.local.set({ offers });

// every word you type must be in the name ("1.25 coke" finds "Coke Zero 1.25L")
function ofMatches(q) {
  const words = String(q || '').toLowerCase().replace(/&/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const flat = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');
  return state.catalogue.filter((c) => { const n = flat(c.name) + ' ' + (c.barcode || ''); return words.every((w) => n.includes(w)); })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
const itemId = (c) => String(c.id || c.barcode || c.name);
function renderResults() {
  const t = $('ofResults');
  if (!state.catalogue.length) { t.innerHTML = '<tbody><tr><td class="muted">The bot has not read your Back Office items yet – press ↻ Re-check PosPort in Items &amp; prices.</td></tr></tbody>'; return; }
  const q = $('ofSearch').value.trim();
  if (!q) { t.innerHTML = '<tbody><tr><td class="muted">Start typing to see your items (' + state.catalogue.length + ' in the Back Office).</td></tr></tbody>'; return; }
  const list = ofMatches(q);
  const picked = new Set(ofPicked.map(itemId));
  const allOn = list.length && list.slice(0, 300).every((c) => picked.has(itemId(c)));
  t.innerHTML = '<thead><tr><th><input type="checkbox" id="ofAll" title="Tick all shown"' + (allOn ? ' checked' : '') + '></th><th>' + list.length + ' items</th><th class="num">Price</th><th>Barcode</th></tr></thead><tbody>' +
    list.slice(0, 300).map((c, i) => '<tr data-i="' + i + '"><td><input type="checkbox" class="of-pick"' + (picked.has(itemId(c)) ? ' checked' : '') + '></td><td>' + esc(c.name) +
      '</td><td class="num">' + m(c.price) + '</td><td class="small-note">' + esc(c.barcode || '') + '</td></tr>').join('') +
    (list.length > 300 ? '<tr><td colspan="4" class="muted">… type more to narrow it down</td></tr>' : '') +
    (!list.length ? '<tr><td colspan="4" class="muted">No Back Office item has all of those words.</td></tr>' : '') + '</tbody>';
  t._list = list;
}
let ofTimer = null;
$('ofSearch').addEventListener('input', () => { clearTimeout(ofTimer); ofTimer = setTimeout(renderResults, 120); });
$('ofClear').addEventListener('click', () => { $('ofSearch').value = ''; renderResults(); $('ofSearch').focus(); });
$('ofResults').addEventListener('change', (e) => {
  const list = $('ofResults')._list || [];
  if (e.target.id === 'ofAll') {
    list.slice(0, 300).forEach((c) => { const has = ofPicked.some((p) => itemId(p) === itemId(c)); if (e.target.checked && !has) ofPicked.push(c); if (!e.target.checked && has) ofPicked = ofPicked.filter((p) => itemId(p) !== itemId(c)); });
  } else if (e.target.classList.contains('of-pick')) {
    const c = list[Number(e.target.closest('tr').dataset.i)];
    if (!c) return;
    if (e.target.checked) { if (!ofPicked.some((p) => itemId(p) === itemId(c))) ofPicked.push(c); } else ofPicked = ofPicked.filter((p) => itemId(p) !== itemId(c));
  } else return;
  renderPicked(); renderResults();
});

// the words all ticked items share, for the offer name ("Coke 1.25L", "Sprite 1.25L" -> "1.25L")
function commonWords(items) {
  const sets = items.map((c) => new Set(String(c.name).toLowerCase().split(/\s+/)));
  if (!sets.length) return '';
  const first = String(items[0].name).split(/\s+/);
  return first.filter((w) => sets.every((s) => s.has(w.toLowerCase()))).join(' ');
}
function suggestName() {
  if (!ofPicked.length) return '';
  const price = Number($('ofPrice').value);
  const p = price > 0 ? ' for $' + price.toFixed(2).replace(/\.00$/, '') : '';
  if ($('ofType').value === 'set') return ofPicked.map((c) => c.name).join(' + ').slice(0, 70) + p;
  const common = commonWords(ofPicked) || ofPicked.slice(0, 3).map((c) => String(c.name).split(' ')[0]).join('/');
  return 'Any ' + (Number($('ofQty').value) || 2) + ' ' + common + p;
}
function dealMaths() {
  const qty = Math.max(2, Number($('ofQty').value) || 2), price = Number($('ofPrice').value) || 0;
  const prices = ofPicked.map((c) => Number(c.price) || 0).filter((x) => x > 0);
  if (!prices.length) return { normalLo: 0, normalHi: 0 };
  if ($('ofType').value === 'set') { const n = prices.reduce((a, b) => a + b, 0); return { normalLo: n, normalHi: n, price }; }
  return { normalLo: Math.min(...prices) * qty, normalHi: Math.max(...prices) * qty, price, qty };
}
function renderPicked() {
  $('ofQtyWrap').classList.toggle('hidden', $('ofType').value === 'set');
  $('ofPicked').innerHTML = ofPicked.length ? ofPicked.map((c, i) => '<span class="chip" data-i="' + i + '">' + esc(c.name) + ' ' + m(c.price) + ' <button class="of-un" title="Take out">✕</button></span>').join('')
    : '<span class="muted small-note">No items ticked yet.</span>';
  const d = dealMaths();
  const fmt = (lo, hi) => (Math.abs(hi - lo) < 0.005 ? m(lo) : m(lo) + '–' + m(hi));
  $('ofSave').textContent = d.normalHi ? 'normally ' + fmt(d.normalLo, d.normalHi) + (d.price ? ' → customer saves ' + fmt(Math.max(0, d.normalLo - d.price), Math.max(0, d.normalHi - d.price)) + (d.price > d.normalLo ? ' (careful: the deal costs more than buying the cheapest ones)' : '') : '') : '';
  if (!$('ofName').dataset.edited) $('ofName').value = suggestName();
}
$('ofPicked').addEventListener('click', (e) => { if (!e.target.classList.contains('of-un')) return; ofPicked.splice(Number(e.target.closest('.chip').dataset.i), 1); renderPicked(); renderResults(); });
['ofType', 'ofQty', 'ofPrice'].forEach((id) => $(id).addEventListener('input', renderPicked));
$('ofType').addEventListener('change', renderPicked);
$('ofName').addEventListener('input', () => { $('ofName').dataset.edited = $('ofName').value ? '1' : ''; });
function resetOffer() { ofPicked = []; ofEditing = null; $('ofPrice').value = ''; $('ofQty').value = 2; $('ofType').value = 'any'; $('ofName').value = ''; delete $('ofName').dataset.edited; $('ofAdd').textContent = 'Save offer'; renderPicked(); renderResults(); }
$('ofReset').addEventListener('click', resetOffer);
$('ofAdd').addEventListener('click', () => {
  const type = $('ofType').value, qty = Math.max(2, Number($('ofQty').value) || 2), price = Number($('ofPrice').value);
  if (ofPicked.length < (type === 'set' ? 2 : 1)) { log(type === 'set' ? 'Tick at least two items for a meal deal.' : 'Tick the items that count for this offer.', 'err'); return; }
  if (!(price > 0)) { log('Type the deal price.', 'err'); return; }
  const o = { id: ofEditing || ('of' + Date.now().toString(36)), name: ($('ofName').value || suggestName()).trim(), type, qty: type === 'set' ? ofPicked.length : qty, price,
    category: $('ofCat').value || '',
    items: ofPicked.map((c) => ({ id: c.id || '', name: c.name, price: c.price, barcode: c.barcode || '' })), createdAt: Date.now(), inPosPort: false };
  offers = offers.filter((x) => x.id !== o.id).concat([o]);
  saveOffers(); renderOffers(); log('Offer saved: ' + o.name, 'ok'); resetOffer();
});

function renderOffers() {
  $('ofTable').innerHTML = '<thead><tr><th>Offer</th><th>Deal</th><th>Items</th><th class="num">Normally</th><th>Made</th><th></th></tr></thead><tbody>' +
    (offers.length ? offers.map((o, i) => {
      const prices = o.items.map((x) => Number(x.price) || 0);
      const normal = o.type === 'set' ? m(prices.reduce((a, b) => a + b, 0)) : m(Math.min(...prices) * o.qty) + (Math.min(...prices) !== Math.max(...prices) ? '–' + m(Math.max(...prices) * o.qty) : '');
      return '<tr data-i="' + i + '"><td><b>' + esc(o.name) + '</b></td><td>' + (o.type === 'set' ? 'all together' : 'any ' + o.qty) + ' for ' + m(o.price) + '</td><td class="small-note">' +
        o.items.map((x) => esc(x.name)).join('<br>') + '</td><td class="num">' + normal + '</td><td class="small-note">' + esc(fmtTime(o.createdAt)) + '</td>' +
        '<td><button class="btn small primary-outline of-pos" title="Fill PosPort\'s Create Combo page with this offer (you press Save)">Put into PosPort</button>' + (o.inPosPort ? '<span class="sub">filled ' + esc(fmtTime(o.inPosPort)) + '</span>' : '') +
        ' <button class="btn small of-edit">Change</button> <button class="btn small of-del">✕</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">No offers yet.</td></tr>') + '</tbody>';
}
$('ofTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]'); if (!tr) return;
  const o = offers[Number(tr.dataset.i)];
  if (e.target.classList.contains('of-del')) { if (confirm('Delete the offer "' + o.name + '"? (Only in the bot – nothing in PosPort changes.)')) { offers = offers.filter((x) => x !== o); saveOffers(); renderOffers(); } }
  if (e.target.classList.contains('of-pos')) { offerToPosPort(o); return; }
  if (e.target.classList.contains('of-edit')) {
    ofEditing = o.id; ofPicked = o.items.map((x) => Object.assign({}, x));
    if (o.category) $('ofCat').value = o.category;
    $('ofType').value = o.type; $('ofQty').value = o.type === 'set' ? 2 : o.qty; $('ofPrice').value = o.price; $('ofName').value = o.name; $('ofName').dataset.edited = '1';
    $('ofAdd').textContent = 'Save changes'; renderPicked(); renderResults(); window.scrollTo(0, 0);
  }
});
$('ofExport').addEventListener('click', () => {
  if (!offers.length) { log('No offers yet.', 'err'); return; }
  const rows = [];
  offers.forEach((o) => o.items.forEach((x, k) => rows.push({ Offer: k ? '' : o.name, Deal: k ? '' : (o.type === 'set' ? 'all together' : 'any ' + o.qty) + ' for $' + o.price.toFixed(2), Item: x.name, Barcode: x.barcode, 'Normal price': x.price })));
  writeSheet(rows, 'offers-' + saveStamp() + '.xlsx', 'Offers');
});
$('ofTickets').addEventListener('click', () => {
  if (!offers.length) { log('No offers yet.', 'err'); return; }
  addTickets(offers.map((o) => ({ full: o.name, name: (o.type === 'set' ? o.name.replace(/ for \$[\d.]+$/, '') : 'ANY ' + o.qty + ' ' + (commonWords(o.items) || '')).toUpperCase().slice(0, 40), price: o.price, barcode: '', qty: 1 })));
  showTab('tickets');
});

function fillOfferCats() {
  const cur = $('ofCat').value;
  $('ofCat').innerHTML = categories.map((c) => '<option>' + esc(c) + '</option>').join('');
  $('ofCat').value = cur || (categories.find((c) => /^drinks$/i.test(c)) || categories[0] || '');
}

// any N of the items -> one slot "exactly N, multiples allowed"; a meal deal -> one slot per item, exactly 1 each
function comboOf(o) {
  return {
    name: o.name, category: o.category || $('ofCat').value, price: o.price,
    slots: o.type === 'set' ? o.items.map((x) => ({ qty: 1, multiples: false, items: [x.name] })) : [{ qty: o.qty, multiples: true, items: o.items.map((x) => x.name) }],
  };
}
async function offerToPosPort(o) {
  const combo = comboOf(o);
  if (!combo.category) { log('Pick the PosPort category for this offer first (Change › PosPort category).', 'err'); return; }
  return posJob('filling the combo "' + o.name + '"', async () => {
    log('Opening Create Combo in PosPort for "' + o.name + '"…');
    const tabId = await posTab();
    await chrome.tabs.update(tabId, { url: POS + '/catalog/combo/new' });
    await sleep(600); await waitComplete(tabId, 30000); await sleep(1500);
    const r = await exec(tabId, ['core/combo.js'], async (c) => { try { return await CSB_COMBO.fillCombo(c); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }, [combo]);
    if (!r || !r.ok) { log('Combo "' + o.name + '": ' + ((r && r.error) || 'no answer from the PosPort tab') + ' – nothing was saved.', 'err'); return; }
    o.inPosPort = Date.now(); saveOffers(); renderOffers();
    const miss = (r.missing || []).filter((x) => !/^\(/.test(x) && !/^category/.test(x));
    log('Combo "' + o.name + '" is filled in on the PosPort tab (' + (r.summary || []).join('; ') + '). Check it and press Save there.' +
      (miss.length ? ' Not added – not in PosPort\'s combo list, usually because the item has no category in PosPort: ' + miss.join(', ') + '. Give them a category and add them in that slot.' : '') +
      ((r.missing || []).filter((x) => /^\(|^category/.test(x)).length ? ' Also: ' + r.missing.filter((x) => /^\(|^category/.test(x)).join('; ') : ''), miss.length ? 'err' : 'ok');
    chrome.tabs.update(tabId, { active: true });
  });
}

fillOfferCats();
loadOffers();
